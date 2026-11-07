import { type AgentToolUpdateCallback, TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobEvent, AsyncJobManager } from "../../async";
import { sessionProjectCwd } from "../../eval/bridge-cwd";
import { IrcBus, type IrcMessage, ircWaitAccepts } from "../../irc/bus";
import type { JobsWaitRequest, ProcessRef, WaitParticipant } from "../../jobs/contracts";
import { withJobWait } from "../../jobs/wait";
import { daemonClientForProject } from "../../launch/client";
import { DAEMON_MAX_TIMEOUT_MS, DaemonBrokerRejectedError, type DaemonSnapshot } from "../../launch/protocol";
import { OrchestratorRuntime } from "../../orchestrator/runtime";
import type { ToolSession } from "..";
import { drainPendingInbox } from "../fleet/messaging";
import { asyncJobOwner, describeJobs, ownedJob, snapshotJob } from "./jobs";
import { claimProcessCompletion } from "./launch";
import { type JobsDetails, type JobsResult, jobsErrorResult } from "./types";

const WAIT_DURATION_MS: Record<string, number> = {
	"5s": 5_000,
	"10s": 10_000,
	"30s": 30_000,
	"1m": 60_000,
	"5m": 5 * 60_000,
};
const PROGRESS_INTERVAL_MS = 500;
/** After one watched job settles, keep collecting briefly so near-simultaneous completions share one wait result. */
const WAIT_SETTLE_WINDOW_MS = 1_500;
export const MAX_WAIT_TARGETS = 32;

interface Mailbox {
	registry: NonNullable<ToolSession["agentRegistry"]>;
	agentId: string;
	fleetRoot?: string;
	from?: string;
}

interface ProcessExit {
	ref: ProcessRef;
	daemon?: DaemonSnapshot;
	replaced: boolean;
	/** False when automatic completion delivery already reported this exit. */
	fresh: boolean;
}

function mailboxFor(session: ToolSession, from: string | undefined): Mailbox | undefined {
	const registry = session.agentRegistry;
	const agentId = session.getAgentId?.() ?? undefined;
	if (!registry || !agentId) return undefined;
	return { registry, agentId, fleetRoot: session.getAgentFleetRoot?.(), from: from?.trim() || undefined };
}

function takeQueuedMessages(mailbox: Mailbox, woke?: IrcMessage): IrcMessage[] {
	const bus = IrcBus.global();
	const queued = woke ? [woke] : [];
	let next = bus.take(mailbox.agentId, mailbox.from, mailbox.fleetRoot);
	while (next !== undefined) {
		queued.push(next);
		next = bus.take(mailbox.agentId, mailbox.from, mailbox.fleetRoot);
	}
	// Without a wake, take the session inbox only when it holds a message that
	// ends a wait: broadcast legs alone stay queued and inject as asides after
	// the wait returns. Mailbox mail reaches the caller only through here.
	const ifAny = queued.length > 0 ? undefined : (msg: IrcMessage) => ircWaitAccepts({ directOnly: true }, msg);
	queued.push(...drainPendingInbox(mailbox.registry, mailbox.agentId, ifAny, mailbox.fleetRoot));
	// Bus ids are snowflakes: they order messages sent within one millisecond.
	return queued.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function messageResult(messages: IrcMessage[], jobs: JobsDetails["jobs"]): JobsResult {
	const text = messages
		.map(message => {
			const reply = message.replyTo ? ` (reply to ${message.replyTo})` : "";
			return `Message [${message.id}] from ${message.from}${reply}: ${message.body}`;
		})
		.join("\n\n");
	return {
		content: [{ type: "text", text }],
		details: { op: "wait", messages, ...(jobs?.length ? { jobs } : {}) },
	};
}

function participantFor(session: ToolSession): WaitParticipant {
	return run => OrchestratorRuntime.global().withWaitPermit(session, run);
}

/**
 * Canonical first-wakeup wait over job, watch and process references plus an optional mailbox.
 * A bare request covers the caller's running jobs/watches and, when messaging exists, its mailbox.
 * Explicit targets never add unrelated sources. The winner is consumed inside the watch lease, so
 * automatic delivery can never report it again; losers stay eligible for automatic delivery.
 */
export async function executeWait(
	session: ToolSession,
	request: JobsWaitRequest,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<JobsDetails>,
): Promise<JobsResult> {
	const manager = session.asyncJobManager;
	if (signal?.aborted && signal.reason !== TOOL_INTERRUPT_ABORT_REASON) {
		return {
			content: [{ type: "text", text: "Wait interrupted; nothing was consumed." }],
			details: { op: "wait", jobs: [] },
		};
	}
	const ownerId = asyncJobOwner(session);
	const bare = request.targets === undefined && request.mailbox === undefined;
	const targets = request.targets ?? [];
	if (targets.length > MAX_WAIT_TARGETS) {
		return jobsErrorResult(`wait accepts at most ${MAX_WAIT_TARGETS} targets.`, "wait");
	}

	const mailbox = mailboxFor(session, request.mailbox?.from);
	if (request.mailbox && !mailbox) return jobsErrorResult("Peer messaging is unavailable in this session.", "wait");
	const useMailbox = request.mailbox !== undefined || (bare && mailbox !== undefined);

	// Resolve every target before waiting: an expired, foreign or stale reference fails fast.
	const jobs: AsyncJob[] = [];
	const processes: ProcessRef[] = [];
	const unresolved: string[] = [];
	for (const target of targets) {
		if (target.kind === "process") {
			processes.push(target);
			continue;
		}
		const job = manager ? ownedJob(manager, ownerId, target) : undefined;
		if (job) jobs.push(job);
		else unresolved.push(`${target.kind} ${target.id}`);
	}
	if (bare && manager) jobs.push(...manager.getRunningJobs({ ownerId }).filter(job => job.ownerId === ownerId));
	if (unresolved.length > 0) {
		return jobsErrorResult(
			`No owned ${unresolved.join(", ")}. It expired, belongs to another owner, or has a different kind; list your references with op "list".`,
			"wait",
		);
	}
	const client = processes.length > 0 ? await daemonClientForProject(sessionProjectCwd(session)) : undefined;
	for (const ref of processes) {
		try {
			await client!.request({ op: "describe", name: ref.name, expectedId: ref.id }, signal);
		} catch (error) {
			return jobsErrorResult(error instanceof Error ? error.message : String(error), "wait");
		}
	}

	const watchIds = jobs.filter(job => job.type === "monitor").map(job => job.id);
	const snapshot = (events?: AsyncJobEvent[]) =>
		jobs.map(job =>
			snapshotJob(
				manager!,
				job,
				events?.filter(event => event.jobId === job.id),
			),
		);

	// Deliverable immediately: a queued message, retained watch events, or an already settled target.
	if (useMailbox && mailbox) {
		const queued = takeQueuedMessages(mailbox);
		if (queued.length > 0) return messageResult(queued, undefined);
	}
	const hasEvents = watchIds.some(id =>
		manager!.getJob(id)?.events?.some(event => !manager!.isEventAcknowledged(event)),
	);
	const settledTargets = !bare && jobs.some(job => job.status !== "running");
	if (manager && (hasEvents || settledTargets)) return await consumeJobs(session, manager, ownerId, jobs, watchIds);

	const running = jobs.filter(job => job.status === "running");
	if (signal?.aborted) {
		return {
			content: [{ type: "text", text: "Wait interrupted; nothing was consumed." }],
			details: { op: "wait", jobs: manager ? snapshot() : [] },
		};
	}
	if (running.length === 0 && processes.length === 0) {
		const hasPeer =
			mailbox !== undefined &&
			useMailbox &&
			(request.mailbox?.from !== undefined ||
				mailbox.registry.listVisibleTo(mailbox.agentId, mailbox.fleetRoot).length > 0);
		if (!hasPeer) {
			return {
				content: [{ type: "text", text: "Nothing to wait for: no running jobs or watches, and no active peers." }],
				details: { op: "wait", jobs: [] },
				useless: true,
			};
		}
	}

	const windowMs = waitWindowMs(session, manager, ownerId, request, running.length > 0 || processes.length > 0);
	const usedSmartWindow =
		request.timeoutMs === undefined &&
		session.settings.get("async.pollWaitDuration") === "smart" &&
		running.length > 0;
	const legs = new AbortController();
	const cancelled = new Error("jobs wait settled");
	const jobRaces = running.map(job => job.promise.then(() => "job" as const));
	const otherRacers: Promise<unknown>[] = [];
	if (manager && watchIds.length > 0) otherRacers.push(manager.waitForEvents(watchIds, legs.signal));

	const mailboxLeg =
		useMailbox && mailbox
			? IrcBus.global()
					.wait(mailbox.agentId, { from: mailbox.from, directOnly: true }, 0, legs.signal, {
						fleetRoot: mailbox.fleetRoot,
						...(running.length === 0 && processes.length === 0
							? { liveness: { registry: mailbox.registry, senderId: mailbox.agentId } }
							: {}),
					})
					.then(
						message => ({ message, error: undefined }),
						(error: unknown) => ({
							message: null,
							error: error === cancelled ? undefined : error instanceof Error ? error : new Error(String(error)),
						}),
					)
			: undefined;
	if (mailboxLeg) otherRacers.push(mailboxLeg);

	const exits: ProcessExit[] = [];
	for (const ref of processes) {
		otherRacers.push(
			client!
				.request(
					{
						op: "wait",
						name: ref.name,
						expectedId: ref.id,
						for: "exit",
						timeoutMs: windowMs > 0 ? windowMs : DAEMON_MAX_TIMEOUT_MS,
					},
					legs.signal,
				)
				.then(
					result => {
						if (result.op === "wait" && !result.timedOut) {
							exits.push({ ref, daemon: result.daemon, replaced: false, fresh: false });
						}
					},
					(error: unknown) => {
						if (legs.signal.aborted) return;
						if (error instanceof DaemonBrokerRejectedError && error.code === "stale-reference") {
							exits.push({ ref, replaced: true, fresh: false });
							return;
						}
						throw error;
					},
				),
		);
	}

	const timeout = Promise.withResolvers<void>();
	const timer = windowMs > 0 ? setTimeout(timeout.resolve, windowMs) : undefined;
	if (timer) otherRacers.push(timeout.promise);
	const aborted = Promise.withResolvers<void>();
	const onAbort = () => aborted.resolve();
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	otherRacers.push(aborted.promise);

	const progress = onUpdate
		? setInterval(
				() => onUpdate({ content: [{ type: "text", text: "" }], details: { op: "wait", jobs: snapshot() } }),
				PROGRESS_INTERVAL_MS,
			)
		: undefined;
	onUpdate?.({ content: [{ type: "text", text: "" }], details: { op: "wait", jobs: snapshot() } });

	const race = async (): Promise<JobsResult> => {
		const first = await Promise.race([...jobRaces, ...otherRacers]);
		// One job settling usually means its siblings are about to: collect for a
		// short window so near-simultaneous completions share one result.
		if (first === "job" && running.some(job => job.status === "running")) {
			const settle = Promise.withResolvers<void>();
			const settleTimer = setTimeout(settle.resolve, WAIT_SETTLE_WINDOW_MS);
			try {
				await Promise.race([Promise.all(running.map(job => job.promise)), settle.promise, ...otherRacers]);
			} finally {
				clearTimeout(settleTimer);
			}
		}
		legs.abort(cancelled);
		// A message that reached the mailbox leg before it was cancelled is the winner; job results
		// that settled in the same instant stay unconsumed for automatic delivery.
		const settledMailbox = mailboxLeg ? await mailboxLeg : undefined;
		if (settledMailbox?.message && mailbox)
			return messageResult(takeQueuedMessages(mailbox, settledMailbox.message), manager ? snapshot() : undefined);
		if (signal?.aborted) {
			// A direct message queued in the session inbox (it missed the bus
			// waiter) is returned here rather than injected after the wait.
			const queued = mailbox ? takeQueuedMessages(mailbox) : [];
			if (queued.length > 0) return messageResult(queued, manager ? snapshot() : undefined);
			return {
				content: [{ type: "text", text: "Wait interrupted; nothing was consumed." }],
				details: { op: "wait", jobs: manager ? snapshot() : [] },
			};
		}
		if (settledMailbox?.error && running.length === 0 && processes.length === 0) {
			return jobsErrorResult(settledMailbox.error.message, "wait");
		}
		for (const exit of exits) exit.fresh = claimProcessCompletion(session, exit.ref.id);
		const result = manager ? await consumeJobs(session, manager, ownerId, jobs, watchIds, exits) : undefined;
		if (result && (result.details?.jobs?.some(job => job.status !== "running" || job.events?.length) || exits.length))
			return result;
		if (!result && exits.length > 0) return exitResult(exits);
		const text = `Nothing settled within ${windowMs > 0 ? formatDuration(windowMs) : "the wait"}; still waiting on ${running.length} job(s)/watch(es)${processes.length ? ` and ${processes.length} process(es)` : ""}.`;
		return {
			content: [{ type: "text", text }],
			details: { op: "wait", jobs: manager ? snapshot() : [], timedOut: true },
			useless: true,
		};
	};

	try {
		return manager
			? await withJobWait(
					manager,
					jobs.map(job => job.id),
					race,
					participantFor(session),
				)
			: await participantFor(session)(race);
	} finally {
		legs.abort(cancelled);
		clearTimeout(timer);
		clearInterval(progress);
		signal?.removeEventListener("abort", onAbort);
		if (usedSmartWindow && manager) manager.recordPollWaitEnd(ownerId);
	}
}

function waitWindowMs(
	session: ToolSession,
	manager: AsyncJobManager | undefined,
	ownerId: string | undefined,
	request: JobsWaitRequest,
	hasExecutions: boolean,
): number {
	if (request.timeoutMs !== undefined) return Math.max(0, Math.trunc(request.timeoutMs));
	if (!hasExecutions) return Math.max(0, Math.trunc(session.settings.get("irc.timeoutMs")));
	const setting = session.settings.get("async.pollWaitDuration");
	if (setting === "smart" && manager) return manager.nextPollWaitMs(ownerId);
	return WAIT_DURATION_MS[setting] ?? WAIT_DURATION_MS["30s"];
}

function exitLines(exits: ProcessExit[]): string[] {
	if (exits.length === 0) return [];
	const lines = [`## Processes ended (${exits.length})\n`];
	for (const exit of exits) {
		const state = exit.replaced
			? "replaced by a restart (this reference is stale)"
			: `${exit.daemon?.state ?? "exited"}${exit.daemon?.exitCode === undefined ? "" : ` with code ${exit.daemon.exitCode}`}`;
		const note = exit.fresh ? "" : " (its completion was already delivered)";
		lines.push(`- process ${exit.ref.name} (${exit.ref.id}) ${state}${note}`);
	}
	return lines;
}

function exitResult(exits: ProcessExit[]): JobsResult {
	return {
		content: [{ type: "text", text: exitLines(exits).join("\n") }],
		details: { op: "wait", exited: exits.map(exit => exit.ref) },
	};
}

/** Consume watch events and settled job results, acknowledging them so auto-delivery skips them. */
async function consumeJobs(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
	jobs: AsyncJob[],
	watchIds: string[],
	exits: ProcessExit[] = [],
): Promise<JobsResult> {
	const events = manager.takeEvents(watchIds, { ownerId });
	const settled = jobs.filter(job => job.status !== "running" && job.type !== "monitor").map(job => job.id);
	manager.acknowledgeDeliveries(settled);
	const snapshots = jobs.map(job =>
		snapshotJob(
			manager,
			job,
			events.filter(event => event.jobId === job.id),
		),
	);
	const lines = [...exitLines(exits), ...(await describeJobs(session, snapshots))];
	return {
		content: [{ type: "text", text: lines.join("\n").trimEnd() || "Nothing to report." }],
		details: { op: "wait", jobs: snapshots, ...(exits.length ? { exited: exits.map(exit => exit.ref) } : {}) },
	};
}
