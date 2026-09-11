import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { isVertexExpressOpenAIUrl, isVertexRawPredictUrl, resolveVertexEndpointHost } from "@oh-my-pi/pi-catalog/hosts";
import {
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	minimumSupportedEffort,
	requireSupportedEffort,
	resolveWireModelId,
} from "@oh-my-pi/pi-catalog/model-thinking";
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@oh-my-pi/pi-catalog/provider-models";
import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";
import { $env, $pickenv, getProviderInFlightRoot, isEnoent, logger, withExtraCaFetch } from "@oh-my-pi/pi-utils";
import { getCustomApi } from "./api-registry";
import { createAuthRetryKeyState, isApiKeyResolver, resolveNextAuthRetryKey } from "./auth-retry";
import * as AIError from "./error";
import { ProviderHttpError } from "./error";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./error/rate-limit";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { MessageCreateParamsStreaming } from "./providers/anthropic-wire";
import { coworkFetch } from "./providers/cowork-fetch";
import type { CursorOptions } from "./providers/cursor";
import type { DevinOptions } from "./providers/devin";
import { isGitLabDuoModel, streamGitLabDuo } from "./providers/gitlab-duo";
import { type GitLabDuoWorkflowOptions, streamGitLabDuoWorkflow } from "./providers/gitlab-duo-workflow";
import type { GoogleOptions } from "./providers/google";
import { getVertexAccessToken } from "./providers/google-auth";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import { isKimiModel, streamKimi } from "./providers/kimi";
import type { OllamaChatOptions } from "./providers/ollama";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import { streamPiNative } from "./providers/pi-native-client";

import {
	streamAnthropic,
	streamAzureOpenAIResponses,
	streamBedrock,
	streamCursor,
	streamDevin,
	streamGoogle,
	streamGoogleGeminiCli,
	streamGoogleVertex,
	streamOllama,
	streamOpenAICodexResponses,
	streamOpenAICompletions,
	streamOpenAIResponses,
} from "./providers/register-builtins";
import { isSyntheticModel, streamSynthetic } from "./providers/synthetic";
import { getProviderDefinition, getProviderRegistry } from "./registry";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	OptionsForApi,
	ProviderSessionState,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ToolChoice,
} from "./types";
import { resolveCacheRetention } from "./utils";
import { AssistantMessageEventStream } from "./utils/event-stream";
import { isFoundryEnabled } from "./utils/foundry";
import { applyGlyphCodec } from "./utils/glyph-codec";
import { wrapLeakedThinkingStream } from "./utils/leaked-thinking-stream";
import { wrapFetchForProxy } from "./utils/proxy";
import { withRequestDebugFetch } from "./utils/request-debug";
import { withThinkingLoopGuard } from "./utils/thinking-loop";

function defaultFetchForModel(model: Model<Api>): FetchImpl {
	if (model.provider === "anthropic" && model.api === "anthropic-messages") return coworkFetch;
	return globalThis.fetch;
}

function isGoogleVertexAuthenticatedModel(model: Model<Api>): boolean {
	return (
		model.provider === "google-vertex" &&
		((model.api === "openai-completions" && isVertexExpressOpenAIUrl(model.baseUrl)) ||
			(model.api === "anthropic-messages" && isVertexRawPredictUrl(model.baseUrl)))
	);
}

function isLeakedThinkingHealExempt(model: Model<Api>): boolean {
	switch (model.provider) {
		case "anthropic": {
			if (isFoundryEnabled()) {
				const foundry = $env.FOUNDRY_BASE_URL?.trim();
				if (foundry) return isOfficialAnthropicApiUrl(foundry);
			}
			if (model.baseUrl && !isOfficialAnthropicApiUrl(model.baseUrl)) return false;
			return isOfficialAnthropicApiUrl($env.ANTHROPIC_BASE_URL?.trim() || model.baseUrl);
		}
		case "openai":
			return isOfficialOpenAIApiUrl(model.baseUrl);
		case "openai-codex":
			return isOfficialCodexApiUrl(model.baseUrl);
		default:
			return false;
	}
}

function isOfficialOpenAIApiUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return true;
	try {
		return new URL(baseUrl).hostname === "api.openai.com";
	} catch {
		return false;
	}
}

export function isOfficialCodexApiUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return true;
	const lower = baseUrl.toLowerCase().replace(/\/+$/, "");
	return lower === CODEX_BASE_URL || lower.startsWith(`${CODEX_BASE_URL}/`);
}

function healLeakedThinking(model: Model<Api>, inner: AssistantMessageEventStream): AssistantMessageEventStream {
	return isLeakedThinkingHealExempt(model) ? inner : wrapLeakedThinkingStream(inner);
}

type ProviderInFlightLease = {
	path: string;
	stopHeartbeat: () => Promise<void>;
};

type ProviderInFlightLeaseInfo = {
	pid: number;
	timestamp: number;
	token: string;
};
type ProviderInFlightStaleLock = { token: string } | { mtimeMs: number };
type ProviderInFlightLockIdentity = { dev: number; ino: number; birthtimeMs: number };

const PROVIDER_INFLIGHT_LOCK_STALE_MS = 10_000;
const PROVIDER_INFLIGHT_LEASE_STALE_MS = 30_000;
const PROVIDER_INFLIGHT_HEARTBEAT_MS = 5_000;
const PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS = 250;
const PROVIDER_INFLIGHT_HEARTBEAT_FLUSH_TIMEOUT_MS = 1_000;
const PROVIDER_INFLIGHT_RELEASE_TIMEOUT_MS = 5_000;

let configuredProviderMaxInFlightRequests: Record<string, number> = {};
let providerInFlightRootOverride: string | undefined;
let providerInFlightHeartbeatMsOverride: number | undefined;
let providerInFlightHeartbeatFlushTimeoutMsOverride: number | undefined;
let providerInFlightHeartbeatWriterOverride:
	| ((writeProviderInFlightInfo: () => Promise<void>) => Promise<void>)
	| undefined;
let providerInFlightLeaseRemoverOverride: ((leasePath: string) => Promise<void>) | undefined;
let providerInFlightWaitObserverOverride: ((provider: string) => void) | undefined;

export function configureProviderMaxInFlightRequests(limits: Record<string, number> | undefined): void {
	configuredProviderMaxInFlightRequests = limits ?? {};
}

function resolveProviderInFlightLimit(
	provider: string,
	options?: Pick<StreamOptions, "maxInFlightRequests">,
): number | undefined {
	const limits = options?.maxInFlightRequests ?? configuredProviderMaxInFlightRequests;
	const value = limits[provider];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.max(1, Math.floor(value));
}

function providerInFlightRoot(): string {
	if (providerInFlightRootOverride) return providerInFlightRootOverride;
	return getProviderInFlightRoot();
}

function providerInFlightSegment(provider: string): string {
	return Bun.SHA256.hash(provider, "base64url");
}

function providerInFlightDir(provider: string): string {
	return path.join(providerInFlightRoot(), providerInFlightSegment(provider));
}

function providerInFlightSignalPath(provider: string): string {
	return path.join(providerInFlightDir(provider), ".wakeup");
}

function providerInFlightLockDir(provider: string): string {
	return `${providerInFlightDir(provider)}.lock`;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function readProviderInFlightInfo(infoPath: string): Promise<ProviderInFlightLeaseInfo | null> {
	try {
		const content = await fs.readFile(infoPath, "utf-8");
		const parsed = JSON.parse(content) as Partial<ProviderInFlightLeaseInfo>;
		if (typeof parsed.pid !== "number" || typeof parsed.timestamp !== "number" || typeof parsed.token !== "string") {
			return null;
		}
		return { pid: parsed.pid, timestamp: parsed.timestamp, token: parsed.token };
	} catch {
		return null;
	}
}

async function writeProviderInFlightInfo(dir: string, token: string): Promise<void> {
	const info: ProviderInFlightLeaseInfo = { pid: process.pid, timestamp: Date.now(), token };
	const infoPath = path.join(dir, "info.json");
	const tempPath = path.join(dir, `.info-${process.pid}-${crypto.randomUUID()}.tmp`);
	try {
		await fs.writeFile(tempPath, JSON.stringify(info), "utf8");
		await fs.rename(tempPath, infoPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

async function isProviderInFlightDirStale(dir: string, staleMs: number): Promise<boolean> {
	const info = await readProviderInFlightInfo(path.join(dir, "info.json"));
	if (info) {
		if (!isProcessAlive(info.pid)) return true;
		return Date.now() - info.timestamp > staleMs;
	}

	try {
		const stat = await fs.stat(path.join(dir, "info.json"));
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	try {
		const stat = await fs.stat(dir);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readProviderInFlightStaleLock(lockDir: string): Promise<ProviderInFlightStaleLock | null> {
	const infoPath = path.join(lockDir, "info.json");
	const info = await readProviderInFlightInfo(infoPath);
	if (info) return isProcessAlive(info.pid) ? null : { token: info.token };

	try {
		const stat = await fs.stat(lockDir);
		return Date.now() - stat.mtimeMs > PROVIDER_INFLIGHT_LOCK_STALE_MS ? { mtimeMs: stat.mtimeMs } : null;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function readProviderInFlightLockIdentity(lockDir: string): Promise<ProviderInFlightLockIdentity> {
	const stat = await fs.stat(lockDir);
	return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function isSameProviderInFlightLock(
	current: ProviderInFlightLockIdentity,
	expected: ProviderInFlightLockIdentity,
): boolean {
	if (current.dev !== expected.dev) return false;
	if (current.ino !== 0 || expected.ino !== 0) return current.ino === expected.ino;
	return current.birthtimeMs === expected.birthtimeMs;
}

async function releaseProviderInFlightStaleLock(lockDir: string, stale: ProviderInFlightStaleLock): Promise<void> {
	if ("token" in stale) {
		await releaseProviderInFlightLock(lockDir, stale.token);
		return;
	}

	const infoPath = path.join(lockDir, "info.json");
	if (await readProviderInFlightInfo(infoPath)) return;
	try {
		const stat = await fs.stat(lockDir);
		if (stat.mtimeMs !== stale.mtimeMs || Date.now() - stat.mtimeMs <= PROVIDER_INFLIGHT_LOCK_STALE_MS) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

async function releaseProviderInFlightLock(lockDir: string, token: string): Promise<void> {
	try {
		const info = await readProviderInFlightInfo(path.join(lockDir, "info.json"));
		if (!info || info.token !== token) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

async function releaseProviderInFlightLockDirIfSame(
	lockDir: string,
	identity: ProviderInFlightLockIdentity,
): Promise<void> {
	try {
		if (await readProviderInFlightInfo(path.join(lockDir, "info.json"))) return;
		const current = await readProviderInFlightLockIdentity(lockDir);
		if (!isSameProviderInFlightLock(current, identity)) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

async function acquireProviderInFlightLock(provider: string, signal?: AbortSignal): Promise<() => Promise<void>> {
	const lockDir = providerInFlightLockDir(provider);
	await fs.mkdir(path.dirname(lockDir), { recursive: true });

	while (true) {
		if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
		try {
			await fs.mkdir(lockDir);
			const lockIdentity = await readProviderInFlightLockIdentity(lockDir);
			const token = crypto.randomUUID();
			try {
				await writeProviderInFlightInfo(lockDir, token);
			} catch (error) {
				await releaseProviderInFlightLockDirIfSame(lockDir, lockIdentity);
				throw error;
			}
			return async () => {
				await releaseProviderInFlightLock(lockDir, token);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		const staleLock = await readProviderInFlightStaleLock(lockDir);
		if (staleLock) {
			await releaseProviderInFlightStaleLock(lockDir, staleLock);
			await signalProviderInFlightWaiters(provider);
			continue;
		}

		await waitForProviderInFlightSignal(provider, signal);
	}
}

async function cleanupProviderInFlightLeases(providerDir: string): Promise<number> {
	let active = 0;
	let entries: string[];
	try {
		entries = await fs.readdir(providerDir);
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}

	for (const entry of entries) {
		const leaseDir = path.join(providerDir, entry);
		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(leaseDir)).isDirectory();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		if (!isDirectory) continue;
		if (await isProviderInFlightDirStale(leaseDir, PROVIDER_INFLIGHT_LEASE_STALE_MS)) {
			await fs.rm(leaseDir, { recursive: true, force: true });
			continue;
		}
		active++;
	}
	return active;
}

async function tryAcquireProviderInFlightLease(
	provider: string,
	limit: number,
	signal?: AbortSignal,
): Promise<ProviderInFlightLease | null> {
	const releaseLock = await acquireProviderInFlightLock(provider, signal);
	try {
		const dir = providerInFlightDir(provider);
		await fs.mkdir(dir, { recursive: true });
		const active = await cleanupProviderInFlightLeases(dir);
		if (active >= limit) return null;

		const leaseDir = path.join(dir, `${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
		const token = crypto.randomUUID();
		try {
			await fs.mkdir(leaseDir);
			await writeProviderInFlightInfo(leaseDir, token);
		} catch (error) {
			await removeProviderInFlightLeaseDir(leaseDir).catch(() => {});
			throw error;
		}
		let heartbeatActive = true;
		let heartbeatFlush = Promise.resolve();
		const touchHeartbeat = () => {
			if (!heartbeatActive) return;
			heartbeatFlush = heartbeatFlush
				.then(async () => {
					if (!heartbeatActive) return;
					const write = () => {
						if (!heartbeatActive) return Promise.resolve();
						return writeProviderInFlightInfo(leaseDir, token);
					};
					if (providerInFlightHeartbeatWriterOverride) {
						await providerInFlightHeartbeatWriterOverride(write);
					} else {
						await write();
					}
				})
				.catch(() => {});
		};
		const heartbeat = setInterval(
			touchHeartbeat,
			providerInFlightHeartbeatMsOverride ?? PROVIDER_INFLIGHT_HEARTBEAT_MS,
		);
		heartbeat.unref?.();
		return {
			path: leaseDir,
			stopHeartbeat: () => {
				heartbeatActive = false;
				clearInterval(heartbeat);
				return heartbeatFlush;
			},
		};
	} finally {
		await releaseLock();
	}
}

async function signalProviderInFlightWaitersInDir(dir: string): Promise<void> {
	try {
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, ".wakeup"), String(Date.now()));
	} catch {}
}

async function signalProviderInFlightWaiters(provider: string): Promise<void> {
	await signalProviderInFlightWaitersInDir(providerInFlightDir(provider));
}

function waitForProviderInFlightSignal(provider: string, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted)
		return Promise.reject(signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch"));
	const signalPath = providerInFlightSignalPath(provider);
	providerInFlightWaitObserverOverride?.(provider);
	const waitStarted = Date.now();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	let watcher: fsSync.FSWatcher | undefined;
	const timer = setTimeout(() => finish(resolve), PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS);
	const finish = (settle: () => void) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		watcher?.close();
		signal?.removeEventListener("abort", onAbort);
		settle();
	};
	const onAbort = () => {
		finish(() => reject(signal?.reason ?? new AIError.AbortError("Provider request aborted before dispatch")));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		watcher = fsSync.watch(providerInFlightDir(provider), (_event, filename) => {
			if (filename === ".wakeup" || filename === null) {
				finish(resolve);
			}
		});
		void fs.stat(signalPath).then(
			stat => {
				if (stat.mtimeMs >= waitStarted) finish(resolve);
			},
			error => {
				if (!isEnoent(error)) finish(resolve);
			},
		);
	} catch {}
	return promise;
}

async function removeProviderInFlightLeaseDir(leasePath: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rm(leasePath, { recursive: true, force: true });
			return;
		} catch (error) {
			if (isEnoent(error)) return;
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt < 2 && (code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM")) {
				await Bun.sleep(25);
				continue;
			}
			throw error;
		}
	}
}

async function releaseProviderInFlightLease(lease: ProviderInFlightLease): Promise<void> {
	const heartbeatFlush = lease.stopHeartbeat();
	const flushTimeout = Promise.withResolvers<"timeout">();
	const flushTimer = setTimeout(
		() => flushTimeout.resolve("timeout"),
		providerInFlightHeartbeatFlushTimeoutMsOverride ?? PROVIDER_INFLIGHT_HEARTBEAT_FLUSH_TIMEOUT_MS,
	);
	flushTimer.unref?.();
	try {
		const outcome = await Promise.race([heartbeatFlush.then(() => "flushed" as const), flushTimeout.promise]);
		if (outcome === "timeout") {
			logger.warn("Provider in-flight heartbeat flush timed out; forcing lease cleanup", { path: lease.path });
		}
	} finally {
		clearTimeout(flushTimer);
	}

	const releaseTimeout = Promise.withResolvers<never>();
	const releaseTimer = setTimeout(
		() => releaseTimeout.reject(new Error("Provider in-flight lease cleanup timed out")),
		PROVIDER_INFLIGHT_RELEASE_TIMEOUT_MS,
	);
	releaseTimer.unref?.();
	try {
		const removeLease = providerInFlightLeaseRemoverOverride ?? removeProviderInFlightLeaseDir;
		await Promise.race([removeLease(lease.path), releaseTimeout.promise]);
	} finally {
		clearTimeout(releaseTimer);
	}

	void signalProviderInFlightWaitersInDir(path.dirname(lease.path));
}

async function acquireProviderInFlightSlot(
	provider: string,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	if (limit === undefined) return async () => {};
	let loggedWait = false;
	while (true) {
		if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
		const lease = await tryAcquireProviderInFlightLease(provider, limit, signal);
		if (lease) return () => releaseProviderInFlightLease(lease);
		if (!loggedWait) {
			loggedWait = true;
			logger.debug("Provider in-flight limit blocked request", { provider, limit });
		}
		await waitForProviderInFlightSignal(provider, signal);
	}
}

export const __providerInFlightForTesting = {
	setRoot(root: string | undefined): void {
		providerInFlightRootOverride = root;
	},
	setHeartbeatTimings(timings: { heartbeatMs?: number; heartbeatFlushTimeoutMs?: number } | undefined): void {
		providerInFlightHeartbeatMsOverride = timings?.heartbeatMs;
		providerInFlightHeartbeatFlushTimeoutMsOverride = timings?.heartbeatFlushTimeoutMs;
	},
	setHeartbeatWriter(writer: ((writeProviderInFlightInfo: () => Promise<void>) => Promise<void>) | undefined): void {
		providerInFlightHeartbeatWriterOverride = writer;
	},
	setLeaseRemover(remover: ((leasePath: string) => Promise<void>) | undefined): void {
		providerInFlightLeaseRemoverOverride = remover;
	},
	setWaitObserver(observer: ((provider: string) => void) | undefined): void {
		providerInFlightWaitObserverOverride = observer;
	},
	providerDir(provider: string): string {
		return providerInFlightDir(provider);
	},
	lockDir(provider: string): string {
		return providerInFlightLockDir(provider);
	},
	async captureStaleLockRelease(provider: string): Promise<(() => Promise<void>) | null> {
		const lockDir = providerInFlightLockDir(provider);
		const stale = await readProviderInFlightStaleLock(lockDir);
		if (!stale) return null;
		return () => releaseProviderInFlightStaleLock(lockDir, stale);
	},
	async captureLockDirRelease(provider: string): Promise<(() => Promise<void>) | null> {
		const lockDir = providerInFlightLockDir(provider);
		try {
			const identity = await readProviderInFlightLockIdentity(lockDir);
			return () => releaseProviderInFlightLockDirIfSame(lockDir, identity);
		} catch {
			return null;
		}
	},
};

function withProviderInFlightLimit<TOptions extends Pick<StreamOptions, "signal" | "maxInFlightRequests">>(
	model: Model<Api>,
	options: TOptions | undefined,
	dispatch: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const limit = resolveProviderInFlightLimit(model.provider, options);
	if (limit === undefined) return healLeakedThinking(model, dispatch());

	const outer = new AssistantMessageEventStream();
	void (async () => {
		let release: (() => Promise<void>) | undefined;
		let releasePromise: Promise<void> | undefined;
		const releaseOnce = () => {
			if (!release) return Promise.resolve();
			releasePromise ??= release();
			return releasePromise;
		};
		const releaseBestEffort = async () => {
			try {
				await releaseOnce();
			} catch (releaseError) {
				logger.warn("Provider in-flight permit release failed", {
					provider: model.provider,
					error: String(releaseError),
				});
			}
		};
		try {
			const startedWaitingAt = Date.now();
			release = await acquireProviderInFlightSlot(model.provider, limit, options?.signal);
			if (Date.now() - startedWaitingAt >= PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS) {
				logger.debug("Provider in-flight limit wait completed", { provider: model.provider, limit });
			}
			if (options?.signal?.aborted) {
				throw options.signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
			}
			const inner = healLeakedThinking(model, dispatch());
			let terminalEvent: AssistantMessageEvent | undefined;
			for await (const event of inner) {
				if (event.type === "done" || event.type === "error") {
					terminalEvent = event;
					break;
				}
				outer.push(event);
				if (outer.done) {
					await releaseBestEffort();
					return;
				}
			}
			const result = await inner.result();

			await releaseBestEffort();
			if (!outer.done) {
				if (terminalEvent) outer.push(terminalEvent);
				else outer.end(result);
			}
		} catch (error) {
			await releaseBestEffort();
			if (!outer.done) outer.fail(error);
		}
	})();
	return outer;
}

function createVertexAuthenticatedFetch(options: StreamOptions | undefined): FetchImpl {
	const baseFetch = options?.fetch ?? fetch;
	const vertexFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const token = await getVertexAccessToken({ signal: options?.signal, fetch: baseFetch });
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		const rewritten = resolveVertexRequest(input);
		const url = rewritten instanceof Request ? rewritten.url : rewritten.toString();
		if (isVertexRawPredictUrl(url)) {
			const bodyText = await readVertexRequestBody(rewritten, init);
			const transformed = transformVertexAnthropicBody(bodyText);
			return baseFetch(url, {
				...init,
				method: init?.method ?? (rewritten instanceof Request ? rewritten.method : "POST"),
				headers,
				body: transformed,
			});
		}
		return baseFetch(rewritten, { ...init, headers });
	};
	return Object.assign(vertexFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}

async function readVertexRequestBody(input: string | URL | Request, init: RequestInit | undefined): Promise<string> {
	if (input instanceof Request) return input.clone().text();
	const body = init?.body;
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	return "";
}

function transformVertexAnthropicBody(bodyText: string): string {
	if (!bodyText) return bodyText;
	try {
		const payload = JSON.parse(bodyText) as Record<string, unknown>;
		delete payload.model;
		payload.anthropic_version = "vertex-2023-10-16";
		return JSON.stringify(payload);
	} catch {
		return bodyText;
	}
}

function resolveVertexRequest(input: string | URL | Request): string | URL | Request {
	const project = $env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT;
	const location = $env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION;
	if (!project || !location) return input;

	const rewriteUrl = (url: string): string => {
		const hasPlaceholder =
			url.includes("{project}") ||
			url.includes("{location}") ||
			url.includes("%7Bproject%7D") ||
			url.includes("%7Blocation%7D");
		const host = resolveVertexEndpointHost(location);
		const rewritten = hasPlaceholder
			? url
					.replace("https://{location}-aiplatform.googleapis.com", `https://${host}`)
					.replace("https://%7Blocation%7D-aiplatform.googleapis.com", `https://${host}`)
					.replaceAll("{project}", encodeURIComponent(project))
					.replaceAll("%7Bproject%7D", encodeURIComponent(project))
					.replaceAll("{location}", encodeURIComponent(location))
					.replaceAll("%7Blocation%7D", encodeURIComponent(location))
			: url;
		return rewritten.replace(":streamRawPredict/v1/messages", ":streamRawPredict");
	};

	if (input instanceof Request) {
		const rewrittenUrl = rewriteUrl(input.url);
		return rewrittenUrl === input.url ? input : new Request(rewrittenUrl, input);
	}
	if (input instanceof URL) {
		const rewrittenUrl = rewriteUrl(input.toString());
		return rewrittenUrl === input.toString() ? input : new URL(rewrittenUrl);
	}
	return rewriteUrl(input);
}

type KeyResolver = string | (() => string | undefined);

const LEGACY_ENV_KEYS: Record<string, KeyResolver> = {
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	jina: "JINA_API_KEY",
	brave: "BRAVE_API_KEY",
	tinyfish: "TINYFISH_API_KEY",
	firecrawl: "FIRECRAWL_API_KEY",
};

const CATALOG_ENTRY_ENV_KEYS = (CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]).flatMap(provider => {
	const envVars = provider.envVars;
	if (!envVars || envVars.length === 0) return [];
	const resolver: KeyResolver = envVars.length === 1 ? envVars[0] : () => $pickenv(...envVars);
	return [[provider.id, resolver] as [string, KeyResolver]];
});

const serviceProviderMap: Record<string, KeyResolver> = {
	...Object.fromEntries(CATALOG_ENTRY_ENV_KEYS),
	...Object.fromEntries(
		getProviderRegistry().flatMap(provider =>
			provider.envKeys != null ? [[provider.id, provider.envKeys] as [string, KeyResolver]] : [],
		),
	),
	...LEGACY_ENV_KEYS,
};

export function getEnvApiKey(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	if (typeof resolver === "string") {
		return $env[resolver];
	}
	return resolver?.();
}

export function getEnvApiKeyName(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	return typeof resolver === "string" ? resolver : undefined;
}

export function listProvidersWithEnvKey(): string[] {
	return Object.keys(serviceProviderMap);
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	if (!model.requiresGlyphTokenization) {
		return withThinkingLoopGuard(model, options, opts =>
			withProviderInFlightLimit(model, opts, () => streamDispatch(model, context, opts)),
		);
	}
	const codec = applyGlyphCodec(context);
	const execHandlers = options?.execHandlers;
	const wireOptions: OptionsForApi<TApi> | undefined =
		execHandlers === undefined ? options : { ...options, execHandlers: codec.wrapCursorExecHandlers(execHandlers) };
	return codec.wrap(
		withThinkingLoopGuard(model, wireOptions, opts =>
			withProviderInFlightLimit(model, opts, () => streamDispatch(model, codec.context, opts)),
		),
	);
}

function streamDispatch<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	const inputOptions = (options || {}) as StreamOptions;
	const baseOptions = { ...inputOptions, fetch: inputOptions.fetch ?? defaultFetchForModel(model) };
	const debugOptions = withExtraCaFetch(withRequestDebugFetch(baseOptions));
	const requestOptions = {
		...debugOptions,
		fetch: wrapFetchForProxy(debugOptions.fetch, model.provider),
	} as OptionsForApi<TApi>;
	assertExplicitOpenAIResponsesPromptCacheSupport(model, requestOptions);

	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return customApiProvider.stream(model, context, requestOptions as StreamOptions);
	}

	if (isGitLabDuoModel(model)) {
		const apiKey = requestOptions.apiKey || getEnvApiKey(model.provider);
		if (!apiKey) {
			throw new AIError.MissingApiKeyError(model.provider);
		}
		return streamGitLabDuo(model, context, {
			...(requestOptions as SimpleStreamOptions),
			apiKey,
		});
	}

	if (model.api === "gitlab-duo-agent") {
		const apiKey = (requestOptions as StreamOptions | undefined)?.apiKey || getEnvApiKey(model.provider);
		if (!apiKey) {
			throw new AIError.MissingApiKeyError(model.provider);
		}
		return streamGitLabDuoWorkflow(model as Model<"gitlab-duo-agent">, context, {
			...(requestOptions as StreamOptions | undefined),
			apiKey,
		} as GitLabDuoWorkflowOptions);
	}

	if (model.api === "google-vertex") {
		return streamGoogleVertex(model as Model<"google-vertex">, context, requestOptions as GoogleVertexOptions);
	}
	if (model.api === "bedrock-converse-stream") {
		return streamBedrock(model as Model<"bedrock-converse-stream">, context, requestOptions as BedrockOptions);
	}

	const prepareRequest = getProviderDefinition(model.provider)?.prepareRequest;
	const prepared = prepareRequest?.(model as Model<Api>, requestOptions as StreamOptions);
	const providerModel = prepared?.model ?? (model as Model<Api>);
	const preparedOptions = prepared?.options ?? (requestOptions as StreamOptions);
	const apiKey = preparedOptions.apiKey || getEnvApiKey(providerModel.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(providerModel.provider);
	}
	const providerOptions = isGoogleVertexAuthenticatedModel(providerModel)
		? {
				...preparedOptions,
				apiKey: "vertex-adc",
				fetch: createVertexAuthenticatedFetch(preparedOptions),
			}
		: { ...preparedOptions, apiKey };

	const api: Api = providerModel.api;
	switch (api) {
		case "anthropic-messages": {
			const anthropicOptions = providerOptions as AnthropicOptions;
			return streamAnthropic(providerModel as Model<"anthropic-messages">, context, {
				...anthropicOptions,
				isOAuth: anthropicOptions.isOAuth ?? providerModel.isOAuth,
			});
		}

		case "openrouter": {
			const useResponses = $env.PI_OPENROUTER_RESPONSES !== "0";
			if (useResponses) {
				return streamOpenAIResponses(
					providerModel as Model<"openai-responses">,
					context,
					providerOptions as OptionsForApi<"openai-responses">,
				);
			}
			return streamOpenAICompletions(
				providerModel as Model<"openai-completions">,
				context,
				providerOptions as OptionsForApi<"openai-completions">,
			);
		}

		case "openai-completions":
			return streamOpenAICompletions(
				providerModel as Model<"openai-completions">,
				context,
				providerOptions as OptionsForApi<"openai-completions">,
			);

		case "openai-responses":
			return streamOpenAIResponses(
				providerModel as Model<"openai-responses">,
				context,
				providerOptions as OptionsForApi<"openai-responses">,
			);

		case "azure-openai-responses":
			return streamAzureOpenAIResponses(
				providerModel as Model<"azure-openai-responses">,
				context,
				providerOptions as OptionsForApi<"azure-openai-responses">,
			);

		case "openai-codex-responses":
			return streamOpenAICodexResponses(
				providerModel as Model<"openai-codex-responses">,
				context,
				providerOptions as OptionsForApi<"openai-codex-responses">,
			);

		case "google-generative-ai":
			return streamGoogle(providerModel as Model<"google-generative-ai">, context, providerOptions);

		case "google-gemini-cli":
			return streamGoogleGeminiCli(
				providerModel as Model<"google-gemini-cli">,
				context,
				providerOptions as GoogleGeminiCliOptions,
			);

		case "ollama-chat":
			return streamOllama(providerModel as Model<"ollama-chat">, context, providerOptions as OllamaChatOptions);

		case "cursor-agent":
			return streamCursor(providerModel as Model<"cursor-agent">, context, providerOptions as CursorOptions);

		case "devin-agent":
			return streamDevin(providerModel as Model<"devin-agent">, context, providerOptions as DevinOptions);

		default:
			throw new AIError.ConfigurationError(`Unhandled API: ${api}`);
	}
}

const THINKING_LOOP_MAX_ATTEMPTS = 3;
const THINKING_LOOP_RETRY_BASE_DELAY_MS = 500;
const THINKING_LOOP_RETRY_MAX_DELAY_MS = 8_000;

function isRetryableThinkingLoop(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		message.content.length === 0 &&
		AIError.is(message.errorId, AIError.Flag.ThinkingLoop)
	);
}

async function resolveWithThinkingLoopRetries(
	signal: AbortSignal | undefined,
	dispatch: () => AssistantMessageEventStream,
): Promise<AssistantMessage> {
	let message = await dispatch().result();
	let thinkingLoopRetry = isRetryableThinkingLoop(message);
	for (let attempt = 1; thinkingLoopRetry && attempt < THINKING_LOOP_MAX_ATTEMPTS; attempt += 1) {
		signal?.throwIfAborted();
		const delay = Math.min(THINKING_LOOP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), THINKING_LOOP_RETRY_MAX_DELAY_MS);
		await scheduler.wait(delay, { signal });
		message = await dispatch().result();
		thinkingLoopRetry = isRetryableThinkingLoop(message);
	}
	if (thinkingLoopRetry) signal?.throwIfAborted();
	return message;
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): Promise<AssistantMessage> {
	return resolveWithThinkingLoopRetries(options?.signal, () => stream(model, context, options));
}

type AuthRetryFailure = {
	error: unknown;
	bufferedEvents: AssistantMessageEvent[];
	terminalEvent?: Extract<AssistantMessageEvent, { type: "error" }>;
};

function extractStatusFromAssistantError(message: AssistantMessage): number | undefined {
	if (message.errorStatus !== undefined) return message.errorStatus;
	if (!message.errorMessage) return undefined;
	return AIError.status({ message: message.errorMessage });
}

function isRetryableUpstreamError(
	model: Model<Api>,
	error: unknown,
	status: number | undefined,
	message: string | undefined,
): boolean {
	if (AIError.isAuthRetryableError(error)) return true;

	if (AIError.isCodexChatGPTAccountPolicyError(error, model.provider, model.id)) return true;
	if (status === 401 || (status === 403 && !isConcurrencyCapExclusion(status, message))) return true;
	return isUsageLimitOutcome(status, message);
}

function createAssistantAuthError(message: AssistantMessage): Error {
	const text = message.errorMessage ?? "Provider authentication failed";
	const status = extractStatusFromAssistantError(message);
	const error =
		status === undefined
			? new AIError.ProviderResponseError(text, { kind: "runtime" })
			: new ProviderHttpError(text, status);
	return typeof message.errorId === "number" ? AIError.attach(error, message.errorId) : error;
}

function contextualizeAuthRetryError(model: Model<Api>, error: unknown): unknown {
	if (
		!error ||
		typeof error !== "object" ||
		!AIError.isCodexChatGPTAccountPolicyError(error, model.provider, model.id)
	) {
		return error;
	}
	return AIError.attach(error, AIError.create(AIError.Flag.AccountPolicy | AIError.Flag.ContentBlocked));
}

function emitBufferedEvents(stream: AssistantMessageEventStream, events: AssistantMessageEvent[]): void {
	for (const event of events) {
		stream.push(event);
	}
}

const ANTHROPIC_CACHE_TTL_MS = 5 * 60_000;
const ANTHROPIC_CACHE_REFRESH_LEAD_MS = 15_000;
const ANTHROPIC_CACHE_REFRESH_LIMIT = 3;
const ANTHROPIC_CACHE_REFRESH_STATE_KEY = "anthropic-cache-refresh";

interface AnthropicCacheRefreshPlan {
	refresh(controller: AbortController): Promise<number | undefined>;
}

class AnthropicCacheRefreshState implements ProviderSessionState {
	#controller: AbortController | undefined;
	#generation = 0;
	#plan: AnthropicCacheRefreshPlan | undefined;
	#refreshesRemaining = 0;
	#timer: NodeJS.Timeout | undefined;

	cancel(): void {
		this.#generation++;
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#controller?.abort();
		this.#controller = undefined;
		this.#plan = undefined;
		this.#refreshesRemaining = 0;
	}

	arm(plan: AnthropicCacheRefreshPlan, cacheTouchedAtMs: number): void {
		this.cancel();
		this.#plan = plan;
		this.#refreshesRemaining = ANTHROPIC_CACHE_REFRESH_LIMIT;
		this.#schedule(cacheTouchedAtMs, this.#generation);
	}

	close(): void {
		this.cancel();
	}

	#schedule(cacheTouchedAtMs: number, generation: number): void {
		const refreshAtMs = cacheTouchedAtMs + ANTHROPIC_CACHE_TTL_MS - ANTHROPIC_CACHE_REFRESH_LEAD_MS;
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				void this.#refresh(generation);
			},
			Math.max(0, refreshAtMs - Date.now()),
		);
		this.#timer.unref?.();
	}

	async #refresh(generation: number): Promise<void> {
		const plan = this.#plan;
		if (generation !== this.#generation || !plan || this.#refreshesRemaining <= 0) return;

		const controller = new AbortController();
		this.#controller = controller;
		let cacheTouchedAtMs: number | undefined;
		try {
			cacheTouchedAtMs = await plan.refresh(controller);
		} catch (error) {
			if (generation === this.#generation && !controller.signal.aborted) {
				logger.debug("Anthropic prompt-cache refresh failed", { error: String(error) });
			}
		}
		if (generation !== this.#generation) return;

		this.#controller = undefined;
		if (cacheTouchedAtMs === undefined) {
			this.#plan = undefined;
			this.#refreshesRemaining = 0;
			return;
		}

		this.#refreshesRemaining--;
		if (this.#refreshesRemaining <= 0) {
			this.#plan = undefined;
			return;
		}
		this.#schedule(cacheTouchedAtMs, generation);
	}
}

function supportsAnthropicCacheRefresh<TApi extends Api>(model: Model<TApi>): boolean {
	return (
		model.api === "anthropic-messages" &&
		model.provider === "anthropic" &&
		model.transport !== "pi-native" &&
		isLeakedThinkingHealExempt(model)
	);
}

function isAnthropicRefreshPayload(payload: unknown): payload is MessageCreateParamsStreaming {
	return (
		typeof payload === "object" &&
		payload !== null &&
		"messages" in payload &&
		Array.isArray(payload.messages) &&
		"max_tokens" in payload &&
		typeof payload.max_tokens === "number"
	);
}

function isShortAnthropicCacheControl(cacheControl: unknown): boolean {
	return (
		typeof cacheControl === "object" &&
		cacheControl !== null &&
		"type" in cacheControl &&
		cacheControl.type === "ephemeral" &&
		(!("ttl" in cacheControl) || cacheControl.ttl !== "1h")
	);
}

function hasShortAnthropicMessageBreakpoint(payload: MessageCreateParamsStreaming): boolean {
	for (const message of payload.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if ("cache_control" in block && isShortAnthropicCacheControl(block.cache_control)) return true;
		}
	}
	return false;
}

function isAnthropicGenerationEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
		case "image_end":
			return true;
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		default:
			return false;
	}
}

function isAnthropicThinkingActive(model: Model<Api>, payload: MessageCreateParamsStreaming): boolean {
	if (payload.thinking) return payload.thinking.type !== "disabled";
	return model.thinking?.mode === "anthropic-adaptive" && payload.output_config?.effort != null;
}

function createAnthropicCacheRefreshPlan<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	payload: MessageCreateParamsStreaming,
): AnthropicCacheRefreshPlan {
	const thinkingEnabled = isAnthropicThinkingActive(model, payload);
	return {
		async refresh(controller) {
			let cacheRead = 0;
			let cacheWrite = 0;
			let cacheTouchedAtMs: number | undefined;
			let canceledAfterGenerationStarted = false;
			const response = streamSimpleRequest(model, context, {
				...options,
				acceptEmptyResponse: true,
				anthropicCacheRefreshRequest: !thinkingEnabled,
				cacheRetention: "short",
				maxTokens: thinkingEnabled ? options?.maxTokens : 0,
				onPayload: () => ({
					...payload,
					max_tokens: thinkingEnabled ? payload.max_tokens : 0,
				}),
				onResponse: () => {
					cacheTouchedAtMs = Date.now();
				},
				onSseEvent: undefined,
				signal: controller.signal,
			});

			for await (const event of response) {
				if ("partial" in event) {
					cacheRead = event.partial.usage.cacheRead;
					cacheWrite = event.partial.usage.cacheWrite;
				}
				if (event.type === "error") return undefined;
				if (event.type === "done") {
					cacheRead = event.message.usage.cacheRead;
					cacheWrite = event.message.usage.cacheWrite;
					return cacheTouchedAtMs !== undefined && cacheRead > 0 && cacheWrite === 0
						? cacheTouchedAtMs
						: undefined;
				}
				if (thinkingEnabled && isAnthropicGenerationEvent(event)) {
					canceledAfterGenerationStarted = true;
					controller.abort();
					break;
				}
			}

			if (canceledAfterGenerationStarted) {
				try {
					await response.result();
				} catch (error) {
					if (!controller.signal.aborted) throw error;
				}
			}
			return cacheTouchedAtMs !== undefined && cacheRead > 0 && cacheWrite === 0 ? cacheTouchedAtMs : undefined;
		},
	};
}

function streamSimpleWithAnthropicCacheRefresh<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	const providerSessionState = options?.providerSessionState;
	if (!options?.anthropicCacheRefresh || !providerSessionState) {
		return streamSimpleRequest(model, context, options);
	}

	const existingState = providerSessionState.get(ANTHROPIC_CACHE_REFRESH_STATE_KEY);
	if (existingState instanceof AnthropicCacheRefreshState) {
		existingState.cancel();
	} else if (existingState) {
		return streamSimpleRequest(model, context, options);
	}
	if (!supportsAnthropicCacheRefresh(model) || resolveCacheRetention(options.cacheRetention) !== "short") {
		return streamSimpleRequest(model, context, options);
	}

	const refreshState = existingState ?? new AnthropicCacheRefreshState();
	if (!existingState) providerSessionState.set(ANTHROPIC_CACHE_REFRESH_STATE_KEY, refreshState);

	let cacheTouchedAtMs: number | undefined;
	let capturedPayload: MessageCreateParamsStreaming | undefined;
	const inner = streamSimpleRequest(model, context, {
		...options,
		onPayload: async (payload, payloadModel) => {
			const replacement = await options?.onPayload?.(payload, payloadModel);
			const finalPayload = replacement ?? payload;
			if (isAnthropicRefreshPayload(finalPayload)) capturedPayload = finalPayload;
			return replacement;
		},
		onResponse: async (response, responseModel) => {
			cacheTouchedAtMs = Date.now();
			await options?.onResponse?.(response, responseModel);
		},
	});
	const outer = new AssistantMessageEventStream();
	const armRefresh = (message: AssistantMessage): void => {
		if (
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			message.usage.cacheRead + message.usage.cacheWrite <= 0 ||
			cacheTouchedAtMs === undefined ||
			capturedPayload === undefined ||
			!hasShortAnthropicMessageBreakpoint(capturedPayload)
		) {
			return;
		}
		refreshState.arm(createAnthropicCacheRefreshPlan(model, context, options, capturedPayload), cacheTouchedAtMs);
	};

	void (async () => {
		try {
			for await (const event of inner) {
				if (event.type === "done") armRefresh(event.message);
				outer.push(event);
				if (outer.done) return;
			}
			if (!outer.done) {
				const result = await inner.result();
				armRefresh(result);
				outer.end(result);
			}
		} catch (error) {
			outer.fail(error);
		}
	})();
	return outer;
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	if (!model.requiresGlyphTokenization) {
		return streamSimpleWithAnthropicCacheRefresh(model, context, options);
	}
	const codec = applyGlyphCodec(context);
	const execHandlers = options?.cursorExecHandlers ?? options?.execHandlers;
	const wrappedExecHandlers = execHandlers === undefined ? undefined : codec.wrapCursorExecHandlers(execHandlers);
	const wireOptions =
		wrappedExecHandlers === undefined
			? options
			: {
					...options,
					execHandlers: wrappedExecHandlers,
					cursorExecHandlers: wrappedExecHandlers,
				};
	return codec.wrap(streamSimpleWithAnthropicCacheRefresh(model, codec.context, wireOptions));
}

function streamSimpleRequest<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const inputOptions = (options || {}) as SimpleStreamOptions;
	const baseOptions = { ...inputOptions, fetch: inputOptions.fetch ?? defaultFetchForModel(model) };
	const debugOptions = withExtraCaFetch(withRequestDebugFetch(baseOptions));
	const requestOptions = {
		...debugOptions,
		fetch: wrapFetchForProxy(debugOptions.fetch, model.provider),
	} as SimpleStreamOptions;

	const apiKeyResolver = isApiKeyResolver(requestOptions?.apiKey) ? requestOptions.apiKey : undefined;
	if (apiKeyResolver) {
		const outer = new AssistantMessageEventStream();
		const signal = requestOptions?.signal;

		const runAttempt = async (apiKey?: string): Promise<AuthRetryFailure | undefined> => {
			const bufferedEvents: AssistantMessageEvent[] = [];
			let emittedReplayUnsafeEvent = false;
			const flushBuffered = (): void => {
				emitBufferedEvents(outer, bufferedEvents);
				bufferedEvents.length = 0;
			};

			try {
				const attemptOptions = { ...requestOptions, apiKey };
				const inner = streamSimpleRequest(model, context, attemptOptions);
				for await (const event of inner) {
					if (!emittedReplayUnsafeEvent && event.type === "start") {
						bufferedEvents.push(event);
						continue;
					}
					if (
						!emittedReplayUnsafeEvent &&
						event.type === "error" &&
						isRetryableUpstreamError(
							model,
							event.error,
							extractStatusFromAssistantError(event.error),
							event.error.errorMessage,
						)
					) {
						return {
							error: contextualizeAuthRetryError(model, createAssistantAuthError(event.error)),
							bufferedEvents,
							terminalEvent: event,
						};
					}
					flushBuffered();
					emittedReplayUnsafeEvent = true;
					outer.push(event);
					if (outer.done) return undefined;
				}
				flushBuffered();
				if (!outer.done) outer.end(await inner.result());
			} catch (error) {
				if (
					!emittedReplayUnsafeEvent &&
					isRetryableUpstreamError(
						model,
						error,
						AIError.status(error),
						error instanceof Error ? error.message : undefined,
					)
				) {
					return { error: contextualizeAuthRetryError(model, error), bufferedEvents };
				}
				flushBuffered();
				outer.fail(error);
			}
			return undefined;
		};
		const emitFailure = (failure: AuthRetryFailure): void => {
			emitBufferedEvents(outer, failure.bufferedEvents);
			if (failure.terminalEvent) {
				outer.push(failure.terminalEvent);
			} else {
				outer.fail(failure.error);
			}
		};

		void (async () => {
			let lastKey: string | undefined;
			try {
				lastKey = (await apiKeyResolver({ lastChance: false, error: undefined, signal })) || undefined;
			} catch (error) {
				outer.fail(
					new AIError.ConfigurationError(
						`Failed to resolve API key for provider ${model.provider}: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					),
				);
				return;
			}
			if (lastKey === undefined) {
				if (getProviderDefinition(model.provider)?.allowsMissingApiKey) {
					const failure = await runAttempt();
					if (failure) emitFailure(failure);
					return;
				}
				outer.fail(new AIError.MissingApiKeyError(model.provider));
				return;
			}
			const retryState = createAuthRetryKeyState(lastKey);
			let failure = await runAttempt(lastKey);
			if (!failure) return;
			while (true) {
				if (signal?.aborted) break;
				const nextKey = await resolveNextAuthRetryKey(retryState, apiKeyResolver, failure.error, signal);
				if (nextKey === undefined) break;
				const next = await runAttempt(nextKey);
				if (!next) return;
				failure = next;
			}
			emitFailure(failure);
		})();
		return outer;
	}

	if (model.transport === "pi-native") {
		return withThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () => streamPiNative(model, context, opts)),
		);
	}

	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return withThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () => customApiProvider.streamSimple(model, context, opts)),
		);
	}

	if (model.api === "google-vertex") {
		const providerOptions = mapOptionsForApi(model, requestOptions, undefined);
		return stream(model, context, providerOptions);
	} else if (model.api === "bedrock-converse-stream") {
		const providerOptions = mapOptionsForApi(model, requestOptions, undefined);
		return stream(model, context, providerOptions);
	} else if (getProviderDefinition(model.provider)?.allowsMissingApiKey) {
		const providerOptions = mapOptionsForApi(
			model,
			requestOptions,
			typeof requestOptions.apiKey === "string" ? requestOptions.apiKey : getEnvApiKey(model.provider),
		);
		return stream(model, context, providerOptions);
	}

	const apiKey =
		(typeof requestOptions?.apiKey === "string" ? requestOptions.apiKey : undefined) || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}

	if (isGitLabDuoModel(model)) {
		return withThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () =>
				streamGitLabDuo(model, context, {
					...opts,
					apiKey,
				}),
			),
		);
	}

	if (model.api === "gitlab-duo-agent") {
		return withThinkingLoopGuard(model, requestOptions, opts =>
			healLeakedThinking(
				model,
				streamGitLabDuoWorkflow(model as Model<"gitlab-duo-agent">, context, {
					...opts,
					apiKey,
				}),
			),
		);
	}

	if (isKimiModel(model)) {
		const kimiOptions = normalizeMandatoryReasoningOptions(model, requestOptions);
		return withThinkingLoopGuard(model, kimiOptions, opts =>
			withProviderInFlightLimit(model, opts, () =>
				streamKimi(model as Model<"openai-completions">, context, {
					...opts,
					apiKey,
					format: opts?.kimiApiFormat,
				}),
			),
		);
	}

	if (isSyntheticModel(model)) {
		return withThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () =>
				streamSynthetic(model as Model<"openai-completions">, context, {
					...opts,
					apiKey,
					format: opts?.syntheticApiFormat ?? "openai",
				}),
			),
		);
	}
	const providerOptions = mapOptionsForApi(model, requestOptions, apiKey);
	return stream(model, context, providerOptions);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return resolveWithThinkingLoopRetries(options?.signal, () => streamSimple(model, context, options));
}

const MIN_OUTPUT_TOKENS = 1024;

const OUTPUT_CAP_WHEN_UNKNOWN = 64_000;
function maxTokensWithThinkingBudget(
	baseMaxTokens: number | undefined,
	modelMaxTokens: number | null,
	thinkingBudget: number,
): number {
	const uncappedMaxTokens = baseMaxTokens === undefined ? OUTPUT_CAP_WHEN_UNKNOWN : baseMaxTokens + thinkingBudget;
	return Math.min(uncappedMaxTokens, modelMaxTokens ?? Number.POSITIVE_INFINITY);
}
export const OUTPUT_FALLBACK_BUFFER = 4000;
const ANTHROPIC_USE_INTERLEAVED_THINKING = Bun.env.PI_NO_INTERLEAVED_THINKING !== "1";

export const ANTHROPIC_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 32768,
};

const GOOGLE_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 24575,
	max: 32768,
};

const BEDROCK_CLAUDE_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
	max: 32768,
};

function resolveBedrockThinkingBudget(
	model: Model<"bedrock-converse-stream">,
	options?: SimpleStreamOptions,
): { budget: number; level: Effort } | null {
	if (!options?.reasoning || !model.reasoning) return null;
	const level = requireSupportedEffort(model, options.reasoning);
	const budget = options.thinkingBudgets?.[level] ?? BEDROCK_CLAUDE_THINKING[level];
	return { budget, level };
}

export function mapAnthropicToolChoice(choice?: ToolChoice): AnthropicOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "tool", name: choice.name } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "tool", name } : undefined;
	}
	return undefined;
}

export function mapGoogleToolChoice(
	choice?: ToolChoice,
): GoogleOptions["toolChoice"] | GoogleGeminiCliOptions["toolChoice"] | GoogleVertexOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}

	if (choice.type === "tool") {
		return choice.name ? { mode: "ANY", allowedFunctionNames: [choice.name] } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { mode: "ANY", allowedFunctionNames: [name] } : undefined;
	}
	return undefined;
}

function mapOpenAiToolChoice(choice?: ToolChoice): OpenAICompletionsOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "function", function: { name } } : undefined;
	}
	return undefined;
}

type ReasoningEffortMapCompat = {
	reasoningEffortMap?: Partial<Record<Effort, string>>;
};

function getCompatReasoningEffortMap<TApi extends Api>(
	model: Model<TApi>,
): Partial<Record<Effort, string>> | undefined {
	const compat = model.compat;
	if (compat === undefined || typeof compat !== "object" || !("reasoningEffortMap" in compat)) {
		return undefined;
	}
	return (compat as ReasoningEffortMapCompat).reasoningEffortMap;
}

function resolveSupportedMappedReasoningEffort<TApi extends Api>(
	model: Model<TApi>,
	reasoning: Effort,
): Effort | undefined {
	const mapped = getCompatReasoningEffortMap(model)?.[reasoning];
	if (!mapped) return undefined;
	const mappedEffort = mapped as Effort;
	return model.thinking?.efforts.includes(mappedEffort) ? mappedEffort : undefined;
}

function resolveOpenAiReasoningEffort<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): Effort | undefined {
	const reasoning = options?.reasoning;
	if (!reasoning || !model.reasoning) return undefined;

	if (!model.thinking) return undefined;
	if (model.thinking.efforts.includes(reasoning)) return reasoning;
	const mappedReasoning = resolveSupportedMappedReasoningEffort(model, reasoning);
	if (mappedReasoning) return mappedReasoning;
	if (getCompatReasoningEffortMap(model)?.[reasoning] !== undefined) return reasoning;
	if (model.thinking.effortMap?.[reasoning] !== undefined) return reasoning;
	return requireSupportedEffort(model, reasoning);
}

function resolveGoogleThinkingOff<TApi extends Api>(model: Model<TApi>): NonNullable<GoogleOptions["thinking"]> {
	const thinking: NonNullable<GoogleOptions["thinking"]> = { enabled: false };
	if (!model.reasoning || !model.thinking) return thinking;
	if (model.thinking.mode === "budget" && (!model.thinking.requiresEffort || model.thinking.suppressWhenOff)) {
		thinking.budgetTokens = 0;
	} else if (model.thinking.mode === "google-level" && model.thinking.suppressWhenOff) {
		thinking.level = "MINIMAL";
	}
	return thinking;
}

const castApi = <TApi extends Api>(api: OptionsForApi<TApi>): OptionsForApi<Api> => api as OptionsForApi<Api>;

function normalizeMandatoryReasoningOptions<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): SimpleStreamOptions | undefined {
	if (
		!model.reasoning ||
		!model.thinking?.requiresEffort ||
		model.thinking.suppressWhenOff ||
		(options?.reasoning !== undefined && !options.disableReasoning && !options.forceReasoningOff)
	) {
		return options;
	}
	const floor = minimumSupportedEffort(model);
	if (floor === undefined) return options;
	return { ...options, reasoning: floor, disableReasoning: undefined, forceReasoningOff: undefined };
}

function supportsExplicitOpenAIResponsesPromptCache(compat: unknown): boolean {
	return (
		typeof compat === "object" &&
		compat !== null &&
		"supportsPromptCacheBreakpoints" in compat &&
		compat.supportsPromptCacheBreakpoints === true
	);
}

function isOpenAIResponsesPromptCacheSurface<TApi extends Api>(model: Model<TApi>): boolean {
	return (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		(model.api === "openrouter" && $env.PI_OPENROUTER_RESPONSES !== "0")
	);
}

function assertExplicitOpenAIResponsesPromptCacheSupport<TApi extends Api>(
	model: Model<TApi>,
	options?: StreamOptions,
): void {
	if (
		model.transport === "pi-native" ||
		resolveCacheRetention(options?.cacheRetention) === "none" ||
		options?.promptCache?.mode !== "explicit" ||
		!isOpenAIResponsesPromptCacheSurface(model) ||
		supportsExplicitOpenAIResponsesPromptCache(model.compat)
	) {
		return;
	}
	throw new AIError.ConfigurationError(
		`OpenAI explicit prompt caching is unsupported for ${model.provider}/${model.id}; enable compat.supportsPromptCacheBreakpoints only for a compatible endpoint.`,
	);
}

function mapOptionsForApi<TApi extends Api>(
	model: Model<TApi>,
	rawOptions?: SimpleStreamOptions,
	apiKey?: string,
): OptionsForApi<TApi> {
	const options = normalizeMandatoryReasoningOptions(model, rawOptions);
	const simpleProviderOptions = getProviderDefinition(model.provider)?.mapSimpleOptions?.(options ?? {});
	const base = {
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		minP: options?.minP,
		presencePenalty: options?.presencePenalty,
		repetitionPenalty: options?.repetitionPenalty,
		maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
		signal: options?.signal,
		apiKey: apiKey ?? (typeof options?.apiKey === "string" ? options.apiKey : undefined),
		cacheRetention: options?.cacheRetention,
		headers: options?.headers,
		initiatorOverride: options?.initiatorOverride,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		taskBudget: options?.taskBudget,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: options?.streamIdleTimeoutMs,
		codexSseMaxAttempts: options?.codexSseMaxAttempts,
		providerSessionState: options?.providerSessionState,
		maxInFlightRequests: options?.maxInFlightRequests,
		toolNamespacesInfo: options?.toolNamespacesInfo,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onSseEvent: options?.onSseEvent,
		execHandlers: options?.execHandlers,
		fetch: options?.fetch,
		fallbacks: options?.fallbacks,
		acceptEmptyResponse: options?.acceptEmptyResponse,
		anthropicCacheRefreshRequest: options?.anthropicCacheRefreshRequest,
		...simpleProviderOptions,
	};

	switch (model.api) {
		case "anthropic-messages": {
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning || options?.disableReasoning || options?.forceReasoningOff) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			let thinkingBudget = options.thinkingBudgets?.[reasoning] ?? ANTHROPIC_THINKING[reasoning];
			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			const thinkingMode = model.thinking?.mode;
			const effort =
				thinkingMode === "anthropic-adaptive" || thinkingMode === "anthropic-budget-effort"
					? mapEffortToAnthropicAdaptiveEffort(model, reasoning)
					: undefined;

			if (thinkingMode === "anthropic-adaptive") {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			if (ANTHROPIC_USE_INTERLEAVED_THINKING) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

			if (maxTokens <= thinkingBudget) {
				thinkingBudget = maxTokens - MIN_OUTPUT_TOKENS;
			}

			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			} else {
				return castApi<"anthropic-messages">({
					...base,
					maxTokens,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}
		}

		case "bedrock-converse-stream": {
			const bedrockBase: BedrockOptions = {
				...base,
				reasoning: options?.reasoning,
				thinkingBudgets: options?.thinkingBudgets,
				toolChoice: mapAnthropicToolChoice(options?.toolChoice),
				thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
			};

			if (model.thinking?.mode === "anthropic-adaptive") {
				return castApi<"bedrock-converse-stream">(bedrockBase);
			}
			const budgetInfo = resolveBedrockThinkingBudget(model as Model<"bedrock-converse-stream">, options);
			if (!budgetInfo) return bedrockBase as OptionsForApi<TApi>;
			let maxTokens = bedrockBase.maxTokens ?? model.maxTokens ?? OUTPUT_CAP_WHEN_UNKNOWN;
			let thinkingBudgets = bedrockBase.thinkingBudgets;
			if (maxTokens <= budgetInfo.budget) {
				const desiredMaxTokens = Math.min(
					model.maxTokens ?? Number.POSITIVE_INFINITY,
					budgetInfo.budget + MIN_OUTPUT_TOKENS,
				);
				if (desiredMaxTokens > maxTokens) {
					maxTokens = desiredMaxTokens;
				}
			}
			if (maxTokens <= budgetInfo.budget) {
				const adjustedBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
				thinkingBudgets = { ...(thinkingBudgets ?? {}), [budgetInfo.level]: adjustedBudget };
			}
			return castApi<"bedrock-converse-stream">({ ...bedrockBase, maxTokens, thinkingBudgets });
		}

		case "openrouter": {
			const useResponses = $env.PI_OPENROUTER_RESPONSES !== "0";
			if (useResponses) {
				return castApi<"openai-responses">({
					...base,
					reasoning: resolveOpenAiReasoningEffort(model, options),
					toolChoice: mapOpenAiToolChoice(options?.toolChoice),
					serviceTier: options?.serviceTier,
					reasoningSummary: options?.hideThinkingSummary ? null : undefined,
					openrouterVariant: options?.openrouterVariant,
					maxTokensExplicit: rawOptions?.maxTokens !== undefined,
					disableReasoning: options?.disableReasoning,
					textVerbosity: options?.textVerbosity,
					promptCache: options?.promptCache,
					statefulResponses: options?.statefulResponses,
				});
			}
			return castApi<"openai-completions">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
				promptCache: options?.promptCache,
			});
		}

		case "openai-completions":
			return castApi<"openai-completions">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
				promptCache: options?.promptCache,
			});

		case "openai-responses":
			return castApi<"openai-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
				disableReasoning: options?.disableReasoning,
				forceReasoningOff: options?.forceReasoningOff,
				textVerbosity: options?.textVerbosity,
				promptCache: options?.promptCache,
				statefulResponses: options?.statefulResponses,
			});

		case "azure-openai-responses":
			return castApi<"azure-openai-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
				promptCache: options?.promptCache,
				statefulResponses: options?.statefulResponses,
				disableReasoning: options?.disableReasoning || options?.forceReasoningOff,
				forceReasoningOff: options?.forceReasoningOff,
			});

		case "openai-codex-responses":
			return castApi<"openai-codex-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				preferWebsockets: options?.preferWebsockets,
				codexCompaction: options?.codexCompaction,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
				textVerbosity: options?.textVerbosity,
				forceReasoningOff: options?.forceReasoningOff,
			});

		case "google-generative-ai": {
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning || options?.disableReasoning || options?.forceReasoningOff) {
				return castApi<"google-generative-ai">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: resolveGoogleThinkingOff(model),
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
					cachedContent: options?.cachedContent,
				});
			}

			const googleModel = model as Model<"google-generative-ai">;
			const effort = requireSupportedEffort(googleModel, reasoning);

			if (googleModel.thinking?.mode === "google-level") {
				return castApi<"google-generative-ai">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(effort, googleModel),
					},
					hideThinkingSummary: options?.hideThinkingSummary,
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
					cachedContent: options?.cachedContent,
				});
			}

			return castApi<"google-generative-ai">({
				...base,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(googleModel, effort, options?.thinkingBudgets),
				},
				hideThinkingSummary: options?.hideThinkingSummary,
				toolChoice: mapGoogleToolChoice(options?.toolChoice),
				cachedContent: options?.cachedContent,
			});
		}

		case "google-gemini-cli": {
			const reasoning = options?.reasoning;
			const toolChoice = mapGoogleToolChoice(options?.toolChoice);
			if (reasoning && model.reasoning && !options?.disableReasoning && !options?.forceReasoningOff) {
				const effort = requireSupportedEffort(model, reasoning);

				if (model.thinking?.mode === "google-level") {
					return castApi<"google-gemini-cli">({
						...base,
						requestModelId: resolveWireModelId(model, effort),
						thinking: {
							enabled: true,
							level: mapEffortToGoogleThinkingLevel(effort, model),
						},
						hideThinkingSummary: options?.hideThinkingSummary,
						toolChoice,
						antigravityEndpointMode: options?.antigravityEndpointMode,
					});
				}

				let thinkingBudget =
					options.thinkingBudgets?.[effort] ?? model.thinking?.effortBudgets?.[effort] ?? GOOGLE_THINKING[effort];

				const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

				if (maxTokens <= thinkingBudget) {
					thinkingBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
				}

				if (thinkingBudget > 0) {
					return castApi<"google-gemini-cli">({
						...base,
						maxTokens,
						requestModelId: resolveWireModelId(model, effort),
						thinking: { enabled: true, budgetTokens: thinkingBudget },
						hideThinkingSummary: options?.hideThinkingSummary,
						toolChoice,
						antigravityEndpointMode: options?.antigravityEndpointMode,
					});
				}
			}

			const thinking: GoogleGeminiCliOptions["thinking"] = { enabled: false };
			if (model.reasoning && model.thinking?.suppressWhenOff) {
				thinking.suppress = model.thinking.mode === "google-level" ? { level: "MINIMAL" } : { budget: 0 };
			}
			return castApi<"google-gemini-cli">({
				...base,
				requestModelId: resolveWireModelId(model, undefined),
				thinking,
				toolChoice,
				antigravityEndpointMode: options?.antigravityEndpointMode,
			});
		}

		case "google-vertex": {
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning || options?.disableReasoning || options?.forceReasoningOff) {
				return castApi<"google-vertex">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: resolveGoogleThinkingOff(model),
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
					cachedContent: options?.cachedContent,
				});
			}

			const vertexModel = model as Model<"google-vertex">;
			const effort = requireSupportedEffort(vertexModel, reasoning);
			const geminiModel = vertexModel as unknown as Model<"google-generative-ai">;

			if (geminiModel.thinking?.mode === "google-level") {
				return castApi<"google-vertex">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(effort, model),
					},
					hideThinkingSummary: options?.hideThinkingSummary,
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
					cachedContent: options?.cachedContent,
				});
			}

			return castApi<"google-vertex">({
				...base,
				serviceTier: options?.serviceTier,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(geminiModel, effort, options?.thinkingBudgets),
				},
				hideThinkingSummary: options?.hideThinkingSummary,
				toolChoice: mapGoogleToolChoice(options?.toolChoice),
				cachedContent: options?.cachedContent,
			});
		}

		case "ollama-chat":
			return castApi<"ollama-chat">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: options?.toolChoice,
			});

		case "cursor-agent": {
			const execHandlers = options?.cursorExecHandlers ?? options?.execHandlers;
			const onToolResult = options?.cursorOnToolResult ?? execHandlers?.onToolResult;
			const cursorModel = model as Model<"cursor-agent">;
			const effort =
				options?.reasoning && !options.disableReasoning && !options.forceReasoningOff && cursorModel.reasoning
					? requireSupportedEffort(cursorModel, options.reasoning)
					: undefined;
			return castApi<"cursor-agent">({
				...base,
				execHandlers,
				onToolResult,
				wireModelId: resolveWireModelId(cursorModel, effort),
			});
		}

		case "gitlab-duo-agent":
			return castApi<"gitlab-duo-agent">({
				...base,
				cwd: options?.cwd,
				toolChoice: options?.toolChoice,
			});
		case "devin-agent": {
			const devinModel = model as Model<"devin-agent">;
			const effort =
				options?.reasoning && !options.disableReasoning
					? requireSupportedEffort(devinModel, options.reasoning)
					: undefined;
			return castApi<"devin-agent">({
				...base,
				chatModelUid: resolveWireModelId(devinModel, effort),
			});
		}
		default:
			throw new AIError.ConfigurationError(`Unhandled API in mapOptionsForApi: ${model.api}`);
	}
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	effort: Effort,
	customBudgets?: ThinkingBudgets,
): number {
	requireSupportedEffort(model, effort);

	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	if (model.id.includes("2.5-")) {
		switch (effort) {
			case "minimal":
				return 128;
			case "low":
				return 2048;
			case "medium":
				return 8192;
			case "high":
			case "xhigh":
			case "max":
				return model.id.includes("2.5-flash") ? 24576 : 32768;
		}
	}

	return -1;
}
