import * as path from "node:path";
import type { Context, ImageContent, Model } from "@oh-my-pi/pi-ai";
import { getBlobsDir, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { type BlobBackend, LocalBlobBackend } from "./broker";
import {
	contextHasImages,
	contextHasImageUrls,
	contextHasProviderFiles,
	decorateContextImages,
	inlineContextImages,
	supportsRemoteImageUrls,
} from "./context-images";
import { connectDaemonBlobBackend, type RenderCallbackHost } from "./daemon";
import type { BlobBrokerWorkerConfig } from "./protocol";
import { RENDER_CALLBACK_PATH, RENDER_CALLBACK_TOKEN_HEADER } from "./protocol";
import { ProviderFileCache } from "./provider-file-types";
import { type ProviderFileCredentialResolver, ProviderFileManager } from "./provider-files";
import type { BlobPublication } from "./publication";
import { BlobBrokerSavingsJournal, type BlobBrokerSavingsRecord, blobBrokerSavingsJournalPath } from "./savings";
import type { LazyBlobFetcher } from "./store";
import type { DestinationOptionValue } from "./uploader-runtime";

function contentHash(data: string, mimeType: string): string {
	return new Bun.CryptoHasher("sha256").update(mimeType).update("\n").update(data).digest("hex");
}

export class FallbackBlobBackend implements BlobBackend {
	readonly supportsLazy: boolean;

	constructor(readonly backends: readonly BlobBackend[]) {
		this.supportsLazy = backends.some(backend => backend.supportsLazy);
	}

	async ensureBlob(key: string, mimeType: string, getBytes: () => Uint8Array): Promise<BlobPublication | null> {
		let bytes: Uint8Array | undefined;
		for (const backend of this.backends) {
			try {
				const publication = await backend.ensureBlob(key, mimeType, () => {
					bytes ??= getBytes();
					return bytes;
				});
				if (publication) return publication;
			} catch (error) {
				logger.warn("blob-broker: backend publication failed; trying next backend", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return null;
	}

	async ensureLazy(key: string, mimeType: string, fetcher: LazyBlobFetcher): Promise<BlobPublication | null> {
		for (const backend of this.backends) {
			if (!backend.supportsLazy) continue;
			try {
				const publication = await backend.ensureLazy(key, mimeType, fetcher);
				if (publication) return publication;
			} catch (error) {
				logger.warn("blob-broker: lazy backend failed; trying next backend", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return null;
	}

	stop(): void {
		for (const backend of this.backends) backend.stop();
	}
}

export class ImageUrlService {
	#projectDir: string;
	#configs: readonly BlobBrokerWorkerConfig[];
	#backendPromises = new Map<string, Promise<BlobBackend | null>>();
	#quarantined = new Set<string>();

	#producers = new Map<string, LazyBlobFetcher>();

	#lazyKeyByUrl = new Map<string, string>();

	#publicationByUrl = new Map<string, BlobPublication>();

	#publicationSourceByUrl = new Map<string, { rangeStart: number; rangeEnd: number; hash: string }>();
	#callback: { port: number; token: string; server: Bun.Server<undefined> } | null | undefined;
	#daemonEnabled: boolean;
	#providerFiles: ProviderFileManager | undefined;
	#providerFilePosition: number;
	#savingsJournal: BlobBrokerSavingsJournal | undefined;

	constructor(
		projectDir: string,
		configs: readonly BlobBrokerWorkerConfig[],
		options?: {
			daemon?: boolean;
			providerFiles?: ProviderFileManager;
			providerFilePosition?: number;
			savingsJournal?: BlobBrokerSavingsJournal;
		},
	) {
		this.#projectDir = projectDir;
		this.#configs = configs;
		this.#daemonEnabled = options?.daemon ?? true;
		this.#providerFiles = options?.providerFiles;
		this.#providerFilePosition = options?.providerFilePosition ?? configs.length;
		this.#savingsJournal = options?.savingsJournal;
	}

	prewarm(): void {
		const position = Math.min(this.#providerFilePosition, this.#configs.length);
		const configs = position > 0 ? this.#configs.slice(0, position) : this.#configs.slice(position);
		const key = position > 0 ? `range:0:${position}` : `range:${position}:${this.#configs.length}`;
		if (configs.length > 0) void this.#ensureBackend(configs, key);
	}

	#ensureBackend(
		configs: readonly BlobBrokerWorkerConfig[] = this.#configs,
		key = "all",
	): Promise<BlobBackend | null> {
		let pending = this.#backendPromises.get(key);
		if (!pending) {
			pending = this.#resolveBackend(configs);
			this.#backendPromises.set(key, pending);
		}
		return pending;
	}

	async #resolveBackend(configs: readonly BlobBrokerWorkerConfig[]): Promise<BlobBackend | null> {
		const backends: BlobBackend[] = [];
		const daemonConfig = configs[0];
		const daemon =
			this.#daemonEnabled && daemonConfig === this.#configs[0]
				? await connectDaemonBlobBackend(this.#projectDir, daemonConfig, this.#callbackHost())
				: null;
		if (daemon) backends.push(daemon);
		for (const config of configs) {
			try {
				backends.push(new LocalBlobBackend(config));
			} catch (error) {
				logger.warn("blob-broker: backend unavailable; trying next backend", {
					destination: config.kind,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (backends.length === 0) return null;
		return backends.length === 1 ? backends[0] : new FallbackBlobBackend(backends);
	}

	#callbackHost(): RenderCallbackHost {
		return {
			ensure: async () => this.#ensureCallbackServer(),
			register: (key, fetcher) => {
				this.#producers.set(key, fetcher);
			},
		};
	}

	#ensureCallbackServer(): { port: number; token: string } | null {
		if (this.#callback !== undefined) return this.#callback;
		try {
			const token = crypto.randomUUID();
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: async request => {
					if (request.headers.get(RENDER_CALLBACK_TOKEN_HEADER) !== token) {
						return new Response(null, { status: 403 });
					}
					const pathname = new URL(request.url).pathname;
					if (!pathname.startsWith(RENDER_CALLBACK_PATH)) return new Response(null, { status: 404 });
					const key = decodeURIComponent(pathname.slice(RENDER_CALLBACK_PATH.length));
					const fetcher = this.#producers.get(key);
					const bytes = fetcher ? await fetcher() : null;
					if (!bytes) return new Response(null, { status: 404 });
					return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
				},
			});
			server.unref();
			const port = server.port;
			if (port === undefined) {
				server.stop(true);
				this.#callback = null;
				return null;
			}
			this.#callback = { port, token, server };
		} catch (error) {
			logger.warn("blob-broker: render callback server failed to start", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.#callback = null;
		}
		return this.#callback;
	}

	async decorateContext(context: Context, model: Model): Promise<Context> {
		if (!contextHasImages(context)) return context;
		const position = Math.min(this.#providerFilePosition, this.#configs.length);
		let decorated = context;
		if (position > 0) {
			decorated = await this.#decorateUrls(
				decorated,
				model,
				this.#configs.slice(0, position),
				`range:0:${position}`,
			);
		}
		if (this.#providerFiles) decorated = await this.#providerFiles.decorateContext(decorated, model);
		if (position < this.#configs.length) {
			decorated = await this.#decorateUrls(
				decorated,
				model,
				this.#configs.slice(position),
				`range:${position}:${this.#configs.length}`,
			);
		}
		await this.#recordSavings(context, decorated, model);
		return decorated;
	}

	async #recordSavings(source: Context, decorated: Context, model: Model): Promise<void> {
		if (!this.#savingsJournal || source === decorated) return;
		const sourceImages: ImageContent[] = [];
		const decoratedImages: ImageContent[] = [];
		for (const message of source.messages) {
			if (
				(message.role === "user" || message.role === "developer" || message.role === "toolResult") &&
				Array.isArray(message.content)
			) {
				for (const block of message.content) {
					if (block.type === "image") sourceImages.push(block);
				}
			}
		}
		for (const message of decorated.messages) {
			if (
				(message.role === "user" || message.role === "developer" || message.role === "toolResult") &&
				Array.isArray(message.content)
			) {
				for (const block of message.content) {
					if (block.type === "image") decoratedImages.push(block);
				}
			}
		}

		const counters = new Map<string, { imageCount: number; inlineBytes: number; referenceBytes: number }>();
		const count = Math.min(sourceImages.length, decoratedImages.length);
		for (let index = 0; index < count; index++) {
			const inline = sourceImages[index];
			const reference = decoratedImages[index];
			if (
				inline.data.length === 0 ||
				inline.url ||
				inline.providerFile ||
				(!reference.url && !reference.providerFile)
			) {
				continue;
			}
			const destination = reference.providerFile
				? "provider-files"
				: reference.url
					? this.#publicationByUrl.get(reference.url)?.destination
					: undefined;
			if (!destination) continue;
			const inlineBytes = Buffer.byteLength(inline.data, "utf8");
			const referenceBytes = Buffer.byteLength(
				reference.providerFile ? JSON.stringify(reference.providerFile) : (reference.url ?? ""),
				"utf8",
			);
			const current = counters.get(destination) ?? { imageCount: 0, inlineBytes: 0, referenceBytes: 0 };
			current.imageCount++;
			current.inlineBytes += inlineBytes;
			current.referenceBytes += referenceBytes;
			counters.set(destination, current);
		}
		if (counters.size === 0) return;
		const timestamp = Date.now();
		const records: BlobBrokerSavingsRecord[] = [];
		for (const [destination, counter] of counters) {
			records.push({
				timestamp,
				provider: model.provider,
				model: model.id,
				destination,
				...counter,
				savedBytes: counter.inlineBytes - counter.referenceBytes,
			});
		}
		await this.#savingsJournal.append(records);
	}

	async #decorateUrls(
		context: Context,
		model: Model,
		configs: readonly BlobBrokerWorkerConfig[],
		backendKey: string,
	): Promise<Context> {
		if (configs.length === 0 || this.#quarantined.has(model.provider) || !supportsRemoteImageUrls(model)) {
			return context;
		}
		const backend = await this.#ensureBackend(configs, backendKey);
		if (!backend) return context;

		const byHash = new Map<string, ImageContent[]>();
		for (const message of context.messages) {
			if (message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") continue;
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type !== "image" || block.url || block.providerFile || block.data.length === 0) continue;
				const hash = contentHash(block.data, block.mimeType);
				const group = byHash.get(hash);
				if (group) group.push(block);
				else byHash.set(hash, [block]);
			}
		}
		if (byHash.size === 0) return context;

		const urlByBlock = new Map<ImageContent, string>();
		await Promise.all(
			[...byHash].map(async ([hash, blocks]) => {
				let publication: BlobPublication | null;
				try {
					publication = await backend.ensureBlob(
						hash,
						blocks[0].mimeType,
						() => new Uint8Array(Buffer.from(blocks[0].data, "base64")),
					);
				} catch (error) {
					logger.warn("blob-broker: backend publication failed", {
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
				if (!publication) return;
				this.#publicationByUrl.set(publication.url, publication);
				const rangeStart = this.#configs.indexOf(configs[0]);
				this.#publicationSourceByUrl.set(publication.url, {
					rangeStart: rangeStart < 0 ? 0 : rangeStart,
					rangeEnd: rangeStart < 0 ? this.#configs.length : rangeStart + configs.length,
					hash,
				});
				for (const block of blocks) urlByBlock.set(block, publication.url);
			}),
		);
		return urlByBlock.size === 0 ? context : decorateContextImages(context, block => urlByBlock.get(block));
	}

	inlineContext(context: Context): Promise<Context> {
		return inlineContextImages(context, async block => {
			if (block.data.length > 0) return block.data;
			const key = block.url ? this.#lazyKeyByUrl.get(block.url) : undefined;
			const fetcher = key ? this.#producers.get(key) : undefined;
			const bytes = fetcher ? await fetcher() : null;
			return bytes ? Buffer.from(bytes).toString("base64") : null;
		});
	}

	#imageUrls(context: Context): string[] {
		const urls: string[] = [];
		for (const message of context.messages) {
			if (message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") continue;
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type === "image" && block.url) urls.push(block.url);
			}
		}
		return urls;
	}

	#failedConfigIndex(urls: readonly string[]): number {
		for (const url of urls) {
			const publication = this.#publicationByUrl.get(url);
			const source = this.#publicationSourceByUrl.get(url);
			if (!publication || !source) continue;
			const relativeIndex = this.#configs
				.slice(source.rangeStart, source.rangeEnd)
				.findIndex(config => config.kind === publication.destination);
			if (relativeIndex >= 0) return source.rangeStart + relativeIndex;
		}
		return -1;
	}

	#forgetUrls(urls: readonly string[]): void {
		for (const url of urls) {
			const lazyKey = this.#lazyKeyByUrl.get(url);
			this.#publicationByUrl.delete(url);
			this.#publicationSourceByUrl.delete(url);
			this.#lazyKeyByUrl.delete(url);
			if (lazyKey) this.#producers.delete(lazyKey);
		}
	}

	async fallbackContext(context: Context, model: Model): Promise<Context> {
		const urls = this.#imageUrls(context);
		if (contextHasProviderFiles(context)) {
			await this.#providerFiles?.invalidateContext(context, model);
			const inline = await this.inlineContext(context);
			this.#forgetUrls(urls);
			const withUrls = await this.#decorateUrls(inline, model, this.#configs, "all");
			const fallback = contextHasImageUrls(withUrls) ? withUrls : inline;
			await this.#recordSavings(inline, fallback, model);
			return fallback;
		}

		const failedIndex = this.#failedConfigIndex(urls);
		const inline = await this.inlineContext(context);
		this.#forgetUrls(urls);
		const nextIndex = failedIndex + 1;
		if (failedIndex < 0 || nextIndex >= this.#configs.length) return inline;
		const withUrls = await this.#decorateUrls(
			inline,
			model,
			this.#configs.slice(nextIndex),
			`range:${nextIndex}:${this.#configs.length}`,
		);
		const fallback = contextHasImageUrls(withUrls) ? withUrls : inline;
		await this.#recordSavings(inline, fallback, model);
		return fallback;
	}

	quarantine(provider: string, reason: string): void {
		if (this.#quarantined.has(provider)) return;
		this.#quarantined.add(provider);
		logger.warn("blob-broker: provider quarantined from image URLs", { provider, reason });
	}

	isQuarantined(provider: string): boolean {
		return this.#quarantined.has(provider);
	}

	stop(): void {
		this.#callback?.server.stop(true);
		this.#callback = null;
		for (const pending of this.#backendPromises.values()) void pending.then(backend => backend?.stop());
		this.#backendPromises.clear();
		this.#publicationByUrl.clear();
		this.#publicationSourceByUrl.clear();
		this.#lazyKeyByUrl.clear();
		this.#producers.clear();
	}
}

function destinationOptions(
	configured: Readonly<Record<string, unknown>> | undefined,
): Record<string, DestinationOptionValue> {
	const options: Record<string, DestinationOptionValue> = {};
	if (!configured) return options;
	for (const key in configured) {
		const value = configured[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			options[key] = value;
		}
	}
	return options;
}

export function providerFileCachePath(settings: Settings, projectDir: string): string {
	const projectHash = Bun.hash.wyhash(path.resolve(projectDir)).toString(16);
	return path.join(getBlobsDir(settings.getAgentDir()), `provider-files-index-${projectHash}.json`);
}

export function resolveBlobBrokerConfigs(settings: Settings, projectDir: string): BlobBrokerWorkerConfig[] {
	const blobsDir = getBlobsDir(settings.getAgentDir());
	const projectHash = Bun.hash.wyhash(path.resolve(projectDir)).toString(16);
	const savingsPath = blobBrokerSavingsJournalPath(settings, projectDir);
	const optionsByDestination = settings.get("images.urls.options");
	const credentialsByDestination = settings.get("images.urls.credentials");
	const configs: BlobBrokerWorkerConfig[] = [];
	for (const destination of settings.get("images.urls.backends")) {
		if (destination === "provider-files") continue;
		const options = destinationOptions(optionsByDestination[destination]);
		if (destination === "command" && typeof options.command !== "string") {
			const command = settings.get("images.urls.command");
			if (command) options.command = command;
		}
		const configuredBaseUrl = options.publicBaseUrl;
		const configuredBindHost = options.bindHost;
		const configuredSshTarget = options.sshTarget ?? options.host;
		const configuredSshRemotePort = options.sshRemotePort;
		configs.push({
			kind: destination,
			options,
			credentials: { ...(credentialsByDestination[destination] ?? {}) },
			publicBaseUrl:
				typeof configuredBaseUrl === "string"
					? configuredBaseUrl || undefined
					: settings.get("images.urls.publicBaseUrl") || undefined,
			bindHost:
				typeof configuredBindHost === "string"
					? configuredBindHost || "127.0.0.1"
					: settings.get("images.urls.bindHost") || "127.0.0.1",
			sshTarget:
				typeof configuredSshTarget === "string"
					? configuredSshTarget || undefined
					: settings.get("images.urls.sshTarget") || undefined,
			sshRemotePort:
				typeof configuredSshRemotePort === "number"
					? configuredSshRemotePort
					: settings.get("images.urls.sshRemotePort"),
			persist: {
				blobsDir,
				indexPath: path.join(blobsDir, `urls-index-${destination}-${projectHash}.json`),
				savingsPath,
				ttlMs: Math.max(0, settings.get("images.urls.ttlHours")) * 3_600_000,
			},
		});
	}
	return configs;
}

export function createImageUrlServiceFromSettings(
	settings: Settings,
	projectDir: string,
	resolveCredential: ProviderFileCredentialResolver,
): ImageUrlService | undefined {
	if (!settings.get("images.urls.enabled")) return undefined;
	const configs = resolveBlobBrokerConfigs(settings, projectDir);
	let providerFilePosition: number | undefined;
	let urlPosition = 0;
	for (const destination of settings.get("images.urls.backends")) {
		if (destination === "provider-files") providerFilePosition ??= urlPosition;
		else urlPosition++;
	}
	if (configs.length === 0 && providerFilePosition === undefined) {
		logger.warn("blob-broker: no configured image backend is available; images stay inline");
		return undefined;
	}
	const savingsJournal = new BlobBrokerSavingsJournal(blobBrokerSavingsJournalPath(settings, projectDir));
	const providerFiles =
		providerFilePosition === undefined
			? undefined
			: new ProviderFileManager(
					new ProviderFileCache(providerFileCachePath(settings, projectDir)),
					resolveCredential,
				);
	return new ImageUrlService(projectDir, configs, {
		providerFiles,
		providerFilePosition: providerFilePosition ?? configs.length,
		savingsJournal,
	});
}
