import {
	getProjectDir,
	getPuppeteerDir,
	logger,
	postmortem,
	Snowflake,
	untilAborted,
	withTimeout,
	workerHostEntry,
} from "@oh-my-pi/pi-utils";
import type { Page, Target } from "puppeteer-core";
import { callSessionTool } from "../../eval/js/tool-bridge";
import { webpExclusionForModel } from "../../utils/image-loading";
import type { ToolSession } from "../index";
import { expandPath } from "../path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
import { isChromiumBrowserExecutable, pickElectronTarget } from "./attach";
import type { CmuxTab } from "./cmux/cmux-tab";
import { mapWaitUntil } from "./cmux/rpc";
import { browserConnection, DEFAULT_VIEWPORT } from "./launch";
import {
	closeCdpTarget,
	closeRelayTarget,
	forgetSharedTarget,
	forgetSharedTargets,
	recordSharedTarget,
	type SharedTargetScope,
} from "./orphan-registry";
import {
	type BrowserHandle,
	type BrowserKindTag,
	type CmuxBrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "./registry";
import { stopSharedBrowserIfUnreachable } from "./shared-daemon";
import {
	type AttachPage,
	ownsPage,
	type ReadyInfo,
	type RunErrorPayload,
	type RunResultOk,
	type SessionSnapshot,
	type Transferable,
	type Transport,
	type WorkerInbound,
	type WorkerInitPayload,
	type WorkerOutbound,
} from "./tab-protocol";

interface WorkerHandle {
	send(msg: WorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	onExit(handler: (exitCode: number) => void): () => void;
	terminate(): Promise<void>;
	readonly mode: "worker" | "inline";
}

export type DialogPolicy = "accept" | "dismiss";

export interface PendingRun {
	resolve(result: RunResultOk): void;
	reject(error: unknown): void;
	session: ToolSession;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;

	closeAc?: AbortController;
}

interface TabSessionBase<TBrowser extends BrowserHandle = BrowserHandle> {
	name: string;
	browser: TBrowser;
	targetId: string;
	state: "alive" | "dead";
	info: ReadyInfo;
	pending: Map<string, PendingRun>;
	dialogPolicy?: DialogPolicy;
	kindTag: BrowserKindTag;

	ownerSessionId?: string;
}

interface WorkerTabSession extends TabSessionBase<PuppeteerBrowserHandle> {
	backend: "worker";
	worker: WorkerHandle;
	ownsPage: boolean;
	workerRecovery?: Promise<boolean>;
	workerExitedAt?: number;
	workerExitNotice?: string;
}

interface CmuxTabSession extends TabSessionBase<CmuxBrowserHandle> {
	backend: "cmux";
	cmuxTab: CmuxTab;
	cmuxOwnsSurface: boolean;
	cmuxAttachedSurface?: string;
}

type TabSession = WorkerTabSession | CmuxTabSession;

interface AcquireTabOptions {
	url?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	target?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	/** `performance.now()` when the caller's timeout budget started; earlier phases count against worker init. */
	deadlineStartMs?: number;
	dialogs?: DialogPolicy;
	cmuxSurface?: string;

	ownerSessionId?: string;
}

export interface AcquireTabResult {
	tab: TabSession;
	created: boolean;
	note?: string;
}

interface RunInTabOptions {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
}

interface ReleaseTabOptions {
	kill?: boolean;

	timeoutMs?: number;
}

const tabs = new Map<string, TabSession>();
// Page a headless worker created before dying during init; the supervisor closes it since a killed worker can't.
const workerPageTargets = new WeakMap<WorkerHandle, string>();

const acquireChains = new Map<string, Promise<void>>();
const GRACE_MS = 750;
// Cold-start guard for the worker `setup` handshake: min(cap, remaining/3), floored, so a stalled
// worker import leaves budget for the inline fallback.
const SETUP_BUDGET_FLOOR_MS = 2_000;
const SETUP_BUDGET_CAP_MS = 10_000;
const READY_BUDGET_FLOOR_MS = 500;

const killedTabs = new Map<string, string>();
const DEFAULT_TAB_CLOSE_TIMEOUT_MS = 5_000;
class RecoverableWorkerError extends ToolError {}
class RendererCrashedError extends ToolError {}
class NavigationTimeoutError extends ToolError {}
class DebuggerDetachedError extends ToolError {
	constructor(
		message: string,
		readonly when: "before-run" | "during-run",
		readonly reason: string,
	) {
		super(message);
	}
}
const REPORTED_INIT_FAILURE = Symbol("reported-init-failure");

type ReportedInitFailure = Error & { [REPORTED_INIT_FAILURE]?: true };

function markReportedInitFailure(error: Error): Error {
	(error as ReportedInitFailure)[REPORTED_INIT_FAILURE] = true;
	return error;
}

function isReportedInitFailure(error: unknown): boolean {
	return error instanceof Error && (error as ReportedInitFailure)[REPORTED_INIT_FAILURE] === true;
}

async function waitForTabCleanup<T>(
	tab: TabSession,
	timeoutMs: number,
	pendingResource: string,
	promise: Promise<T>,
): Promise<T> {
	const message = `Timed out after ${timeoutMs}ms closing ${tab.kindTag} browser tab ${JSON.stringify(tab.name)}; pending resource: ${pendingResource}`;
	try {
		return await withTimeout(promise, timeoutMs, message);
	} catch (error) {
		if (error instanceof Error && error.message === message) throw new ToolError(message);
		throw error;
	}
}

export function getTab(name: string): TabSession | undefined {
	return tabs.get(name);
}

export function acquireTab(name: string, browser: BrowserHandle, opts: AcquireTabOptions): Promise<AcquireTabResult> {
	// Acquisition-owned hold: the caller's timeout may drop its lease before init cleanup (worker kill, abandoned
	// page close) has been scheduled; cleanup through a disconnected handle would leak the worker's page.
	holdBrowser(browser);
	const prior = acquireChains.get(name) ?? Promise.resolve();
	const result = prior
		.then(() => acquireTabImpl(name, browser, opts))
		.then(
			async value => {
				await releaseBrowser(browser, { kill: false });
				return value;
			},
			async error => {
				await releaseBrowser(browser, { kill: false }).catch(() => undefined);
				throw error;
			},
		);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	acquireChains.set(name, tail);
	void tail.then(() => {
		if (acquireChains.get(name) === tail) acquireChains.delete(name);
	});
	return result;
}

async function acquireTabImpl(
	name: string,
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const startedAt = opts.deadlineStartMs ?? performance.now();
	if (opts.signal?.aborted) {
		throw new ToolAbortError("Browser tab open aborted");
	}
	killedTabs.delete(name);

	let tempHold = false;
	await waitForWorkerRecovery(name, opts.timeoutMs, opts.signal);
	const existing = tabs.get(name);
	if (existing) {
		if (existing.browser === browser && existing.state === "alive") {
			const requestedCmuxSurface = "client" in browser ? (opts.cmuxSurface ?? browser.surface) : undefined;
			if (existing.backend === "cmux" && existing.cmuxAttachedSurface !== requestedCmuxSurface) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else if (opts.dialogs !== undefined && opts.dialogs !== existing.dialogPolicy) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else {
				const reuseSteps: string[] = [];
				if (opts.viewport && browser.kind.kind !== "cmux") {
					const dsf = opts.viewport.deviceScaleFactor;
					reuseSteps.push(
						`await page.setViewport({ width: ${opts.viewport.width}, height: ${opts.viewport.height}, deviceScaleFactor: ${dsf === undefined ? "undefined" : String(dsf)} });`,
					);
				}
				const reuse = async (): Promise<void> => {
					if (reuseSteps.length) {
						await runInTabWithSnapshot(
							name,
							{
								code: reuseSteps.join("\n"),
								timeoutMs: Math.max(1, opts.timeoutMs - Math.round(performance.now() - startedAt)),
								signal: opts.signal,
							},
							{ cwd: getProjectDir() },
						);
					}
					if (opts.url) await navigateOpenedTab(name, existing, opts, startedAt, false);
				};
				let recoveredRenderer = false;
				try {
					await reuse();
				} catch (error) {
					if (
						!(error instanceof RendererCrashedError) ||
						tabs.get(name) !== existing ||
						existing.state !== "alive"
					)
						throw error;
					recoveredRenderer = true;
					await reuse();
				}
				const reused = tabs.get(name)!;
				const note =
					[
						recoveredRenderer
							? "The renderer had crashed; the tab was reattached and its page reloaded."
							: undefined,
						reused.backend === "worker" ? reused.workerExitNotice : undefined,
					]
						.filter(Boolean)
						.join("\n") || undefined;
				if (reused.backend === "worker") reused.workerExitNotice = undefined;
				return { tab: reused, created: false, note };
			}
		} else {
			if (existing.browser === browser) {
				holdBrowser(browser);
				tempHold = true;
			}
			await releaseTab(name, { kill: false });
		}
	}

	if ("client" in browser) {
		try {
			const result = await acquireCmuxTab(name, browser, opts);
			if (tempHold) await releaseBrowser(browser, { kill: false });
			return result;
		} catch (error) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
	}
	let initPayload: WorkerInitPayload;
	let worker: WorkerHandle;
	try {
		initPayload = await buildInitPayload(browser, opts);
		worker = await spawnTabWorker();
	} catch (error) {
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
	}
	const initBudgetMs = opts.timeoutMs + GRACE_MS;
	let info: ReadyInfo;
	try {
		info = await initializeTabWorker(worker, initPayload, initBudgetMs, startedAt);
	} catch (error) {
		await worker.terminate().catch(() => undefined);
		closeAbandonedWorkerPage(browser, worker);
		if (worker.mode === "inline" || isReportedInitFailure(error) || initBudgetExhausted(initBudgetMs, startedAt)) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		logger.warn("Tab worker init failed; retrying with inline tab worker (no sync-loop guard)", {
			error: error instanceof Error ? error.message : String(error),
		});
		worker = await spawnInlineWorker();
		try {
			info = await initializeTabWorker(worker, initPayload, initBudgetMs, startedAt);
		} catch (inlineError) {
			await worker.terminate().catch(() => undefined);
			closeAbandonedWorkerPage(browser, worker);
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			const finalError = new ToolError(
				`Failed to start browser tab worker (inline fallback also failed): ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
			);
			(finalError as { cause?: unknown }).cause = error;
			throw finalError;
		}
	}

	if (opts.signal?.aborted) {
		await worker.terminate().catch(() => undefined);
		closeAbandonedWorkerPage(browser, worker);
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false }).catch(() => undefined);
		throw new ToolAbortError("Browser tab open aborted");
	}

	holdBrowser(browser);
	if (tempHold) await releaseBrowser(browser, { kill: false });
	const tab: WorkerTabSession = {
		name,
		browser,
		targetId: info.targetId,
		backend: "worker",
		worker,
		state: "alive",
		info,
		pending: new Map(),
		dialogPolicy: opts.dialogs,
		kindTag: browser.kind.kind,
		ownsPage: ownsPage(initPayload),
		ownerSessionId: opts.ownerSessionId,
	};
	attachTabWorker(tab, worker);
	tabs.set(name, tab);
	// Durable ownership lets another live process reap this page if this one dies before closing it.
	const scope = sharedScopeOf(browser);
	if (scope) void recordSharedTarget(scope, info.targetId);
	if (opts.url) await navigateOpenedTab(name, tab, opts, startedAt, true);
	return { tab, created: true };
}

async function navigateOpenedTab(
	name: string,
	tab: TabSession,
	opts: AcquireTabOptions,
	startedAt: number,
	created: boolean,
): Promise<void> {
	try {
		const remainingMs = Math.max(1, opts.timeoutMs - Math.round(performance.now() - startedAt));
		await runInTabWithSnapshot(
			name,
			{
				code: `await tab.goto(${JSON.stringify(opts.url)}, { waitUntil: ${JSON.stringify(opts.waitUntil ?? "load")} });`,
				timeoutMs: remainingMs,
				signal: opts.signal,
			},
			{ cwd: getProjectDir() },
		);
		throwIfAborted(opts.signal);
	} catch (error) {
		if (
			!opts.signal?.aborted &&
			error instanceof NavigationTimeoutError &&
			tabs.get(name) === tab &&
			tab.state === "alive"
		) {
			throw new ToolError(
				`${error.message}\nTab ${JSON.stringify(name)} stays open on what loaded; use action:"run" with this name to inspect or continue it.`,
			);
		}
		if (created && tabs.get(name) === tab) await releaseTab(name, { kill: false }).catch(() => undefined);
		throw error;
	}
}

async function acquireCmuxTab(
	name: string,
	browser: CmuxBrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const attachedSurface = opts.cmuxSurface ?? browser.surface;
	if (attachedSurface?.startsWith("surface:")) {
		throw new ToolError(
			"app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split",
		);
	}

	let surfaceId = attachedSurface;
	let initialUrl = opts.url;
	let ownsSurface = false;
	try {
		if (!surfaceId) {
			const params: Record<string, unknown> = { url: opts.url ?? "about:blank", focus: false };
			if (process.env.CMUX_WORKSPACE_ID) params.workspace_id = process.env.CMUX_WORKSPACE_ID;
			if (process.env.CMUX_SURFACE_ID) params.surface_id = process.env.CMUX_SURFACE_ID;
			const result = await browser.client.request("browser.open_split", params, { timeoutMs: opts.timeoutMs });
			if (typeof result.surface_id !== "string" || result.surface_id.length === 0) {
				throw new ToolError("cmux browser.open_split did not return a surface_id");
			}
			surfaceId = result.surface_id;
			ownsSurface = true;
			if (typeof result.url === "string" && result.url.length > 0) initialUrl = result.url;
			if (opts.url) {
				await browser.client.request(
					"browser.wait",
					{
						surface_id: surfaceId,
						load_state: mapWaitUntil(opts.waitUntil ?? "load"),
						timeout_ms: opts.timeoutMs,
					},
					{ timeoutMs: opts.timeoutMs },
				);
			}
		}

		const { CmuxTab: CmuxTabImpl } = await import("./cmux/cmux-tab");
		const cmuxTab = new CmuxTabImpl({ client: browser.client, surfaceId, url: initialUrl });
		if (attachedSurface && opts.url) {
			await cmuxTab.goto(opts.url, { waitUntil: opts.waitUntil ?? "load", timeoutMs: opts.timeoutMs });
		}
		const info = await cmuxTab.readyInfo(opts.viewport ?? DEFAULT_VIEWPORT);

		if (opts.signal?.aborted) {
			throw new ToolAbortError("Browser tab open aborted");
		}
		holdBrowser(browser);
		const tab: CmuxTabSession = {
			name,
			browser,
			targetId: surfaceId,
			backend: "cmux",
			cmuxTab,
			cmuxOwnsSurface: ownsSurface,
			state: "alive",
			info,
			pending: new Map(),
			dialogPolicy: opts.dialogs,
			kindTag: browser.kind.kind,
			cmuxAttachedSurface: attachedSurface,
			ownerSessionId: opts.ownerSessionId,
		};
		tabs.set(name, tab);
		return { tab, created: true };
	} catch (error) {
		if (ownsSurface && surfaceId) {
			await browser.client.request("surface.close", { surface_id: surfaceId }).catch(() => undefined);
		}
		throw error;
	}
}

export async function runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
	return await runInTabWithSnapshot(
		name,
		{ code: opts.code, timeoutMs: opts.timeoutMs, signal: opts.signal, session: opts.session },
		{
			cwd: opts.session.cwd,
			browserScreenshotDir: expandBrowserScreenshotDir(opts.session),
			outputArtifact: await opts.session.allocateOutputArtifact?.("browser-original").catch(() => undefined),
			excludeWebP: webpExclusionForModel(opts.session.getActiveModel?.()),
		},
	);
}

async function runInTabWithSnapshot(
	name: string,
	opts: { code: string; timeoutMs: number; signal?: AbortSignal; session?: ToolSession; retryAfterDetach?: boolean },
	snapshot: SessionSnapshot,
): Promise<RunResultOk> {
	const original = tabs.get(name);
	const waitStartedAt = performance.now();
	await waitForWorkerRecovery(name, opts.timeoutMs, opts.signal);
	const tab = tabs.get(name);
	if (original && tab && tab !== original)
		throw new ToolError(`Tab ${JSON.stringify(name)} was closed while its worker was being reattached`);
	opts = { ...opts, timeoutMs: Math.max(1, opts.timeoutMs - Math.round(performance.now() - waitStartedAt)) };
	if (!tab || tab.state === "dead") {
		const killed = killedTabs.get(name);
		throw new ToolError(
			killed
				? `Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.`
				: `Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`,
		);
	}
	if (tab.pending.size > 0)
		throw new ToolError(
			`Tab ${JSON.stringify(name)} is busy; await its current run before starting another call on the same tab`,
		);
	const runStartedAt = performance.now();
	const id = Snowflake.next();
	const { promise, resolve, reject } = Promise.withResolvers<RunResultOk>();
	void promise.catch(() => undefined);

	const closeAc = new AbortController();
	const pending: PendingRun = {
		resolve,
		reject,
		session: opts.session ?? ({} as ToolSession),
		signal: opts.signal,
		toolCalls: new Map(),
		closeAc,
	};
	tab.pending.set(id, pending);
	if (tab.backend === "cmux") {
		const runSignal = opts.signal ? AbortSignal.any([opts.signal, closeAc.signal]) : closeAc.signal;
		try {
			const { runCmuxCode } = await import("./cmux/cmux-tab");
			runCmuxCode(tab.cmuxTab, {
				code: opts.code,
				timeoutMs: opts.timeoutMs,
				signal: runSignal,
				session: pending.session,
				snapshot,
			}).then(resolve, reject);
			return await promise;
		} finally {
			tab.pending.delete(id);
		}
	}
	const abort = (): void => {
		safeSend(tab, { type: "abort", id });
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(opts.signal?.reason);
	};
	if (opts.signal?.aborted) abort();
	else opts.signal?.addEventListener("abort", abort, { once: true });
	try {
		tab.worker.send({
			type: "run",
			id,
			name,
			code: opts.code,
			timeoutMs: opts.timeoutMs,
			session: snapshot,
		});
		try {
			const result = await raceWithTimeout(
				promise,
				opts.timeoutMs + GRACE_MS,
				"Browser code execution hung past grace; tab killed",
				async reason => await forceKillTab(name, reason),
			);
			if (result.recoverTab) {
				const reattached = await recoverWorkerTab(
					tab,
					opts.timeoutMs,
					"Browser request interception cleanup failed; tab closed",
				);
				result.displays.push({
					type: "text",
					text: reattached
						? "Browser request interception could not be reset after this run; the tab was reattached. Run globals, element IDs, and request interception state were reset; any open dialog was dismissed and any pending load was stopped."
						: "Browser request interception could not be reset after this run; the tab was closed.",
				});
			}
			if (tab.workerExitNotice) {
				result.displays.unshift({ type: "text", text: tab.workerExitNotice });
				tab.workerExitNotice = undefined;
			}
			return result;
		} catch (error) {
			if (error instanceof RendererCrashedError) {
				for (const controller of pending.toolCalls.values()) controller.abort(error);
				const reattached = await untilAborted(opts.signal, () =>
					trackWorkerRecovery(
						tab,
						recoverWorkerTab(tab, opts.timeoutMs, "Browser tab renderer crashed; tab closed"),
					),
				);
				throw new RendererCrashedError(
					reattached
						? `${error.message}. The tab was reattached and its page reloaded; run globals and element IDs were reset.`
						: `${error.message}; the tab could not be reattached and was closed.`,
				);
			}
			if (error instanceof DebuggerDetachedError) {
				for (const controller of pending.toolCalls.values()) controller.abort(error);
				const landed = error.when === "during-run" ? "; input sent before the detach may already have landed" : "";
				if (tab.worker.mode === "inline" && tabs.get(name) === tab && tab.state === "alive") {
					const closed = waitForClosed(tab).catch(() => undefined);
					safeSend(tab, { type: "close" });
					await closed;
				}
				if (error.reason === "canceled_by_user" || tab.worker.mode === "inline") {
					if (tabs.get(name) === tab) await forceKillTab(name, `${error.message}; tab released`);
					throw new ToolError(
						`${error.message}${landed}. The tab was released; reopen it after Chrome permits debugging again.`,
					);
				}
				const remainingMs = (): number =>
					Math.max(0, opts.timeoutMs - Math.round(performance.now() - runStartedAt));
				const reattached = await untilAborted(opts.signal, () =>
					trackWorkerRecovery(
						tab,
						recycleTimedOutWorkerTab(tab, Math.max(1, remainingMs()), false).catch(() => false),
					),
				);
				if (!reattached) {
					if (tabs.get(name) === tab)
						await forceKillTab(name, "Chrome detached the debugger and the tab could not be reattached");
					throw new ToolError(
						`${error.message}${landed}. The tab could not be reattached: it may have closed, or Chrome refused debugging while another extension's frame was open. Reopen it once Chrome permits debugging.`,
					);
				}
				if (error.when === "before-run" && opts.retryAfterDetach !== false && remainingMs() > 0) {
					tab.pending.delete(id);
					return await runInTabWithSnapshot(
						name,
						{ ...opts, timeoutMs: remainingMs(), retryAfterDetach: false },
						snapshot,
					);
				}
				throw new ToolError(
					`${error.message}${landed}. The tab was reattached without reloading; run globals and element IDs were reset. Retry the call only if its earlier actions are safe to repeat.`,
				);
			}
			const runTimedOut =
				error instanceof ToolError && error.message.startsWith("Browser code execution timed out after ");
			if (runTimedOut || error instanceof RecoverableWorkerError) {
				try {
					if (tab.worker.mode === "inline") {
						const reason = runTimedOut
							? "Browser code execution timed out; tab killed"
							: "Browser request interception cleanup failed; tab killed";
						await forceKillTab(name, reason);
					} else {
						await recycleTimedOutWorkerTab(tab, opts.timeoutMs + GRACE_MS);
					}
				} catch (recycleError) {
					logger.warn("Failed to recycle browser tab worker; killing tab", {
						error: recycleError instanceof Error ? recycleError.message : String(recycleError),
					});
					await forceKillTab(name, "Browser tab worker recovery failed; tab killed");
				}
			}
			throw error;
		}
	} finally {
		opts.signal?.removeEventListener("abort", abort);
		tab.pending.delete(id);
	}
}

// A second release of a tab already being torn down joins the first: otherwise its unconditional delete could remove a
// same-name replacement published meanwhile, and the browser hold would be released twice.
const releaseInflight = new WeakMap<TabSession, Promise<boolean>>();

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	const ongoing = releaseInflight.get(tab);
	if (ongoing) return await ongoing;
	const run = releaseTabInner(tab, name, opts);
	releaseInflight.set(tab, run);
	try {
		return await run;
	} finally {
		releaseInflight.delete(tab);
	}
}

async function releaseTabInner(tab: TabSession, name: string, opts: ReleaseTabOptions): Promise<boolean> {
	const wasAlive = tab.state === "alive";
	tab.state = "dead";
	const closeError = postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(name)} was closed`));
	for (const [id, pending] of tab.pending) {
		if (tab.backend === "worker") {
			try {
				tab.worker.send({ type: "abort", id, expectedCleanup: true });
			} catch {}
		}
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(closeError);

		pending.closeAc?.abort(closeError);
		pending.reject(closeError);
	}
	tab.pending.clear();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TAB_CLOSE_TIMEOUT_MS;
	if (tab.backend === "cmux") {
		let closeError: unknown;
		if (wasAlive && tab.cmuxOwnsSurface) {
			try {
				await waitForTabCleanup(
					tab,
					timeoutMs,
					`cmux surface ${JSON.stringify(tab.targetId)} (surface.close)`,
					tab.browser.client.request("surface.close", { surface_id: tab.targetId }, { timeoutMs }),
				);
			} catch (err) {
				if (isLastSurfaceCloseError(err)) {
					logger.debug("Leaving cmux browser surface open because it is the last surface in the workspace", {
						error: err instanceof Error ? err.message : String(err),
					});
				} else {
					closeError = err;
				}
			}
		}
		try {
			await releaseBrowser(tab.browser, {
				kill: opts.kill ?? false,
				timeoutMs,
				resource: `tab ${JSON.stringify(name)}`,
			});
		} catch (error) {
			closeError ??= error;
		} finally {
			tabs.delete(name);
		}
		if (closeError) throw closeError;
		return true;
	}
	let cleanupError: unknown;
	let forced = false;
	let targetCloseFailed = false;
	if (wasAlive) {
		try {
			tab.worker.send({ type: "close" });
			await waitForClosed(tab);
		} catch {
			forced = true;
		}
	}
	await tab.worker.terminate().catch(() => undefined);
	if (tab.ownsPage && (forced || tab.kindTag === "relay")) {
		try {
			targetCloseFailed = !(await waitForTabCleanup(
				tab,
				timeoutMs,
				`orphan CDP target ${JSON.stringify(tab.targetId)} (Page.close)`,
				closeOrphanTarget(tab, timeoutMs / 2),
			));
			if (targetCloseFailed) throw new ToolError(`Could not confirm closure of tab ${JSON.stringify(name)}`);
		} catch (error) {
			targetCloseFailed = true;
			cleanupError = error;
		}
	}
	try {
		await releaseBrowser(tab.browser, {
			kill: opts.kill ?? false,
			timeoutMs,
			resource: `tab ${JSON.stringify(name)}`,
		});
	} catch (error) {
		cleanupError ??= error;
	} finally {
		tabs.delete(name);
		const scope = sharedScopeOf(tab.browser);
		if (scope) {
			if (targetCloseFailed) recheckSharedBrowser(scope);
			else void forgetSharedTarget(scope, tab.targetId);
		}
	}
	if (cleanupError) throw cleanupError;
	return true;
}

export async function releaseAllTabs(opts: ReleaseTabOptions = {}): Promise<number> {
	const names = [...tabs.keys()];
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

export async function dropHeadlessTabs(): Promise<void> {
	const names = [...tabs.values()].filter(tab => tab.kindTag === "headless").map(tab => tab.name);
	for (const name of names) await releaseTab(name);
}

export async function releaseTabsForOwner(ownerId: string, opts: ReleaseTabOptions = {}): Promise<number> {
	if (!ownerId) return 0;
	const names = [...tabs.values()].filter(tab => tab.ownerSessionId === ownerId).map(tab => tab.name);
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

export function getTabsMapForTest(): ReadonlyMap<string, TabSession> {
	return tabs;
}

function isLastSurfaceCloseError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /last/i.test(message);
}

async function buildInitPayload(browser: PuppeteerBrowserHandle, opts: AcquireTabOptions): Promise<WorkerInitPayload> {
	const safeDir = getPuppeteerDir();
	const browserWSEndpoint = browser.wsEndpoint;
	if (browser.kind.kind === "headless") {
		return {
			mode: "headless",
			browserWSEndpoint,
			safeDir,
			// A visible window keeps its proto-owned page but must resize freely: no fixed device emulation.
			emulateViewport: browser.kind.headless,
			viewport: opts.viewport,
			dialogs: opts.dialogs,
			timeoutMs: opts.timeoutMs,
		};
	}

	const userDriven = browser.kind.kind === "connected" || browser.kind.kind === "relay";
	let page: AttachPage;
	if (
		(browser.kind.kind === "relay" ||
			(browser.kind.kind === "spawned" && isChromiumBrowserExecutable(browser.kind.path))) &&
		!opts.target
	) {
		page = { kind: "create" };
	} else {
		const picked = await pickElectronTarget(browser.browser, {
			matcher: opts.target,
			preferVisible: userDriven && !opts.target,
			relayJson: browser.kind.kind === "relay" ? browser.cdpUrl : undefined,
			signal: opts.signal,
		});
		page = { kind: "borrowed", targetId: await targetIdForPage(picked) };
	}
	return {
		mode: "attach",
		userDriven,
		browserWSEndpoint,
		safeDir,
		page,
		dialogs: opts.dialogs,
		timeoutMs: opts.timeoutMs,
	};
}

function handleTabMessage(tab: WorkerTabSession, msg: WorkerOutbound): void {
	if (msg.type === "result") {
		const pending = tab.pending.get(msg.id);
		if (!pending) return;
		// The run owns its pending entry until any recovery finishes.
		if (msg.ok) {
			pending.resolve(msg.payload);
			return;
		}
		pending.reject(errorFromPayload(msg.error));
		return;
	}
	if (msg.type === "ready") {
		tab.info = msg.info;
		return;
	}
	if (msg.type === "tool-call") {
		void dispatchToolCall(tab, msg);
		return;
	}
	if (msg.type === "log") logWorkerMessage(msg);
}

async function dispatchToolCall(
	tab: WorkerTabSession,
	msg: Extract<WorkerOutbound, { type: "tool-call" }>,
): Promise<void> {
	const pending = tab.pending.get(msg.runId);
	if (!pending?.session.cwd) {
		safeSend(tab, {
			type: "tool-reply",
			id: msg.id,
			reply: {
				ok: false,
				error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
			},
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	const onParentAbort = (): void => ctrl.abort(pending.signal?.reason);
	if (pending.signal?.aborted) onParentAbort();
	else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.session,
			signal: ctrl.signal,
			emitStatus: () => {},
		});
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
		pending.signal?.removeEventListener("abort", onParentAbort);
	}
}

function safeSend(tab: WorkerTabSession, msg: WorkerInbound): void {
	if (tab.state !== "alive") return;
	try {
		tab.worker.send(msg);
	} catch (err) {
		logger.debug("tab worker send failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
}

async function recoverWorkerTab(tab: WorkerTabSession, timeoutMs: number, failureReason: string): Promise<boolean> {
	try {
		if (tab.worker.mode === "inline") {
			if (tabs.get(tab.name) === tab) await forceKillTab(tab.name, failureReason);
			return false;
		}
		return await recycleTimedOutWorkerTab(tab, timeoutMs + GRACE_MS);
	} catch (error) {
		logger.warn("Failed to recycle browser tab worker", { name: tab.name, error: String(error) });
		if (tabs.get(tab.name) === tab) await forceKillTab(tab.name, failureReason);
		return false;
	}
}

function trackWorkerRecovery(tab: WorkerTabSession, run: Promise<boolean>): Promise<boolean> {
	const tracked = run.finally(() => {
		if (tab.workerRecovery === tracked) tab.workerRecovery = undefined;
	});
	tab.workerRecovery = tracked;
	return tracked;
}

async function waitForWorkerRecovery(name: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const tab = tabs.get(name);
	if (tab?.backend !== "worker" || !tab.workerRecovery) return;
	await raceWithTimeout(
		untilAborted(signal, () => tab.workerRecovery!),
		timeoutMs,
		`Tab ${JSON.stringify(name)}'s worker is still being reattached after ${timeoutMs}ms`,
	);
}

class WorkerMessageError extends ToolError {}

function attachTabWorker(tab: WorkerTabSession, worker: WorkerHandle): void {
	worker.onMessage(msg => {
		if (tab.worker === worker) handleTabMessage(tab, msg);
	});
	let lastError: Error | undefined;
	worker.onError(error => {
		if (!(error instanceof WorkerMessageError)) lastError = error;
	});
	worker.onExit(exitCode => {
		if (tabs.get(tab.name) !== tab || tab.worker !== worker || tab.state !== "alive" || releaseInflight.has(tab))
			return;
		const cause = lastError && (/^error: (.+)$/m.exec(lastError.message)?.[1] ?? lastError.message.split("\n", 1)[0]);
		const exited = `Browser tab worker exited unexpectedly (exit code ${exitCode}${cause ? `, ${cause}` : ""})`;
		const looping = tab.workerExitedAt !== undefined && Date.now() - tab.workerExitedAt < 10_000;
		tab.workerExitedAt = Date.now();
		const idle = tab.pending.size === 0;
		const error = postmortem.markExpectedCleanupError(
			new ToolError(
				`${exited}; the tab is being reattached to the same page. Run globals and element ids are reset.`,
			),
		);
		for (const pending of tab.pending.values()) {
			for (const controller of pending.toolCalls.values()) controller.abort(error);
			pending.closeAc?.abort(error);
			pending.reject(error);
		}
		if (looping) {
			void forceKillTab(tab.name, `${exited} again after replacement; tab closed`).catch(error =>
				logger.warn("Failed to close crashed browser tab", { error: String(error) }),
			);
			return;
		}
		const recovery = recycleTimedOutWorkerTab(tab, 10_000, false)
			.then(reattached => {
				if (reattached && idle)
					tab.workerExitNotice = `${exited} since the last call; the tab was reattached without reloading. Run globals and element ids were reset.`;
				return reattached;
			})
			.catch(async error => {
				logger.warn("Failed to reattach browser tab worker", { name: tab.name, error: String(error) });
				if (tabs.get(tab.name) === tab) await forceKillTab(tab.name, `${exited}; reattachment failed, tab closed`);
				return false;
			})
			.finally(() => {
				if (tab.workerRecovery === recovery) tab.workerRecovery = undefined;
			});
		tab.workerRecovery = recovery;
	});
}

async function recycleTimedOutWorkerTab(tab: WorkerTabSession, timeoutMs: number, recover = true): Promise<boolean> {
	const startedAt = performance.now();
	const oldWorker = tab.worker;
	holdBrowser(tab.browser);
	try {
		await oldWorker.terminate().catch(() => undefined);
		const browserWSEndpoint = tab.browser.wsEndpoint;
		const payload: WorkerInitPayload = {
			mode: "attach",
			userDriven: tab.kindTag === "connected" || tab.kindTag === "relay",
			browserWSEndpoint,
			safeDir: getPuppeteerDir(),
			page: { kind: tab.ownsPage ? "owned" : "borrowed", targetId: tab.targetId },
			dialogs: tab.dialogPolicy,
			recover,
			timeoutMs,
		};
		const adopt = async (worker: WorkerHandle): Promise<boolean> => {
			const info = await initializeTabWorker(worker, payload, timeoutMs, startedAt);
			if (tabs.get(tab.name) !== tab || tab.state !== "alive" || releaseInflight.has(tab)) {
				await worker.terminate().catch(() => undefined);
				return false;
			}
			tab.worker = worker;
			tab.info = info;
			attachTabWorker(tab, worker);
			return true;
		};
		let worker = await spawnTabWorker();
		try {
			return await adopt(worker);
		} catch (error) {
			await worker.terminate().catch(() => undefined);
			if (initBudgetExhausted(timeoutMs, startedAt) || isReportedInitFailure(error)) throw error;
			worker = await spawnInlineWorker();
			try {
				return await adopt(worker);
			} catch (inlineError) {
				await worker.terminate().catch(() => undefined);
				throw new ToolError(
					`Failed to reattach browser tab worker: ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
					{ cause: error },
				);
			}
		}
	} finally {
		await releaseBrowser(tab.browser, { kill: false });
	}
}

async function forceKillTab(name: string, reason: string): Promise<void> {
	const tab = tabs.get(name);
	if (!tab) return;
	const ongoing = releaseInflight.get(tab);
	if (ongoing) {
		await ongoing.catch(() => undefined);
		return;
	}
	killedTabs.set(name, reason);
	tab.state = "dead";
	const error = postmortem.markExpectedCleanupError(new ToolError(reason));
	for (const pending of tab.pending.values()) {
		for (const controller of pending.toolCalls.values()) controller.abort(error);
		pending.closeAc?.abort(error);
		pending.reject(error);
	}
	tab.pending.clear();
	const teardown = forceKillTabTeardown(tab).then(() => true);
	releaseInflight.set(tab, teardown);
	try {
		await teardown;
	} finally {
		if (releaseInflight.get(tab) === teardown) releaseInflight.delete(tab);
	}
}

async function forceKillTabTeardown(tab: TabSession): Promise<void> {
	let targetClosed = true;
	if (tab.backend === "worker") {
		await tab.worker.terminate().catch(() => undefined);
		if (tab.ownsPage) {
			targetClosed = await waitForTabCleanup(
				tab,
				DEFAULT_TAB_CLOSE_TIMEOUT_MS,
				`orphan CDP target ${JSON.stringify(tab.targetId)} (Page.close)`,
				closeOrphanTarget(tab, DEFAULT_TAB_CLOSE_TIMEOUT_MS / 2),
			).catch(() => false);
		}
	}
	try {
		await releaseBrowser(tab.browser, { kill: false });
	} finally {
		if (tabs.get(tab.name) === tab) tabs.delete(tab.name);
		const scope = sharedScopeOf(tab.browser);
		if (scope) {
			if (targetClosed) void forgetSharedTarget(scope, tab.targetId);
			else recheckSharedBrowser(scope);
		}
	}
}

// Closes via the browser CDP session: `page.close()` on a page whose navigation wedged waits for the protocol timeout.
async function closeTargetById(
	browser: PuppeteerBrowserHandle,
	targetId: string,
	confirmTimeoutMs?: number,
): Promise<boolean> {
	if (browser.kind.kind === "relay") return await closeRelayTarget(browserConnection(browser.browser), targetId);
	return await closeCdpTarget(browser.browser, targetId, confirmTimeoutMs);
}

// Only the project-shared broker Chromium outlives its creating process, so only it needs cross-process reaping.
function sharedScopeOf(browser: BrowserHandle): SharedTargetScope | undefined {
	if ("client" in browser) return undefined;
	if (browser.kind.kind !== "headless" || !browser.sharedDaemon) return undefined;
	return { projectDir: browser.sharedDaemon.projectDir, daemonName: browser.sharedDaemon.name };
}

function recheckSharedBrowser(scope: SharedTargetScope): void {
	void stopSharedBrowserIfUnreachable(scope).then(stopped => {
		if (stopped) void forgetSharedTargets(scope);
	});
}

async function closeOrphanTarget(tab: WorkerTabSession, confirmTimeoutMs?: number): Promise<boolean> {
	return await closeTargetById(tab.browser, tab.targetId, confirmTimeoutMs);
}

// Fire-and-forget so cleanup never delays the caller's error; the browser is held across the close so a concurrent
// last release cannot disconnect it first.
function closeAbandonedWorkerPage(browser: PuppeteerBrowserHandle, worker: WorkerHandle): void {
	const targetId = workerPageTargets.get(worker);
	workerPageTargets.delete(worker);
	if (!targetId) return;
	holdBrowser(browser);
	void closeTargetById(browser, targetId)
		.catch(() => undefined)
		.finally(() => void releaseBrowser(browser, { kill: false }).catch(() => undefined));
}

async function waitForClosed(tab: WorkerTabSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = tab.worker.onMessage(msg => {
		if (msg.type === "closed") resolve();
	});
	try {
		await raceWithTimeout(promise, GRACE_MS, "Timed out closing browser tab worker");
	} finally {
		unsubscribe();
	}
}

function expandBrowserScreenshotDir(session: ToolSession): string | undefined {
	const value = session.settings.get("browser.screenshotDir") as string | undefined;
	return value ? expandPath(value) : undefined;
}

async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}

async function targetIdForTarget(target: Target): Promise<string> {
	const raw = target as unknown as { _targetId?: unknown };
	if (typeof raw._targetId === "string") return raw._targetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const error = payload.rendererCrashed
		? new RendererCrashedError(payload.message)
		: payload.debuggerDetached
			? new DebuggerDetachedError(payload.message, payload.debuggerDetached.when, payload.debuggerDetached.reason)
			: payload.navigationTimeout
				? new NavigationTimeoutError(payload.message)
				: payload.recoverTab
					? new RecoverableWorkerError(payload.message)
					: payload.isAbort
						? new ToolAbortError()
						: payload.isToolError
							? new ToolError(payload.message)
							: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	reason: string,
	onTimeout?: (reason: string) => Promise<void>,
): Promise<T> {
	// Plain timer: under `bun test`, an `AbortSignal.timeout` member of a race with a never-settling member never fires.
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new ToolError(reason)), timeoutMs);
	try {
		return await Promise.race([promise, timeoutPromise]);
	} catch (error) {
		if (error instanceof ToolError && error.message === reason) await onTimeout?.(reason);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function spawnTabWorker(): Promise<WorkerHandle> {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: ["__proto_worker_tab"] })
			: new Worker(new URL("./tab-worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline tab worker (no sync-loop guard)", {
			error: err instanceof Error ? err.message : String(err),
		});
		return spawnInlineWorker();
	}
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	let terminated = false;
	return {
		mode: "worker",
		send(msg, transferList) {
			worker.postMessage(msg, { transfer: transferList ?? [] });
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new WorkerMessageError(`Tab worker message error: ${String(event.data)}`));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
			};
		},
		onExit(handler) {
			const onClose = (event: CloseEvent): void => {
				if (!terminated) handler(event.code);
			};
			worker.addEventListener("close", onClose);
			return () => worker.removeEventListener("close", onClose);
		},
		async terminate() {
			terminated = true;
			worker.terminate();
		},
	};
}

async function spawnInlineWorker(): Promise<WorkerHandle> {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const workerTransport: Transport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg as WorkerOutbound);
			}),
		onMessage: handler => {
			const typed = handler as (message: WorkerInbound) => void;
			workerListeners.add(typed);
			return () => workerListeners.delete(typed);
		},
		close: () => {},
	};
	const { WorkerCore } = await import("./tab-worker");
	const core = new WorkerCore(workerTransport, false);
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		onError: () => () => {},
		onExit: () => () => {},
		async terminate() {
			core.terminate();
		},
	};
}

// Both phases draw on what is left of the caller budget measured from `deadlineStart`, so the inline-fallback retry
// cannot restart the clock. One listener spans both phases: the inline transport delivers on microtasks, so a
// `ready`/`init-failed` right after `setup` would be dropped by a phase-switch re-listen.
async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	const remainingMs = timeoutMs - Math.round(performance.now() - deadlineStart);
	const setupBudgetMs = Math.max(SETUP_BUDGET_FLOOR_MS, Math.min(SETUP_BUDGET_CAP_MS, Math.floor(remainingMs / 3)));
	const setup = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<ReadyInfo>();
	let setupDone = false;
	const failStartup = (error: Error): void => {
		(setupDone ? ready : setup).reject(error);
	};
	const unlisten = worker.onMessage(msg => {
		if (msg.type === "page-created") workerPageTargets.set(worker, msg.targetId);
		else if (msg.type === "setup") {
			setupDone = true;
			setup.resolve();
		} else if (msg.type === "ready") ready.resolve(msg.info);
		else if (msg.type === "init-failed") failStartup(markReportedInitFailure(errorFromPayload(msg.error)));
		else if (msg.type === "log") logWorkerMessage(msg);
	});
	const unlistenError = worker.onError(error => {
		failStartup(new ToolError(`Tab worker failed during startup: ${error.message}`));
	});
	try {
		worker.send({ type: "init", payload });
		await raceWithTimeout(setup.promise, setupBudgetMs, "Timed out waiting for tab worker setup");
		const readyBudgetMs = Math.max(READY_BUDGET_FLOOR_MS, timeoutMs - Math.round(performance.now() - deadlineStart));
		return await raceWithTimeout(ready.promise, readyBudgetMs, "Timed out initializing browser tab worker");
	} finally {
		unlisten();
		unlistenError();
	}
}

function initBudgetExhausted(budgetMs: number, deadlineStart: number): boolean {
	return budgetMs - Math.round(performance.now() - deadlineStart) <= 0;
}

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart?: number,
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs, deadlineStart);
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown tab worker error");
}
