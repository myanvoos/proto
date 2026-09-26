import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { DEFAULT_KERNEL_IDLE_REAP_MS } from "../eval/idle-timeout";
import {
	handleKernelControl,
	type KernelControlResult,
	type KernelSnapshot,
	listConfiguredKernelLanes,
	listOwnedKernels,
	reserveLaneKernelRelease,
} from "../eval/kernel-control";
import type { KernelLanguage } from "../eval/kernel-environment";
import {
	type BashLaneControl,
	type BashLaneSnapshot,
	beginBashLaneControl,
	listBashLanes,
} from "../exec/bash-executor";
import { currentExecutionOrigin } from "../jobs/origin";
import contextDescription from "../prompts/tools/context.md" with { type: "text" };
import type { ToolSession } from ".";

const targetOptions = {
	"cwd?": type("string > 0").describe("Absolute directory on the target"),
	"interpreter?": type("string > 0").describe("Interpreter executable on the target"),
	"hostCommand?": type("string[]").describe("Installed compatible proto CLI argv for a remote bun kernel"),
	"+": "reject",
} as const;
const targetSchema = type({ kind: "'local'", "+": "reject" })
	.or(type({ kind: "'container'", container: "string > 0", "engine?": "'docker' | 'podman'", ...targetOptions }))
	.or(type({ kind: "'ssh'", host: "string > 0", ...targetOptions }));

// Flat wire schema: proto derives CLI flags from top-level properties. Which fields
// each resource/op accepts is enforced by parseContextArgs before any side effect.
export const contextSchema = type({
	resource: type("'lane' | 'kernel'").describe("lane: bash lane queue/shell/kernels; kernel: one named kernel"),
	op: type("'list' | 'start' | 'inspect' | 'keepalive' | 'reset' | 'close'").describe(
		"lane: list|inspect|reset|close; kernel: list|start|inspect|keepalive|reset|close",
	),
	"lane?": type("1 <= string <= 128").describe(
		"Lane name; required for lane inspect/reset/close; kernel ops default to main (all lanes for list)",
	),
	"language?": type("'python' | 'node' | 'bun'").describe("kernel only; required except for list"),
	"interpreter?": type("string > 0").describe(
		"kernel only: start/reset make it the lane default; other ops pick that interpreter's kernel",
	),
	"cwd?": type("string > 0").describe("kernel start/reset only: lane working directory"),
	"target?": targetSchema.describe("kernel start/reset only: execution environment; defaults to local"),
	"ttlMs?": type("1 <= number <= 3600000").describe(
		"kernel only: integer keepalive lease in milliseconds; required for keepalive, optional for start/reset",
	),
	"force?": type("boolean").describe("close only: cancel running or queued work instead of refusing a busy target"),
	"+": "reject",
});

type ContextParams = typeof contextSchema.infer;

export interface LaneControlArgs {
	resource: "lane";
	op: "list" | "inspect" | "reset" | "close";
	lane?: string;
	force?: boolean;
}

/** Host-owned lane metadata: queue and shell state plus attached kernel summaries, never heap values or env. */
export interface LaneSnapshot extends BashLaneSnapshot {
	state: "idle" | "busy" | "controlling";
	kernels: KernelSnapshot[];
	/** Languages whose selected kernel environment is retained for this lane (survives idle reaping and reset). */
	configured: KernelLanguage[];
}

export interface LaneControlResult {
	resource: "lane";
	op: LaneControlArgs["op"];
	lanes?: LaneSnapshot[];
	lane?: LaneSnapshot | string;
	/** Work accepted before the control: the admitted command and queued commands that will never run. */
	cancelled?: { active: number; queued: number };
	shellsDiscarded?: number;
	/** Kernels released; the next cell on the lane starts a new generation. */
	kernelsReleased?: KernelSnapshot[];
	/** Reset: kernel environments kept for the next generation. Close: forgotten ones. */
	retained?: KernelLanguage[];
	forgotten?: KernelLanguage[];
	closed?: boolean;
}

export type ContextToolDetails = LaneControlResult | (KernelControlResult & { resource: "kernel" });

const LANE_OPS: readonly string[] = ["list", "inspect", "reset", "close"];
const LANE_FIELDS: readonly string[] = ["resource", "op", "lane", "force"];

export function parseContextArgs(value: unknown): LaneControlArgs | ({ resource: "kernel" } & Record<string, unknown>) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("context arguments must be an object");
	const args = value as Record<string, unknown>;
	if (args.resource === "kernel") return { ...args, resource: "kernel" };
	if (args.resource !== "lane") throw new Error("resource must be lane or kernel");
	for (const key of Object.keys(args))
		if (!LANE_FIELDS.includes(key)) throw new Error(`${key} is not valid for resource lane`);
	if (typeof args.op !== "string" || !LANE_OPS.includes(args.op))
		throw new Error(`lane operation must be ${LANE_OPS.join(", ")}`);
	if (args.lane !== undefined) {
		if (
			typeof args.lane !== "string" ||
			args.lane.length < 1 ||
			args.lane.length > 128 ||
			/[\0\r\n]/u.test(args.lane)
		)
			throw new Error("lane must contain 1–128 characters without NUL or newlines");
		if (args.op === "list") throw new Error("list reports every lane; use inspect for one lane");
	} else if (args.op !== "list") throw new Error(`lane ${args.op} requires lane`);
	if (args.force !== undefined) {
		if (typeof args.force !== "boolean") throw new Error("force must be a boolean");
		if (args.op !== "close") throw new Error("force is only valid for close; reset always cancels lane work");
	}
	return args as unknown as LaneControlArgs;
}

function laneOwner(session: ToolSession): string {
	const sessionKey = session.getSessionId?.() ?? undefined;
	if (!sessionKey) throw new Error("Lane control requires a session id");
	return sessionKey;
}

function collectLanes(session: ToolSession): Map<string, LaneSnapshot> {
	const lanes = new Map<string, LaneSnapshot>();
	const entry = (lane: string): LaneSnapshot => {
		let snapshot = lanes.get(lane);
		if (!snapshot) {
			snapshot = {
				lane,
				state: "idle",
				queued: 0,
				controlling: false,
				shell: "none",
				stateLossPending: false,
				kernels: [],
				configured: [],
			};
			lanes.set(lane, snapshot);
		}
		return snapshot;
	};
	for (const bash of listBashLanes(laneOwner(session))) Object.assign(entry(bash.lane), bash);
	for (const kernel of listOwnedKernels(session)) entry(kernel.lane).kernels.push(kernel);
	for (const [lane, languages] of listConfiguredKernelLanes(session)) entry(lane).configured = languages.toSorted();
	for (const snapshot of lanes.values()) {
		const kernelBusy = snapshot.kernels.some(kernel => kernel.state !== "idle" && kernel.state !== "dead");
		snapshot.state = snapshot.controlling
			? "controlling"
			: snapshot.activeSince !== undefined || snapshot.queued > 0 || kernelBusy
				? "busy"
				: "idle";
	}
	return lanes;
}

function rejectSelfControl(op: string, lane: string): void {
	if (currentExecutionOrigin()?.lane !== lane) return;
	throw new Error(
		`Cannot ${op} lane ${lane} from a command running in it: the control would cancel itself. Issue it from a separate bash lane (e.g. lane "control") or a direct tool call.`,
	);
}

async function controlLane(
	session: ToolSession,
	args: LaneControlArgs & { op: "reset" | "close" },
): Promise<LaneControlResult> {
	const lane = args.lane!;
	rejectSelfControl(args.op, lane);
	const sessionKey = laneOwner(session);
	const known = collectLanes(session).get(lane);
	if (!known) throw new Error(`Unknown lane: ${lane}`);
	// Reserve the lane's kernels first: it is the only step that can refuse, and it has no side effect.
	const kernels = reserveLaneKernelRelease(session, lane);
	let control: BashLaneControl;
	try {
		control = beginBashLaneControl(sessionKey, lane);
	} catch (error) {
		kernels.abandon();
		throw error;
	}
	try {
		const pending = control.pending();
		if (args.op === "close" && args.force !== true && (pending.active + pending.queued > 0 || kernels.busy))
			throw new Error(
				`Lane ${lane} is busy (${pending.active} running, ${pending.queued} queued command(s)${kernels.busy ? ", kernel busy" : ""}); close requires force:true`,
			);
		const cancelled = control.cancel(args.op);
		const kernelFailure = await kernels.run(args.op).then(
			() => undefined,
			(error: unknown) => error,
		);
		await control.drain();
		const shellsDiscarded = await control.discardShells(
			args.op === "reset" ? "was reset by context control" : undefined,
		);
		if (kernelFailure) throw kernelFailure;
		return {
			resource: "lane",
			op: args.op,
			lane,
			cancelled,
			shellsDiscarded,
			kernelsReleased: kernels.kernels,
			...(args.op === "reset"
				? { retained: collectLanes(session).get(lane)?.configured ?? [] }
				: { forgotten: known.configured, closed: true }),
		};
	} finally {
		kernels.abandon();
		control.finish();
	}
}

export async function handleContextControl(
	session: ToolSession,
	value: unknown,
	signal?: AbortSignal,
): Promise<ContextToolDetails> {
	const args = parseContextArgs(value);
	signal?.throwIfAborted();
	if (args.resource === "kernel") {
		const { resource: _resource, ...kernelArgs } = args;
		return { resource: "kernel", ...(await handleKernelControl(session, kernelArgs, signal)) };
	}
	const laneArgs = args as LaneControlArgs;
	if (laneArgs.op === "list")
		return {
			resource: "lane",
			op: "list",
			lanes: [...collectLanes(session).values()].sort((a, b) => a.lane.localeCompare(b.lane)),
		};
	if (laneArgs.op === "inspect") {
		const lane = collectLanes(session).get(laneArgs.lane!);
		if (!lane) throw new Error(`Unknown lane: ${laneArgs.lane}`);
		return { resource: "lane", op: "inspect", lane };
	}
	return await controlLane(session, { ...laneArgs, op: laneArgs.op });
}

export class ContextTool implements AgentTool<typeof contextSchema, ContextToolDetails> {
	readonly name = "context";
	readonly label = "Context";
	readonly summary = "Inspect and control this session's bash lanes and named Python, Node.js, and Bun kernels";
	readonly description: string;
	readonly parameters = contextSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<ContextParams>): string =>
		`${args.op ?? "inspecting"} ${args.resource ?? "context"} ${args.lane ?? (args.resource === "lane" ? "" : "main")}`.trim();

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(contextDescription, { idleReapMinutes: DEFAULT_KERNEL_IDLE_REAP_MS / 60_000 });
	}

	async execute(
		_toolCallId: string,
		params: ContextParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ContextToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ContextToolDetails>> {
		const result = await handleContextControl(this.session, params, signal);
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	}
}
