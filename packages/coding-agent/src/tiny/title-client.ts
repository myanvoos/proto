import { $env, logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	inferenceWorkerEnv,
	logWorkerMessage,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	type SpawnedSubprocess,
	spawnWorkerOrUnavailable,
} from "../subprocess/worker-client";
import { safeSend } from "../utils/ipc";
import { tinyModelDeviceSettingToEnv } from "./device";
import { tinyModelDtypeSettingToEnv } from "./dtype";
import {
	isTinyLocalModelKey,
	isTinyMemoryLocalModelKey,
	isTinyTitleLocalModelKey,
	type TinyLocalModelKey,
	type TinyMemoryLocalModelKey,
	type TinyTitleLocalModelKey,
} from "./models";
import type { TinyTitleProgressEvent, TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "./title-protocol";

type PendingRequest =
	| { kind: "generate"; modelKey: TinyTitleLocalModelKey; resolve: (title: string | null) => void }
	| { kind: "complete"; modelKey: TinyMemoryLocalModelKey; resolve: (text: string | null) => void }
	| { kind: "download"; modelKey: TinyLocalModelKey; resolve: (result: TinyTitleDownloadResult) => void };

interface TinyTitleDownloadResult {
	ok: boolean;
	error?: string;
}

interface TinyTitleDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TinyTitleProgressEvent) => void;
}

const DEFAULT_TINY_WORKER_IDLE_KILL_MS = 5 * 60_000;

interface TinyTitleGenerateOptions {
	signal?: AbortSignal;
	systemPrompt?: string;
}

interface TinyModelCompletionOptions {
	maxTokens?: number;
	signal?: AbortSignal;
	systemPrompt?: string;
}

function normalizeTinyTitleGenerateOptions(
	options: AbortSignal | TinyTitleGenerateOptions | undefined,
): TinyTitleGenerateOptions {
	if (!options) return {};
	if ("aborted" in options && "addEventListener" in options) return { signal: options };
	return options;
}

export const TINY_WORKER_ARG = "__proto_worker_tiny_inference";

function readTinyModelSetting(path: "providers.tinyModelDevice" | "providers.tinyModelDtype"): string | undefined {
	try {
		const value = settings.get(path);
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

export function tinyWorkerEnvOverlay(
	env: Record<string, string | undefined>,
	deviceSetting: string | undefined,
	dtypeSetting: string | undefined,
): Record<string, string> {
	const overlay: Record<string, string> = {};
	if (!env.PI_TINY_DEVICE) {
		const device = tinyModelDeviceSettingToEnv(deviceSetting);
		if (device) overlay.PI_TINY_DEVICE = device;
	}
	if (!env.PI_TINY_DTYPE) {
		const dtype = tinyModelDtypeSettingToEnv(dtypeSetting);
		if (dtype) overlay.PI_TINY_DTYPE = dtype;
	}
	return overlay;
}

function tinyWorkerEnv(): Record<string, string> {
	return inferenceWorkerEnv(
		tinyWorkerEnvOverlay(
			$env,
			readTinyModelSetting("providers.tinyModelDevice"),
			readTinyModelSetting("providers.tinyModelDtype"),
		),
	);
}

export function createTinyTitleSubprocess(): SpawnedSubprocess<TinyTitleWorkerOutbound> {
	return createWorkerSubprocess<TinyTitleWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(TINY_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "tiny model subprocess",
	});
}

function wrapSubprocess(
	spawned: SpawnedSubprocess<TinyTitleWorkerOutbound>,
): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
	const { proc } = spawned;
	return {
		...createWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>(spawned, message =>
			safeSend(proc, message, "tiny-title"),
		),
		ref() {
			try {
				proc.ref();
			} catch {}
		},
		unref() {
			try {
				proc.unref();
			} catch {}
		},
	};
}

function spawnInlineUnavailableWorker(
	error: unknown,
): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
	return {
		...createUnavailableWorker<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>(error),
		ref() {},
		unref() {},
	};
}

function spawnTinyTitleWorker(): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createTinyTitleSubprocess()),
		spawnInlineUnavailableWorker,
		"Tiny title worker spawn failed; local titles disabled",
	);
}

export class TinyTitleClient {
	#worker: RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#failedModels = new Set<TinyLocalModelKey>();
	#progressListeners = new Set<(event: TinyTitleProgressEvent) => void>();
	#nextRequestId = 0;
	#refed = false;
	#idleTimer: NodeJS.Timeout | null = null;
	#idleKillMs: number;
	#spawnWorker: () => RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>;

	constructor(
		spawnWorker: () => RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> = spawnTinyTitleWorker,
		idleKillMs: number = DEFAULT_TINY_WORKER_IDLE_KILL_MS,
	) {
		this.#spawnWorker = spawnWorker;
		this.#idleKillMs = idleKillMs;
	}

	onProgress(listener: (event: TinyTitleProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	prewarm(modelKey: string): void {
		if (!isTinyTitleLocalModelKey(modelKey) || this.#failedModels.has(modelKey)) return;
		try {
			const worker = this.#ensureWorker();
			worker.send({ type: "ping", id: String(++this.#nextRequestId) });
		} catch (error) {
			logger.debug("tiny-title: prewarm failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async generate(modelKey: string, message: string, signal?: AbortSignal): Promise<string | null>;
	async generate(modelKey: string, message: string, options?: TinyTitleGenerateOptions): Promise<string | null>;
	async generate(
		modelKey: string,
		message: string,
		optionsOrSignal?: AbortSignal | TinyTitleGenerateOptions,
	): Promise<string | null> {
		const options = normalizeTinyTitleGenerateOptions(optionsOrSignal);
		if (!isTinyTitleLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#addPending(id, { kind: "generate", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "generate") return;
				this.#deletePending(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				const request: TinyTitleWorkerInbound = options.systemPrompt
					? { type: "generate", id, modelKey, message, systemPrompt: options.systemPrompt }
					: { type: "generate", id, modelKey, message };
				worker.send(request);
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tiny-title: local generation failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async complete(modelKey: string, prompt: string, options: TinyModelCompletionOptions = {}): Promise<string | null> {
		if (!isTinyMemoryLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#addPending(id, { kind: "complete", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "complete") return;
				this.#deletePending(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({
					type: "complete",
					id,
					modelKey,
					prompt,
					maxTokens: options.maxTokens,
					systemPrompt: options.systemPrompt,
				});
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tiny-model: local completion failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async downloadModel(modelKey: string, options: TinyTitleDownloadOptions = {}): Promise<TinyTitleDownloadResult> {
		if (!isTinyLocalModelKey(modelKey)) return { ok: false };
		if (options.signal?.aborted) return { ok: false };

		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<TinyTitleDownloadResult>();
			this.#addPending(id, { kind: "download", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "download") return;
				this.#deletePending(id);
				pending.resolve({ ok: false });
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "download", id, modelKey });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.debug("tiny-title: local model download failed", {
				modelKey,
				error: message,
			});
			return { ok: false, error: message };
		} finally {
			unsubscribe?.();
		}
	}

	async terminate(): Promise<void> {
		this.#disarmIdleKill();
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
			else pending.resolve({ ok: false });
		}
		this.#pending.clear();
		this.#refed = false;
		try {
			await worker?.terminate();
		} catch {}
	}

	#ensureWorker(): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
		if (this.#worker) {
			this.#armIdleKill();
			return this.#worker;
		}
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		this.#armIdleKill();
		return worker;
	}

	#disarmIdleKill(): void {
		if (this.#idleTimer !== null) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = null;
		}
	}

	#armIdleKill(): void {
		this.#disarmIdleKill();
		if (this.#worker === null || this.#pending.size > 0 || this.#idleKillMs <= 0) return;
		const timer = setTimeout(() => {
			this.#idleTimer = null;
			logger.debug("tiny-title: terminating idle worker", { idleMs: this.#idleKillMs });
			void this.terminate();
		}, this.#idleKillMs);
		timer.unref();
		this.#idleTimer = timer;
	}

	#addPending(id: string, request: PendingRequest): void {
		this.#pending.set(id, request);
		this.#disarmIdleKill();
		this.#syncWorkerRef();
	}

	#deletePending(id: string): void {
		if (this.#pending.delete(id)) {
			this.#syncWorkerRef();
			if (this.#pending.size === 0) this.#armIdleKill();
		}
	}

	#syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0;
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	#handleMessage(message: TinyTitleWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#deletePending(message.id);
		if (message.type === "title") {
			if (pending.kind === "generate") pending.resolve(message.title);
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve({ ok: true });
			return;
		}
		if (message.type === "completion") {
			if (pending.kind === "complete") pending.resolve(message.text);
			return;
		}
		logger.debug("tiny-title: worker returned error", { error: message.error });
		this.#markFailedModel(pending);
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "download") pending.resolve({ ok: false, error: message.error });
		else pending.resolve(null);
		void this.terminate();
	}

	#markFailedModel(pending: PendingRequest): void {
		if (pending.kind === "generate" || pending.kind === "complete") this.#failedModels.add(pending.modelKey);
	}

	#emitProgress(event: TinyTitleProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#handleWorkerError(error: Error): void {
		logger.warn("tiny-title: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
			else pending.resolve({ ok: false, error: error.message });
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const tinyTitleClient = new TinyTitleClient();

export const tinyModelClient = tinyTitleClient;

export async function shutdownTinyTitleClient(): Promise<void> {
	await tinyTitleClient.terminate();
}
