import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { IrcBus } from "../../irc/bus";
import type { Theme } from "../../modes/theme/theme";
import fleetDescription from "../../prompts/tools/fleet.md" with { type: "text" };
import type { AgentRegistry } from "../../registry/agent-registry";
import type { ToolSession } from "..";
import {
	buildJobResult,
	executeCancel,
	executeJobsSnapshot,
	jobsRenderCall,
	jobsRenderResult,
	noMatchingJobsResult,
	nothingToWaitForResult,
	resolvePollWindow,
	snapshotJobs,
	visibleJobs,
} from "./jobs";
import {
	executeLaunch,
	type LaunchParams,
	type LaunchRenderArgs,
	type LaunchToolDetails,
	launchRenderCall,
	launchRenderResult,
} from "./launch";
import {
	drainPendingInbox,
	executeInbox,
	executeList,
	executeMessageWait,
	executeSend,
	messageResult,
	messagingRenderCall,
	messagingRenderResult,
	normalizeIrcTimeoutMs,
} from "./messaging";
import { type FleetDetails, type FleetRenderArgs, fleetErrorResult } from "./types";

export { isWaitingPollDetails } from "./jobs";
export type { LaunchParams, LaunchToolDetails } from "./launch";
export { createIrcMessageCard, isIrcEnabled } from "./messaging";
export * from "./types";

const fleetSchema = type({
	op: type(
		"'send' | 'wait' | 'inbox' | 'list' | 'jobs' | 'cancel' | 'start' | 'ps' | 'logs' | 'stop' | 'restart' | 'describe'",
	).describe("fleet operation"),
	"to?": type("string").describe('send: recipient agent id or "all"'),
	"message?": type("string").describe("send: message body"),
	"replyTo?": type("string").describe("send: message id being answered"),
	"await?": type("boolean").describe('send: wait for the recipient\'s reply (invalid with to:"all")'),
	"from?": type("string").describe("wait: only accept a message from this agent id"),
	"ids?": type("string[]").describe("wait: job ids to watch (omit = all running jobs); cancel: job ids to kill"),
	"timeoutMs?": type("number").describe("wait (messages/jobs): timeout in milliseconds (0 waits indefinitely)"),
	"peek?": type("boolean").describe("inbox: list messages without consuming them"),
	"name?": type("string <= 48").describe("process ops: stable project-scoped launch name"),
	"application?": type("string > 0").describe("start: executable or application path"),
	"args?": type("string[]").describe("start: argv passed directly to the application"),
	"env?": type({ "[string]": "string" }).describe("start: extra environment variables"),
	"cwd?": type("string").describe("start: working directory; defaults to the session directory"),
	"pty?": type("boolean").describe("start: allocate an interactive PTY; default true"),
	"ready?": type({
		"log?": type("string > 0").describe("regex matched against output"),
		"port?": type("number").describe("TCP port that must accept connections"),
		"host?": type("string > 0").describe("TCP readiness host; default 127.0.0.1"),
		"timeout?": type("number > 0").describe("seconds to wait; default 30"),
	}).describe("start: readiness conditions; all supplied conditions must pass"),
	"restart?": type("'no' | 'on-failure' | 'always'").describe("start: restart policy; default no"),
	"persist?": type("boolean").describe("start: survive the last proto client exiting; default false"),
	"detached?": type("boolean").describe(
		"start: survive every proto and broker exit; implies persist and disables PTY input",
	),
	"lines?": type("number > 0").describe("logs: output lines; default 100, max 1000"),
	"head?": type("boolean").describe("logs: read from the beginning instead of the tail"),
	"grep?": type("string > 0").describe("logs: regex filter"),
	"follow?": type("boolean").describe("logs: wait for output newer than cursor"),
	"cursor?": type("number >= 0").describe("logs: output cursor returned by an earlier call"),
	"for?": type("'ready' | 'exit'").describe("wait with name: lifecycle condition; default exit"),
	"pattern?": type("string > 0").describe("wait with name: output regex; takes precedence over for"),
	"text?": type("string > 0").describe("send with name: stdin text"),
	"enter?": type("boolean").describe("send with name: append Enter after text; default true"),
	"keys?": type("string[]").describe("send with name: terminal keys after text"),
	"signal?": type("'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'").describe(
		"send with name: process-tree signal",
	),
	"timeout?": type("number > 0").describe("logs/stop/wait with name: max seconds; default 30 (stop: 5)"),
});

type FleetParams = typeof fleetSchema.infer;

interface MessagingDeps {
	registry: AgentRegistry;
	senderId: string;
	settings: ToolSession["settings"];
}

const PROGRESS_INTERVAL_MS = 500;

export class FleetTool implements AgentTool<typeof fleetSchema, FleetDetails> {
	readonly name = "fleet";
	readonly label = "Fleet";
	readonly summary = "Message peer agents, control background jobs, and supervise long-running processes";
	readonly description: string;
	readonly parameters = fleetSchema;
	readonly strict = true;
	readonly interruptible = (params: Partial<FleetParams>): boolean => {
		if (params.op === "wait") return true;
		return params.op === "logs" && params.follow === true;
	};
	readonly loadMode = "essential";

	readonly examples: readonly ToolExample<typeof fleetSchema.infer>[] = [
		{
			caption: "List peers",
			call: { op: "list" },
		},
		{
			caption: "Fire-and-forget DM — same send wakes idle/parked peers",
			call: {
				op: "send",
				to: "AuthLoader",
				message: "Still touching src/server/auth.ts? I need to add a 401 path.",
			},
		},
		{
			caption: "Round-trip when you cannot proceed without the answer",
			call: {
				op: "send",
				to: "Main",
				message: "JWT or session cookies for the auth flow?",
				await: true,
			},
		},
		{
			caption: "Completely blocked: wait for the first finished job or incoming message",
			call: { op: "wait" },
		},
		{
			caption: "Block until a specific peer answers",
			call: { op: "wait", from: "AuthLoader", timeoutMs: 60000 },
		},
		{
			caption: "Kill a hung background job",
			call: { op: "cancel", ids: ["bash_a1b2c3"] },
		},
		{
			caption: "Snapshot every background job without waiting",
			call: { op: "jobs" },
		},
		{
			caption: "Start a dev server and wait for its log banner and port",
			call: {
				op: "start",
				name: "web",
				application: "bun",
				args: ["run", "dev"],
				ready: { log: "Local:.*http", port: 5173, timeout: 30 },
			},
		},
		{
			caption: "Follow process output after a cursor",
			call: { op: "logs", name: "web", follow: true, cursor: 1842, timeout: 30 },
		},
		{
			caption: "Drive a REPL/debugger over stdin",
			call: { op: "send", name: "debugger", text: "breakpoint set --name main" },
		},
		{
			caption: "Interrupt a process",
			call: { op: "send", name: "debugger", keys: ["CTRL_C"] },
		},
		{
			caption: "Block until a process is ready",
			call: { op: "wait", name: "web", for: "ready", timeout: 30 },
		},
	];

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(fleetDescription);
	}

	#messaging(): MessagingDeps | null {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? null;
		if (!registry || !senderId) return null;
		return { registry, senderId, settings: this.session.settings };
	}

	async execute(
		_toolCallId: string,
		params: FleetParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<FleetDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<FleetDetails>> {
		switch (params.op) {
			case "list": {
				const messaging = this.#messaging();
				if (!messaging) return fleetErrorResult("Peer messaging is unavailable in this session.", { op: "list" });
				return executeList(messaging.registry, messaging.senderId);
			}
			case "send": {
				const toPeer = params.to?.trim();
				const toProcess = params.name?.trim();
				if (toPeer && toProcess) {
					return fleetErrorResult('`to` (peer) and `name` (process) are mutually exclusive for op="send".', {
						op: "send",
					});
				}
				if (toProcess) return this.#launch(params, "send", signal);
				const messaging = this.#messaging();
				if (!messaging) return fleetErrorResult("Peer messaging is unavailable in this session.", { op: "send" });
				return executeSend(messaging, params, signal);
			}
			case "inbox": {
				const messaging = this.#messaging();
				if (!messaging) return fleetErrorResult("Peer messaging is unavailable in this session.", { op: "inbox" });
				return executeInbox(messaging.registry, messaging.senderId, params.peek);
			}
			case "wait":
				if (params.name?.trim()) return this.#launch(params, "wait", signal);
				return this.#executeWait(params, signal, onUpdate);
			case "cancel": {
				const manager = this.session.asyncJobManager;
				if (!manager) return this.#asyncDisabled("cancel");
				if (!params.ids?.length) {
					return fleetErrorResult('`ids` is required for op="cancel".', { op: "cancel", jobs: [] });
				}
				return await executeCancel(this.session, manager, this.#ownerId(), params.ids);
			}
			case "jobs": {
				const manager = this.session.asyncJobManager;
				if (!manager) return this.#asyncDisabled("jobs");
				return executeJobsSnapshot(this.session, manager, this.#ownerId());
			}
			case "start":
			case "ps":
			case "logs":
			case "stop":
			case "restart":
			case "describe":
				return this.#launch(params, params.op === "ps" ? "list" : params.op, signal);
			default:
				return fleetErrorResult("Unknown fleet op.", { op: params.op });
		}
	}

	#ownerId(): string | undefined {
		return this.session.getAgentId?.() ?? undefined;
	}

	#asyncDisabled(op: "cancel" | "jobs"): AgentToolResult<FleetDetails> {
		return {
			content: [{ type: "text", text: "Async execution is disabled; no background jobs are available." }],
			details: { op, jobs: [] },
		};
	}

	async #launch(
		params: FleetParams,
		op: LaunchParams["op"],
		signal?: AbortSignal,
	): Promise<AgentToolResult<FleetDetails>> {
		if (!this.session.settings.get("launch.enabled")) {
			return fleetErrorResult("Process supervision is disabled (launch.enabled=false).", { op: params.op });
		}
		const { op: _fleetOp, ...rest } = params;
		return executeLaunch(this.session, { ...rest, op }, signal);
	}

	async #executeWait(
		params: FleetParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<FleetDetails>,
	): Promise<AgentToolResult<FleetDetails>> {
		const messaging = this.#messaging();
		const manager = this.session.asyncJobManager;
		const ownerId = this.#ownerId();
		const from = params.from?.trim() || undefined;

		if (messaging) {
			const pending = drainPendingInbox(messaging.registry, messaging.senderId, from);
			if (pending) return messageResult(messaging.senderId, pending);
		}

		const ids = params.ids;
		const jobsToWatch = manager
			? ids?.length
				? visibleJobs(manager, ids, ownerId)
				: manager.getRunningJobs(ownerId ? { ownerId } : undefined)
			: [];
		if (manager && ids?.length && jobsToWatch.length === 0) {
			return noMatchingJobsResult(this.session, ids);
		}
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (manager && jobsToWatch.length > 0 && runningJobs.length === 0) {
			return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
		}

		if (!manager || runningJobs.length === 0) {
			if (!messaging) return nothingToWaitForResult(this.session);

			const queued = IrcBus.global().take(messaging.senderId, from);
			if (queued) return messageResult(messaging.senderId, queued);
			if (!from) {
				const hasActivePeer = messaging.registry.listVisibleTo(messaging.senderId).length > 0;
				if (!hasActivePeer) return nothingToWaitForResult(this.session);
			}
			return executeMessageWait(messaging, { from, timeoutMs: params.timeoutMs }, signal);
		}

		const window = resolvePollWindow(this.session, manager, ownerId);
		const windowMs = params.timeoutMs !== undefined ? normalizeIrcTimeoutMs(params.timeoutMs) : window.waitMs;
		const usedSmartWindow = window.smart && params.timeoutMs === undefined;

		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);

		const busAbort = messaging ? new AbortController() : undefined;
		const busCancelled = new Error("fleet wait settled");
		let removeBusAbortListener: (() => void) | undefined;
		const busLeg =
			messaging && busAbort
				? IrcBus.global()
						.wait(messaging.senderId, { from }, 0, busAbort.signal)
						.then(
							message => ({ message, error: null as Error | null }),
							error => ({
								message: null,
								error:
									error === busCancelled ? null : error instanceof Error ? error : new Error(String(error)),
							}),
						)
				: undefined;
		if (busLeg) racePromises.push(busLeg);
		if (busAbort && signal) {
			if (signal.aborted) {
				busAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("fleet wait aborted"));
			} else {
				const onAbort = (): void => {
					busAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("fleet wait aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				removeBusAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
		}

		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = windowMs > 0 ? setTimeout(() => timeoutResolve(), windowMs) : undefined;
		if (timeoutHandle) racePromises.push(timeoutPromise);

		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		const emitProgress = () => {
			if (!onUpdate) return;
			onUpdate({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobsToWatch) },
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();

		try {
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				signal.addEventListener("abort", onAbort, { once: true });
				racePromises.push(abortPromise);
				try {
					await Promise.race(racePromises);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race(racePromises);
			}
		} finally {
			manager.unwatchJobs(watchedJobIds);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (progressTimer) clearInterval(progressTimer);
			busAbort?.abort(busCancelled);
			removeBusAbortListener?.();
			if (usedSmartWindow) {
				manager.recordPollWaitEnd(ownerId);
			}
		}

		if (busLeg && messaging) {
			const settled = await busLeg;
			if (settled.message) return messageResult(messaging.senderId, settled.message);
		}

		return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
	}
}

const LAUNCH_OPS: Record<string, true> = {
	start: true,
	ps: true,
	logs: true,
	stop: true,
	restart: true,
	describe: true,
};

function isLaunchStyleArgs(args: FleetRenderArgs | undefined): boolean {
	if (!args?.op) return false;
	if (LAUNCH_OPS[args.op]) return true;
	return (args.op === "send" || args.op === "wait") && !!args.name && !args.to && !args.from;
}

function isJobStyleArgs(args: FleetRenderArgs | undefined): boolean {
	switch (args?.op) {
		case "jobs":
		case "cancel":
			return true;
		case "wait":
			return !!args.ids?.length || (!args.from && !args.name);
		default:
			return false;
	}
}

function isLaunchDetails(details: FleetDetails): details is LaunchToolDetails {
	return (
		"daemon" in details ||
		"daemons" in details ||
		"terminalRows" in details ||
		"spec" in details ||
		"state" in details ||
		"cursor" in details
	);
}

function toLaunchArgs(args: FleetRenderArgs | undefined): LaunchRenderArgs {
	if (!args) return {};
	const { op, ...rest } = args;
	return { ...rest, op: op === "ps" ? "list" : op };
}

export const fleetToolRenderer = {
	inline: true,
	mergeCallAndResult: true,

	animatedPendingPreview: (args: unknown): boolean => isLaunchStyleArgs(args as FleetRenderArgs | undefined),

	renderCall(args: FleetRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		if (isLaunchStyleArgs(args)) return launchRenderCall(toLaunchArgs(args), options, uiTheme);
		return isJobStyleArgs(args)
			? jobsRenderCall(args, options, uiTheme)
			: messagingRenderCall(args, options, uiTheme);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FleetDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: FleetRenderArgs,
	): Component {
		const details = result.details;
		if (details && isLaunchDetails(details)) {
			return launchRenderResult({ ...result, details }, options, uiTheme, toLaunchArgs(args));
		}
		const coordination = details;
		if (coordination && (Array.isArray(coordination.jobs) || Array.isArray(coordination.agents))) {
			return jobsRenderResult({ ...result, details: coordination }, options, uiTheme, args);
		}
		if (
			coordination &&
			("receipts" in coordination || "waited" in coordination || "inbox" in coordination || "peers" in coordination)
		) {
			return messagingRenderResult({ ...result, details: coordination }, options, uiTheme, args);
		}

		if (isLaunchStyleArgs(args))
			return launchRenderResult({ ...result, details: undefined }, options, uiTheme, toLaunchArgs(args));
		if (isJobStyleArgs(args)) return jobsRenderResult({ ...result, details: coordination }, options, uiTheme, args);
		return messagingRenderResult({ ...result, details: coordination }, options, uiTheme, args);
	},
};
