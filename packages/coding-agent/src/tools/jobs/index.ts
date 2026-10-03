import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../../async";
import { sessionProjectCwd } from "../../eval/bridge-cwd";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { ExecutionRef, JobRef, ProcessRef, WatchRef } from "../../jobs/contracts";
import { daemonClientForProject } from "../../launch/client";
import type { Theme } from "../../modes/theme/theme";
import { startMonitor } from "../../monitor";
import type { WatchSource } from "../../monitor/types";
import jobsDescription from "../../prompts/tools/jobs.md" with { type: "text" };
import { renderStatusLine } from "../../tui";
import type { ToolSession } from "..";
import { formatErrorDetail, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../render-utils";
import { asyncJobOwner, describeJobs, ownedJob, refForJob, renderJobTree, snapshotJob } from "./jobs";
import {
	executeLaunch,
	type LaunchParams,
	type LaunchRenderArgs,
	launchRenderCall,
	launchRenderResult,
} from "./launch";
import { type CancelReceipt, type JobsDetails, type JobsOp, type JobsResult, jobsErrorResult } from "./types";
import { executeWait, MAX_WAIT_TARGETS } from "./wait";
import { jobWatchSource, processWatchSource } from "./watch";

export { isWaitingPollDetails } from "./jobs";
export * from "./types";

const refSchema = type({
	kind: type("'job' | 'process' | 'watch'").describe("reference kind; never inferred from the id"),
	id: type("string > 0").describe("immutable backend id"),
	"name?": type("string > 0").describe("process refs: project-scoped name the id was started under"),
});

/**
 * Flat wire schema so proto CLI flags map one-to-one; `OP_FIELDS` enforces which fields each op accepts
 * before any side effect.
 */
const jobsSchema = type({
	op: type(
		"'list' | 'inspect' | 'start' | 'logs' | 'input' | 'signal' | 'restart' | 'cancel' | 'watch' | 'unwatch' | 'wait'",
	).describe("jobs operation"),
	"target?": refSchema.describe("inspect/logs/input/signal/restart/cancel/unwatch: the reference to act on"),
	"targets?": refSchema.array().describe(`wait: up to ${MAX_WAIT_TARGETS} job/watch/process references`),
	"source?": refSchema.describe("watch: existing job or process to observe (exclusive with command)"),
	"mailbox?": type({ "from?": type("string > 0").describe("only accept a message from this agent id") }).describe(
		"wait: also wake on an incoming peer message",
	),
	"kind?": type("'job' | 'process' | 'watch'").describe("list: only this kind"),
	"scope?": type("'session' | 'project'").describe("list: processes of this session (default) or the project"),
	"afterEvent?": type("number >= 0").describe("inspect watch: return retained events after this event sequence"),
	"command?": type("string > 0").describe("watch: helper command probe owned by the watch (exclusive with source)"),
	"everyMs?": type("number >= 1000").describe("watch command: poll interval; omit to stream one long-running command"),
	"match?": type("string > 0").describe("watch: JS RegExp source (u flag); only matching output is reported"),
	"maxEvents?": type("number >= 1").describe("watch: matching output events before the watch stops itself"),
	"label?": type("string <= 48").describe("watch: short display label"),
	"name?": type("string <= 48").describe("start: stable project-scoped process name"),
	"application?": type("string > 0").describe("start: executable or application path"),
	"args?": type("string[]").describe("start: argv passed directly to the application"),
	"env?": type({ "[string]": "string" }).describe("start: extra environment variables"),
	"cwd?": type("string").describe("start/watch command: working directory; defaults to the session directory"),
	"pty?": type("boolean").describe("start: allocate an interactive PTY; default true"),
	"ready?": type({
		"log?": type("string > 0").describe("regex matched against output"),
		"port?": type("number").describe("TCP port that must accept connections"),
		"host?": type("string > 0").describe("TCP readiness host; default 127.0.0.1"),
		"timeoutMs?": type("number > 0").describe("milliseconds to wait; default 30000"),
	}).describe("start: readiness conditions; all supplied conditions must pass"),
	"restart?": type("'no' | 'on-failure' | 'always'").describe("start: restart policy; default no"),
	"persist?": type("boolean").describe("start: survive the last proto client exiting; default false"),
	"detached?": type("boolean").describe("start: survive every proto and broker exit; implies persist, no PTY"),
	"lines?": type("number > 0").describe("logs: output lines; default 100, max 1000"),
	"head?": type("boolean").describe("logs: read from the beginning instead of the tail"),
	"grep?": type("string > 0").describe("logs: regex filter"),
	"follow?": type("boolean").describe("logs: wait for output newer than cursor"),
	"cursor?": type("number >= 0").describe("logs/watch process: log byte cursor from an earlier logs call"),
	"text?": type("string > 0").describe("input: stdin text"),
	"enter?": type("boolean").describe("input: append Enter after text; default true"),
	"keys?": type("string[]").describe(
		"input: terminal keys after text: Enter, Tab, Escape, Up, Down, Left, Right, or control chords such as C-c, ctrl+d, ^D",
	),
	"signal?": type("'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'").describe("signal: process-tree signal"),
	"timeoutMs?": type("number >= 0").describe(
		"wait: window (0 = until woken); logs: follow timeout; cancel/unwatch: teardown grace; watch: lifetime",
	),
});

export type JobsParams = typeof jobsSchema.infer;

const OP_FIELDS: Record<JobsOp, readonly string[]> = {
	list: ["kind", "scope"],
	inspect: ["target", "afterEvent"],
	start: ["name", "application", "args", "env", "cwd", "pty", "ready", "restart", "persist", "detached"],
	logs: ["target", "lines", "head", "grep", "follow", "cursor", "timeoutMs"],
	input: ["target", "text", "enter", "keys"],
	signal: ["target", "signal"],
	restart: ["target"],
	cancel: ["target", "timeoutMs"],
	watch: ["source", "command", "everyMs", "match", "maxEvents", "label", "cwd", "cursor", "timeoutMs"],
	unwatch: ["target", "timeoutMs"],
	wait: ["targets", "mailbox", "timeoutMs"],
};

const TARGET_KINDS: Partial<Record<JobsOp, readonly ExecutionRef["kind"][]>> = {
	inspect: ["job", "process", "watch"],
	logs: ["process"],
	input: ["process"],
	signal: ["process"],
	restart: ["process"],
	cancel: ["job", "process"],
	unwatch: ["watch"],
};

const DEFAULT_TEARDOWN_GRACE_MS = 5_000;
const MAX_TEARDOWN_GRACE_MS = 30_000;

type TargetRef = JobsParams["target"];

function validationError(op: JobsOp, params: Record<string, unknown>): string | undefined {
	const allowed = new Set(["op", ...OP_FIELDS[op]]);
	const extra = Object.keys(params).filter(key => params[key] !== undefined && !allowed.has(key));
	if (extra.length > 0) {
		return `op "${op}" does not accept ${extra.join(", ")}; it accepts ${OP_FIELDS[op].join(", ") || "no other fields"}.`;
	}
	const target = params.target as TargetRef;
	const kinds = TARGET_KINDS[op];
	if (kinds) {
		if (!target) return `op "${op}" requires target {kind, id${kinds.includes("process") ? ", name" : ""}}.`;
		if (!kinds.includes(target.kind)) {
			const hint =
				target.kind === "watch"
					? ' Stop a watch with op "unwatch".'
					: op === "unwatch"
						? ' Cancel jobs and processes with op "cancel".'
						: "";
			return `op "${op}" does not act on ${target.kind} references (accepts ${kinds.join(", ")}).${hint}`;
		}
	}
	for (const ref of [target, params.source as TargetRef, ...((params.targets as TargetRef[] | undefined) ?? [])]) {
		if (ref?.kind === "process" && !ref.name) return `process reference ${ref.id} requires name.`;
		if (ref && ref.kind !== "process" && ref.name !== undefined) return `${ref.kind} references do not take name.`;
	}
	if (op === "watch") {
		if ((params.source === undefined) === (params.command === undefined)) {
			return "watch requires exactly one of source (existing job/process) or command (helper probe).";
		}
		if (params.source !== undefined && (params.everyMs !== undefined || params.cwd !== undefined)) {
			return "everyMs and cwd apply only to command probes.";
		}
		if (params.cursor !== undefined && (params.source as TargetRef)?.kind !== "process") {
			return "cursor applies only to process sources.";
		}
	}
	if (op === "input" && params.text === undefined && !(params.keys as string[] | undefined)?.length) {
		return "input requires text or keys.";
	}
	if (op === "signal" && params.signal === undefined) return "signal requires signal.";
	if (op === "start" && (params.name === undefined || params.application === undefined)) {
		return "start requires name and application.";
	}
	if (op === "wait" && params.targets !== undefined && (params.targets as unknown[]).length === 0) {
		return "wait targets must not be empty; omit targets for a bare wait.";
	}
	return undefined;
}

function refJson(ref: ExecutionRef): string {
	return JSON.stringify(ref);
}

function withText(result: JobsResult, prefix: string[]): JobsResult {
	const body = result.content.find(part => part.type === "text")?.text ?? "";
	return { ...result, content: [{ type: "text", text: [...prefix, body].filter(Boolean).join("\n") }] };
}

export class JobsTool implements AgentTool<typeof jobsSchema, JobsDetails> {
	readonly name = "jobs";
	readonly label = "Jobs";
	readonly summary = "Observe and control background jobs, supervised processes, watches and waits";
	readonly description: string;
	readonly parameters = jobsSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly interruptible = (params: Partial<JobsParams>): boolean =>
		params.op === "wait" || (params.op === "logs" && params.follow === true);

	readonly examples: readonly ToolExample<JobsParams>[] = [
		{ caption: "Snapshot your jobs, watches and this session's processes", call: { op: "list" } },
		{
			caption: "Start a dev server and wait for its banner and port",
			call: {
				op: "start",
				name: "web",
				application: "bun",
				args: ["run", "dev"],
				ready: { log: "Local:.*http", port: 5173, timeoutMs: 30_000 },
			},
		},
		{
			caption: "Wake on errors from a running process without a helper tail",
			call: {
				op: "watch",
				source: { kind: "process", id: "returned-id", name: "web" },
				match: "ERROR",
				maxEvents: 5,
			},
		},
		{
			caption: "Poll a health endpoint until it changes",
			call: {
				op: "watch",
				command: "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/health",
				everyMs: 15_000,
				match: "200",
				timeoutMs: 900_000,
			},
		},
		{
			caption: "Block until a worker turn finishes or a peer replies",
			call: { op: "wait", targets: [{ kind: "job", id: "returned-turn-job-id" }], mailbox: {}, timeoutMs: 30_000 },
		},
		{ caption: "Bare wait: first job, watch event or message", call: { op: "wait" } },
		{
			caption: "Follow process output after a cursor",
			call: {
				op: "logs",
				target: { kind: "process", id: "returned-id", name: "web" },
				follow: true,
				cursor: 1842,
				timeoutMs: 30_000,
			},
		},
		{
			caption: "Interrupt a REPL",
			call: { op: "input", target: { kind: "process", id: "returned-id", name: "repl" }, keys: ["C-c"] },
		},
		{ caption: "Cancel a background job", call: { op: "cancel", target: { kind: "job", id: "bg_3" } } },
	];

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(jobsDescription);
	}

	async execute(
		_toolCallId: string,
		params: JobsParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<JobsDetails>,
		_context?: AgentToolContext,
	): Promise<JobsResult> {
		const op = params.op;
		const invalid = validationError(op, params as Record<string, unknown>);
		if (invalid) return jobsErrorResult(invalid, op);
		switch (op) {
			case "list":
				return this.#list(params);
			case "inspect":
				return this.#inspect(params.target!, params.afterEvent, signal);
			case "start":
				return this.#start(params, signal);
			case "logs":
			case "input":
			case "signal":
			case "restart":
				return this.#processControl(op, params, signal);
			case "cancel":
				return this.#cancel(params.target!, params.timeoutMs, signal);
			case "watch":
				return this.#watch(params, signal);
			case "unwatch":
				return this.#unwatch(params.target as WatchRef, params.timeoutMs);
			case "wait":
				return executeWait(
					this.session,
					{
						...(params.targets ? { targets: params.targets as ExecutionRef[] } : {}),
						...(params.mailbox ? { mailbox: params.mailbox } : {}),
						...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
					},
					signal,
					onUpdate,
				);
		}
	}

	#launchDisabled(op: JobsOp): JobsResult | undefined {
		return this.session.settings.get("launch.enabled")
			? undefined
			: jobsErrorResult("Process supervision is disabled (launch.enabled=false).", op);
	}

	async #launch(op: JobsOp, params: LaunchParams, signal?: AbortSignal): Promise<JobsResult> {
		const result = await executeLaunch(this.session, params, signal);
		const daemon = result.details?.daemon;
		const ref: ProcessRef | undefined = daemon ? { kind: "process", id: daemon.id, name: daemon.name } : undefined;
		return {
			content: [
				{
					type: "text",
					text: [result.content.find(part => part.type === "text")?.text ?? "", ref ? `Ref: ${refJson(ref)}` : ""]
						.filter(Boolean)
						.join("\n"),
				},
			],
			details: { op, ...(result.details ? { process: result.details } : {}), ...(ref ? { ref } : {}) },
		};
	}

	async #list(params: JobsParams): Promise<JobsResult> {
		const manager = this.session.asyncJobManager;
		const ownerId = asyncJobOwner(this.session);
		const wantsJobs = params.kind === undefined || params.kind === "job" || params.kind === "watch";
		// Observation only: listing never acknowledges a settled job's pending delivery.
		const jobs =
			wantsJobs && manager
				? manager
						.getAllJobs({ ownerId })
						.filter(job => job.ownerId === ownerId)
						.filter(job => params.kind === undefined || refForJob(job).kind === params.kind)
						.map(job => snapshotJob(manager, job))
				: [];
		const lines = jobs.length > 0 ? await describeJobs(this.session, jobs) : [];
		if (wantsJobs && !manager) lines.push("Async execution is disabled; no background jobs or watches.");
		let process: JobsDetails["process"];
		if (params.kind === undefined || params.kind === "process") {
			if (this.session.settings.get("launch.enabled")) {
				const listed = await executeLaunch(this.session, { op: "list", all: params.scope === "project" });
				process = listed.details;
				lines.push(`## Processes (${params.scope ?? "session"})\n`);
				for (const daemon of listed.details?.daemons ?? []) {
					lines.push(
						`- ${refJson({ kind: "process", id: daemon.id, name: daemon.name })} ${daemon.state}${daemon.exitCode === undefined ? "" : ` exit=${daemon.exitCode}`}${daemon.detached ? " detached" : daemon.persist ? " persistent" : ""}`,
					);
				}
				if ((listed.details?.daemons ?? []).length === 0) lines.push("No processes.");
			} else if (params.kind === "process") {
				return jobsErrorResult("Process supervision is disabled (launch.enabled=false).", "list");
			}
		}
		return {
			content: [{ type: "text", text: lines.join("\n").trimEnd() || "No jobs, watches or processes." }],
			details: { op: "list", jobs, ...(process ? { process } : {}) },
		};
	}

	#ownedOrError(op: JobsOp, ref: JobRef | WatchRef): AsyncJob | JobsResult {
		const manager = this.session.asyncJobManager;
		if (!manager) return jobsErrorResult("Async execution is disabled; no background jobs or watches.", op);
		return (
			ownedJob(manager, asyncJobOwner(this.session), ref) ??
			jobsErrorResult(
				`No owned ${ref.kind} ${ref.id}. It expired, belongs to another owner, or is a different kind; list your references with op "list".`,
				op,
			)
		);
	}

	async #inspect(
		target: NonNullable<TargetRef>,
		afterEvent: number | undefined,
		signal?: AbortSignal,
	): Promise<JobsResult> {
		if (afterEvent !== undefined && target.kind !== "watch") {
			return jobsErrorResult("afterEvent applies only to watch references.", "inspect");
		}
		if (target.kind === "process") {
			return (
				this.#launchDisabled("inspect") ??
				this.#launch("inspect", { op: "describe", name: target.name!, expectedId: target.id }, signal)
			);
		}
		const job = this.#ownedOrError("inspect", target as JobRef | WatchRef);
		if (!("id" in job)) return job;
		const manager = this.session.asyncJobManager!;
		const snapshot = snapshotJob(manager, job);
		const lines = await describeJobs(this.session, [snapshot]);
		if (target.kind !== "watch") {
			return { content: [{ type: "text", text: lines.join("\n") }], details: { op: "inspect", jobs: [snapshot] } };
		}
		const page = manager.readEvents(job.id, afterEvent ?? 0);
		lines.push("", `## Retained events after #${afterEvent ?? 0} (next cursor ${page.cursor})`);
		if (page.gap) {
			lines.push(`Gap: events #${page.gap.from}–#${page.gap.to} expired from retention and cannot be read.`);
		}
		for (const event of page.events) lines.push(`- #${event.sequence} ${event.kind}: ${event.text}`);
		if (page.events.length === 0) lines.push("No newer retained events.");
		if (page.more) lines.push(`More retained events follow; inspect again with afterEvent ${page.cursor}.`);
		lines.push("Inspecting does not consume events; unread events still arrive automatically.");
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "inspect", jobs: [snapshot], events: page },
		};
	}

	async #start(params: JobsParams, signal?: AbortSignal): Promise<JobsResult> {
		const disabled = this.#launchDisabled("start");
		if (disabled) return disabled;
		if (params.ready && Object.keys(params.ready).some(key => !["log", "port", "host", "timeoutMs"].includes(key))) {
			return jobsErrorResult("Unknown readiness parameter.", "start");
		}
		const { op: _op, ...rest } = params;
		return this.#launch("start", { ...rest, op: "start" } as LaunchParams, signal);
	}

	async #processControl(
		op: "logs" | "input" | "signal" | "restart",
		params: JobsParams,
		signal?: AbortSignal,
	): Promise<JobsResult> {
		const disabled = this.#launchDisabled(op);
		if (disabled) return disabled;
		const target = params.target!;
		const pinned = { name: target.name!, expectedId: target.id };
		switch (op) {
			case "logs":
				return this.#launch(
					op,
					{
						op: "logs",
						...pinned,
						lines: params.lines,
						head: params.head,
						grep: params.grep,
						follow: params.follow,
						cursor: params.cursor,
						timeoutMs: params.timeoutMs,
					},
					signal,
				);
			case "input":
				return this.#launch(
					op,
					{ op: "send", ...pinned, text: params.text, enter: params.enter, keys: params.keys },
					signal,
				);
			case "signal":
				return this.#launch(op, { op: "send", ...pinned, signal: params.signal }, signal);
			case "restart": {
				const result = await this.#launch(op, { op: "restart", ...pinned }, signal);
				return withText(result, [
					`Restart created a new incarnation; ${refJson(target as ExecutionRef)} is now stale and any watch on it has ended. Use the new reference below.`,
				]);
			}
		}
	}

	async #settleWithin(job: AsyncJob, graceMs: number | undefined): Promise<boolean> {
		const manager = this.session.asyncJobManager!;
		const bound = Math.min(MAX_TEARDOWN_GRACE_MS, graceMs ?? DEFAULT_TEARDOWN_GRACE_MS);
		if (!manager.isSettled(job.id) && bound > 0) {
			const timer = Promise.withResolvers<void>();
			const handle = setTimeout(timer.resolve, bound);
			try {
				await Promise.race([job.promise, timer.promise]);
			} finally {
				clearTimeout(handle);
			}
		}
		return manager.isSettled(job.id);
	}

	async #cancel(
		target: NonNullable<TargetRef>,
		graceMs: number | undefined,
		signal?: AbortSignal,
	): Promise<JobsResult> {
		if (target.kind === "process") {
			const disabled = this.#launchDisabled("cancel");
			if (disabled) return disabled;
			const result = await this.#launch(
				"cancel",
				{ op: "stop", name: target.name!, expectedId: target.id, timeoutMs: graceMs },
				signal,
			);
			const state = result.details?.process?.daemon?.state;
			const settled = state === "exited" || state === "failed";
			const receipt: CancelReceipt = {
				ref: target as ProcessRef,
				status: settled ? "settled" : "requested",
				message: settled
					? `Process ${target.name} stopped.`
					: `Stop requested for process ${target.name}; it is still ${state ?? "stopping"}.`,
			};
			return { ...withText(result, [receipt.message]), details: { ...result.details!, receipt } };
		}
		const job = this.#ownedOrError("cancel", target as JobRef);
		if (!("id" in job)) return job;
		const manager = this.session.asyncJobManager!;
		const ref = refForJob(job);
		let receipt: CancelReceipt;
		if (job.status !== "running") {
			receipt = { ref, status: "already_settled", message: `Job ${job.id} is already ${job.status}.` };
		} else {
			manager.cancel(job.id, { ownerId: asyncJobOwner(this.session) });
			const settled = await this.#settleWithin(job, graceMs);
			const worker =
				job.type === "worker"
					? ` The worker agent ${job.agentId ?? ""} remains addressable; terminate it through fleet.`
					: "";
			receipt = {
				ref,
				status: settled ? "settled" : "requested",
				message: settled
					? `Cancelled job ${job.id}.${worker}`
					: `Cancellation of job ${job.id} was requested; teardown has not finished yet.${worker}`,
			};
		}
		return {
			content: [{ type: "text", text: receipt.message }],
			details: { op: "cancel", jobs: [snapshotJob(manager, job)], receipt },
		};
	}

	async #watch(params: JobsParams, signal?: AbortSignal): Promise<JobsResult> {
		const manager = this.session.asyncJobManager;
		const ownerId = asyncJobOwner(this.session);
		if (!this.session.settings.get("monitor.enabled")) {
			return jobsErrorResult("Watches are disabled (monitor.enabled=false).", "watch");
		}
		if (!manager || !ownerId) {
			return jobsErrorResult("Watches require async execution and a session owner.", "watch");
		}
		let source: WatchSource | undefined;
		const requested = params.source;
		if (requested?.kind === "watch") {
			return jobsErrorResult("A watch cannot observe another watch; wait on it instead.", "watch");
		}
		if (requested?.kind === "process") {
			const disabled = this.#launchDisabled("watch");
			if (disabled) return disabled;
			const ref: ProcessRef = { kind: "process", id: requested.id, name: requested.name! };
			const client = await daemonClientForProject(sessionProjectCwd(this.session));
			try {
				const described = await client.request({ op: "describe", name: ref.name, expectedId: ref.id }, signal);
				if (described.op !== "describe") throw new Error(`Unexpected broker result ${described.op}`);
				source = processWatchSource(client, ref, params.cursor ?? described.daemon.outputBytes);
			} catch (error) {
				return jobsErrorResult(error instanceof Error ? error.message : String(error), "watch");
			}
		} else if (requested?.kind === "job") {
			const job = this.#ownedOrError("watch", { kind: "job", id: requested.id });
			if (!("id" in job)) return job;
			source = jobWatchSource(manager, job);
		}
		try {
			const snapshot = startMonitor(
				manager,
				{
					...(params.command !== undefined ? { command: params.command } : {}),
					...(source ? { source } : {}),
					label: params.label,
					cwd: params.cwd,
					match: params.match,
					everyMs: params.everyMs,
					maxEvents: params.maxEvents,
					timeoutMs: params.timeoutMs,
				},
				{ ownerId, settings: this.session.settings, cwd: this.session.cwd },
			);
			const ref: WatchRef = { kind: "watch", id: snapshot.id };
			const job = manager.getJob(snapshot.id)!;
			const target = source
				? `Observing ${source.description} (not owned: unwatch leaves it running).`
				: `Helper command \`${snapshot.command}\` in ${snapshot.cwd} is owned by this watch and reaped when it stops.`;
			const text = [
				`Watch ${refJson(ref)} started (${snapshot.mode}).`,
				target,
				snapshot.match === undefined
					? "Reporting every output line."
					: `Reporting output matching /${snapshot.match}/u.`,
				`Stops after ${snapshot.maxEvents} matching events${snapshot.timeoutMs ? `, after ${snapshot.timeoutMs}ms` : ""}, when the source ends, or on unwatch.`,
				"Each event arrives as a message that wakes you; do other work or end your turn — do not poll.",
			].join("\n");
			return { content: [{ type: "text", text }], details: { op: "watch", ref, jobs: [snapshotJob(manager, job)] } };
		} catch (error) {
			return jobsErrorResult(error instanceof Error ? error.message : String(error), "watch");
		}
	}

	async #unwatch(target: WatchRef, graceMs: number | undefined): Promise<JobsResult> {
		const job = this.#ownedOrError("unwatch", target);
		if (!("id" in job)) return job;
		const manager = this.session.asyncJobManager!;
		let receipt: CancelReceipt;
		if (job.status !== "running") {
			receipt = {
				ref: target,
				status: "already_settled",
				message: `Watch ${job.id} already stopped (${job.status}).`,
			};
		} else {
			manager.cancel(job.id, { ownerId: asyncJobOwner(this.session) });
			const settled = await this.#settleWithin(job, graceMs);
			const owned = job.monitor?.source ? "The observed source keeps running." : "Its helper command was reaped.";
			receipt = {
				ref: target,
				status: settled ? "settled" : "requested",
				message: settled
					? `Stopped watch ${job.id}. ${owned}`
					: `Stop requested for watch ${job.id}; its helper is still being reaped.`,
			};
		}
		return {
			content: [{ type: "text", text: receipt.message }],
			details: { op: "unwatch", jobs: [snapshotJob(manager, job)], receipt },
		};
	}
}

type JobsRenderArgs = Partial<JobsParams>;

function processRenderArgs(args: JobsRenderArgs | undefined): LaunchRenderArgs {
	const target = args?.target;
	const op =
		args?.op === "input" || args?.op === "signal"
			? "send"
			: args?.op === "cancel"
				? "stop"
				: args?.op === "inspect"
					? "describe"
					: args?.op;
	return { ...(args as LaunchRenderArgs), op, ...(target?.name ? { name: target.name } : {}) };
}

function isProcessCall(args: JobsRenderArgs | undefined): boolean {
	if (!args?.op) return false;
	if (args.op === "start") return true;
	if (args.op === "list") return args.kind === "process";
	return args.target?.kind === "process";
}

function describeCall(args: JobsRenderArgs | undefined): string {
	if (!args?.op) return "Jobs";
	const ref = args.target ?? args.source;
	const subject = ref
		? `${ref.kind} ${ref.name ?? ref.id}`
		: args.command
			? args.command
			: args.op === "wait"
				? args.targets
					? `${args.targets.length} target${args.targets.length === 1 ? "" : "s"}${args.mailbox ? " + mailbox" : ""}`
					: args.mailbox
						? "mailbox"
						: "all running jobs"
				: "";
	const title = `Jobs ${args.op}${subject ? ` ${subject}` : ""}`;
	return truncateToWidth(replaceTabs(sanitizeText(title)), TRUNCATE_LENGTHS.TITLE);
}

function stack(parts: Component[]): Component {
	return {
		render: width => parts.flatMap(part => part.render(width)),
		invalidate: () => {
			for (const part of parts) part.invalidate?.();
		},
	};
}

export const jobsToolRenderer = {
	inline: true,
	mergeCallAndResult: true,

	animatedPendingPreview: (args: unknown): boolean => isProcessCall(args as JobsRenderArgs | undefined),

	renderCall(args: JobsRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		// The process renderer shows the process name itself.
		if (isProcessCall(args)) return launchRenderCall(processRenderArgs(args), options, uiTheme, `Jobs ${args.op}`);
		return new Text(renderStatusLine({ icon: "pending", title: describeCall(args) }, uiTheme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: JobsDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: JobsRenderArgs,
	): Component {
		const details = result.details;
		const text = result.content?.find(part => part.type === "text")?.text ?? "";
		const title = describeCall(args);
		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title }, uiTheme);
			return new Text([header, formatErrorDetail(text || "Jobs failed", uiTheme)].join("\n"), 0, 0);
		}
		const parts: Component[] = [];
		if (details?.jobs && (details.jobs.length > 0 || !details.process)) {
			parts.push(
				renderJobTree(
					details.jobs,
					text,
					options,
					uiTheme,
					title,
					details.op === "wait" && !details.timedOut && !details.message,
				),
			);
		}
		if (details?.process) {
			parts.push(
				launchRenderResult(
					{ ...result, details: details.process },
					options,
					uiTheme,
					processRenderArgs(args),
					`Jobs ${details.op}`,
				),
			);
		}
		if (details?.message) {
			const header = renderStatusLine(
				{ icon: "info", title: `${title}: message from ${details.message.from}` },
				uiTheme,
			);
			parts.push(
				new Text(
					[header, uiTheme.fg("toolOutput", replaceTabs(sanitizeText(details.message.body)))].join("\n"),
					0,
					0,
				),
			);
		}
		if (parts.length === 0) {
			const header = renderStatusLine({ icon: details?.timedOut ? "warning" : "success", title }, uiTheme);
			parts.push(new Text([header, uiTheme.fg("dim", replaceTabs(sanitizeText(text)))].join("\n"), 0, 0));
		}
		return parts.length === 1 ? parts[0]! : stack(parts);
	},
};
