import * as path from "node:path";
import { isCompiledBinary, logger, untilAborted, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { Browser, CDPSession } from "puppeteer-core";
import { ToolAbortError, ToolError } from "../tool-errors";
import { findFreeCdpPort, findReusableCdp, gracefulKillTreeOnce, resolveSpawnArgs, waitForCdp } from "./attach";
import type { CmuxKind } from "./cmux/rpc";
import { CmuxSocketClient } from "./cmux/socket-client";
import {
	BROWSER_PROTOCOL_TIMEOUT_MS,
	closeLaunchedBrowser,
	connectPuppeteer,
	DEFAULT_VIEWPORT,
	launchHeadlessBrowser,
	loadPuppeteer,
	removeUserDataDir,
	type UserAgentOverride,
} from "./launch";
import { reapOrphanSharedTargets } from "./orphan-registry";
import { ensureRelayDaemon, isLoopbackRelayUrl, restartRelayDaemon } from "./relay/daemon";
import type { RelayKind } from "./relay/kind";
import { UPDATE_RELAY_EXTENSION, waitForRelayExtension } from "./relay/probe";
import { ensureSharedBrowser } from "./shared-daemon";

type PuppeteerBrowserKind =
	| { kind: "headless"; headless: boolean }
	| { kind: "spawned"; path: string; args?: string[] }
	| { kind: "connected"; cdpUrl: string }
	| RelayKind;

export type BrowserKind = PuppeteerBrowserKind | CmuxKind;

export type BrowserKindTag = BrowserKind["kind"];

interface BrowserHandleCommon {
	key: string;
	kind: BrowserKind;
	refCount: number;
}

export interface PuppeteerBrowserHandle extends BrowserHandleCommon {
	kind: PuppeteerBrowserKind;
	browser: Browser;
	/** Browser-level WebSocket endpoint tab workers attach through. */
	wsEndpoint: string;
	cdpUrl?: string;
	pid?: number;

	userDataDir?: string;

	sharedDaemon?: { name: string; projectDir: string };
	subprocess?: Subprocess;
	stealth: { browserSession: CDPSession | null; override: UserAgentOverride | null };
}

export interface CmuxBrowserHandle extends BrowserHandleCommon {
	kind: CmuxKind;
	client: CmuxSocketClient;
	surface?: string;
}

export type BrowserHandle = PuppeteerBrowserHandle | CmuxBrowserHandle;

interface ReleaseBrowserOptions {
	kill: boolean;
	timeoutMs?: number;
	resource?: string;
}

const browsers = new Map<string, BrowserHandle>();

const pendingOpens = new Map<string, { settled: Promise<void> }>();

export function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless:${kind.headless ? "1" : "0"}`;
		case "spawned":
			return `spawned:${JSON.stringify([kind.path, kind.args ?? []])}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.socketPath}`;
	}
}

interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	signal?: AbortSignal;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "spawned") kind = { ...kind, args: resolveSpawnArgs(kind.path, kind.args, opts.cwd) };
	const key = browserKey(kind);
	for (;;) {
		const existing = browsers.get(key);
		if (existing) {
			if ("client" in existing) return existing;
			if (existing.browser.connected) return existing;
			browsers.delete(key);
			await disposeBrowserHandle(existing, { kill: false });
			continue;
		}

		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");

		const pending = pendingOpens.get(key);
		if (pending) {
			await untilAborted(opts.signal, () => pending.settled);
			continue;
		}
		const open = openBrowserHandle(kind, opts);
		const settled = Promise.withResolvers<void>();
		const entry = { settled: settled.promise };
		// A cancelled app launch keeps its key until disposal kills the app, so a
		// replacement cannot adopt an endpoint that cleanup is about to destroy.
		const clearEntry = (): void => {
			opts.signal?.removeEventListener("abort", clearEntry);
			if (pendingOpens.get(key) === entry) pendingOpens.delete(key);
			settled.resolve();
		};
		if (kind.kind !== "spawned") opts.signal?.addEventListener("abort", clearEntry, { once: true });
		pendingOpens.set(key, entry);
		let handle: BrowserHandle;
		try {
			handle = await open;
		} catch (error) {
			clearEntry();
			throw error;
		}

		if (opts.signal?.aborted) {
			await disposeBrowserHandle(handle, { kill: kind.kind === "spawned" }).catch(err => {
				logger.debug("Failed to dispose orphan browser after abort", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
			clearEntry();
			throw new ToolAbortError("Browser open aborted");
		}
		browsers.set(key, handle);
		clearEntry();
		return handle;
	}
}

export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
	const cdpUrl = rawCdpUrl.replace(/\/+$/, "");
	if (/^wss?:\/\//i.test(cdpUrl)) {
		throw new ToolError(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.",
		);
	}
	return cdpUrl;
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "cmux") {
		const client = new CmuxSocketClient({ socketPath: kind.socketPath, password: kind.password });
		await client.connect();
		return {
			key: browserKey(kind),
			kind,
			client,
			surface: kind.surface,
			refCount: 0,
		};
	}
	if (kind.kind === "headless") {
		if (isCompiledBinary() || workerHostEntry() !== null) {
			return await openSharedHeadlessHandle(kind, opts);
		}
		const { browser, wsEndpoint, userDataDir } = await launchHeadlessBrowser({
			headless: kind.headless,
			viewport: opts.viewport,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			wsEndpoint,
			userDataDir,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "connected") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		await waitForCdp(cdpUrl, 5_000, opts.signal);
		const puppeteer = await loadPuppeteer();
		const browser = await connectPuppeteer(puppeteer, {
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			wsEndpoint: browser.wsEndpoint(),
			cdpUrl,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "relay") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);

		const autoStart = isLoopbackRelayUrl(cdpUrl) && (isCompiledBinary() || workerHostEntry() !== null);
		if (autoStart) await ensureRelayDaemon({ cdpUrl, signal: opts.signal });
		let outcome = await waitForRelayExtension(cdpUrl, opts.signal);
		if (outcome === "outdated-relay" && autoStart && (await restartRelayDaemon({ cdpUrl, signal: opts.signal }))) {
			outcome = await waitForRelayExtension(cdpUrl, opts.signal);
		} else if (outcome === "idle-older-relay" && autoStart) {
			await restartRelayDaemon({ cdpUrl, signal: opts.signal, idleOnly: true });
			outcome = await waitForRelayExtension(cdpUrl, opts.signal);
		}
		switch (outcome) {
			case "unreachable":
				throw new ToolError(
					`proto browser relay is not reachable at ${cdpUrl}. Start it with \`proto browser-relay\` and load the PROTO Browser Relay extension in Chrome.`,
				);
			case "no-extension":
				throw new ToolError(
					`proto browser relay is serving at ${cdpUrl}, but its extension never connected. Install it with \`proto browser-relay install\` and check its toolbar badge shows "on".`,
				);
			case "extension-gone":
				throw new ToolError(
					`proto browser relay at ${cdpUrl} lost its extension. Open Chrome with the PROTO Browser Relay extension and check its toolbar badge shows "on".`,
				);
			case "outdated-relay":
				throw new ToolError(
					`The browser relay at ${cdpUrl} is out of date. Restart it under this proto version, then retry.`,
				);
			case "outdated-extension":
				throw new ToolError(`The PROTO Browser Relay extension is out of date. ${UPDATE_RELAY_EXTENSION}`);
		}
		const puppeteer = await loadPuppeteer();
		const browser = await connectPuppeteer(puppeteer, {
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			wsEndpoint: browser.wsEndpoint(),
			cdpUrl,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}

	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app.path must be absolute (got ${JSON.stringify(exe)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`,
		);
	}
	const appArgs = kind.args ?? [];
	const reused = await findReusableCdp(exe, { signal: opts.signal, appArgs });
	let cdpUrl: string;
	let pid: number;
	let subprocess: Subprocess | undefined;
	if (reused) {
		logger.debug("Reusing existing CDP endpoint for attach", { exe, pid: reused.pid, cdpUrl: reused.cdpUrl });
		cdpUrl = reused.cdpUrl;
		pid = reused.pid;
	} else {
		const port = await findFreeCdpPort();
		const launchArgs = [...appArgs, `--remote-debugging-port=${port}`];
		const child = Bun.spawn([exe, ...launchArgs], {
			cwd: opts.cwd,
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		subprocess = child;
		pid = child.pid;
		cdpUrl = `http://127.0.0.1:${port}`;
		try {
			await waitForCdp(cdpUrl, 30_000, opts.signal);
		} catch (err) {
			await gracefulKillTreeOnce(child.pid).catch(() => undefined);
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(`Failed to attach to ${path.basename(exe)} on ${cdpUrl}: ${(err as Error).message}`);
		}
	}

	const puppeteer = await loadPuppeteer();
	let browser: Browser;
	try {
		browser = await connectPuppeteer(puppeteer, {
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
	} catch (err) {
		if (subprocess) await gracefulKillTreeOnce(subprocess.pid);
		throw new ToolError(`Connected to ${cdpUrl} but puppeteer.connect failed: ${(err as Error).message}`);
	}
	return {
		key: browserKey(kind),
		kind,
		browser,
		wsEndpoint: browser.wsEndpoint(),
		cdpUrl,
		pid,
		subprocess,
		refCount: 0,
		stealth: { browserSession: null, override: null },
	};
}

export function holdBrowser(handle: BrowserHandle): void {
	handle.refCount++;
}

export async function releaseBrowser(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	handle.refCount = Math.max(0, handle.refCount - 1);
	if (handle.refCount === 0) {
		if (browsers.get(handle.key) === handle) browsers.delete(handle.key);
		await disposeBrowserHandle(handle, opts);
	}
}

async function disposeBrowserHandle(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	if ("client" in handle) {
		handle.client.close();
		return;
	}
	if (handle.kind.kind === "headless") {
		if (handle.sharedDaemon) {
			if (handle.browser.connected) {
				try {
					handle.browser.disconnect();
				} catch (err) {
					logger.debug("Failed to disconnect from shared browser", { error: (err as Error).message });
				}
			}
			return;
		}
		if (handle.browser.connected) await closeLaunchedBrowser(handle.browser);

		if (handle.userDataDir) await removeUserDataDir(handle.userDataDir);
		return;
	}

	if (handle.kind.kind === "connected" || handle.kind.kind === "relay") {
		if (handle.browser.connected) {
			try {
				handle.browser.disconnect();
			} catch (err) {
				logger.debug("Failed to disconnect from remote browser", { error: (err as Error).message });
			}
		}
		return;
	}
	if (handle.browser.connected) {
		try {
			handle.browser.disconnect();
		} catch (err) {
			logger.debug("Failed to disconnect from spawned browser", { error: (err as Error).message });
		}
	}
	// A discovered CDP PID is borrowed, not ours to kill.
	if (opts.kill && handle.subprocess && handle.subprocess.exitCode === null) {
		await gracefulKillTreeOnce(handle.subprocess.pid);
	}
}

async function openSharedHeadlessHandle(
	kind: Extract<PuppeteerBrowserKind, { kind: "headless" }>,
	opts: AcquireBrowserOptions,
): Promise<PuppeteerBrowserHandle> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	try {
		const shared = await ensureSharedBrowser({
			projectDir: opts.cwd,
			headless: kind.headless,
			viewport: vp,
			signal: opts.signal,
		});
		if (!shared) {
			throw new ToolError(
				"Shared browser daemon unavailable (broker start or Chromium launch failed); check `hub ps` for proto.browser.* daemons and ~/.proto/logs for details",
			);
		}
		const puppeteer = await loadPuppeteer();
		const browser = await connectPuppeteer(puppeteer, {
			browserWSEndpoint: shared.wsEndpoint,
			defaultViewport: kind.headless
				? {
						width: vp.width,
						height: vp.height,
						deviceScaleFactor: vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
					}
				: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		// Sweep pages left by processes that died without teardown; detached so a slow reap never delays the open.
		void reapOrphanSharedTargets(browser, { projectDir: shared.projectDir, daemonName: shared.daemonName });
		return {
			key: browserKey(kind),
			kind,
			browser,
			wsEndpoint: shared.wsEndpoint,
			sharedDaemon: { name: shared.daemonName, projectDir: shared.projectDir },
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	} catch (err) {
		if (err instanceof ToolAbortError || err instanceof ToolError) throw err;
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");
		throw new ToolError(`Shared browser attach failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
