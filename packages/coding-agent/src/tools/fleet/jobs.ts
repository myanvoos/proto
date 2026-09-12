import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { AsyncJob, AsyncJobManager, AsyncJobType } from "../../async";
import { settings } from "../../config/settings";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { shimmerEnabled, shimmerText } from "../../modes/theme/shimmer";
import type { Theme } from "../../modes/theme/theme";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { readSessionLiveState } from "../../session/session-liveness";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../../tui";
import type { ToolSession } from "..";
import {
	formatBadge,
	formatDuration,
	formatEmptyMessage,
	formatStatusIcon,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
} from "../render-utils";
import type { AgentActivitySnapshot, CancelOutcome, CoordinationDetails, FleetRenderArgs, JobSnapshot } from "./types";

const WAIT_DURATION_MS: Record<string, number> = {
	"5s": 5_000,
	"10s": 10_000,
	"30s": 30_000,
	"1m": 60_000,
	"5m": 5 * 60_000,
};

export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as CoordinationDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}

export function resolvePollWindow(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
): { waitMs: number; smart: boolean } {
	const pollSetting = session.settings.get("async.pollWaitDuration");
	const smart = pollSetting === "smart";
	const waitMs = smart
		? manager.nextPollWaitMs(ownerId)
		: ((pollSetting ? WAIT_DURATION_MS[pollSetting] : undefined) ?? WAIT_DURATION_MS["30s"]);
	return { waitMs, smart };
}

export function visibleJobs(manager: AsyncJobManager, ids: string[], ownerId: string | undefined): AsyncJob[] {
	const out: AsyncJob[] = [];
	for (const id of ids) {
		const job = manager.getJob(id);
		if (!job) continue;
		if (ownerId && job.ownerId !== ownerId) continue;
		out.push(job);
	}
	return out;
}

function runningAgentsOutsideJobs(session: ToolSession): AgentActivitySnapshot[] {
	const registry = session.agentRegistry;
	if (!registry) return [];
	const selfId = session.getAgentId?.() ?? undefined;
	const asyncJobOwnerId = session.getAsyncJobOwnerId?.() ?? selfId;

	const covered = new Set<string>();
	const manager = session.asyncJobManager;
	if (manager) {
		for (const job of manager.getRunningJobs(asyncJobOwnerId ? { ownerId: asyncJobOwnerId } : undefined)) {
			covered.add(job.id);
			if (job.agentId) covered.add(job.agentId);
		}
	}
	const now = Date.now();
	const out: AgentActivitySnapshot[] = [];
	for (const ref of selfId ? registry.listInFleet(selfId, session.getAgentFleetRoot?.()) : []) {
		if (ref.kind !== "sub" || ref.status !== "running") continue;
		if (ref.id === selfId || covered.has(ref.id)) continue;
		const live = ref.session !== null || (ref.sessionFile ? readSessionLiveState(ref.sessionFile).fresh : false);
		out.push({
			id: ref.id,
			...(ref.parentId ? { parentId: ref.parentId } : {}),
			...(ref.activity ? { activity: ref.activity } : {}),
			ageMs: Math.max(0, now - ref.createdAt),
			live,
		});
	}
	return out;
}

function describeAgents(agents: AgentActivitySnapshot[]): string[] {
	const lines = [`## Running Agents (${agents.length}) — not job-backed\n`];
	for (const agent of agents) {
		const parent = agent.parentId ? ` (spawned by \`${agent.parentId}\`)` : "";
		const activity = agent.activity ? ` — ${agent.activity}` : "";
		const stale = agent.live ? "" : " — no turn in flight (stale registration?)";
		lines.push(`- \`${agent.id}\`${parent} — up ${formatDuration(agent.ageMs)}${activity}${stale}`);
	}
	lines.push("", "These agents have no job entry; message peers with `fleet` send, transcripts at `history://<id>`.");
	if (agents.some(agent => !agent.live)) {
		lines.push(
			"An agent with no turn in flight cannot answer a message and never satisfies a bare `wait`; clear it with `fleet` cancel.",
		);
	}
	return lines;
}

interface TrackedJobLike {
	id: string;
	type: AsyncJobType;
	status: string;
	label: string;
	startTime: number;
	latestDetails?: Record<string, unknown>;
	resultText?: string;
	errorText?: string;
}

export function snapshotJobs(session: ToolSession, jobs: TrackedJobLike[]): JobSnapshot[] {
	const now = Date.now();
	return jobs.map(j => {
		const current = session.asyncJobManager?.getJob(j.id);
		const latest = current ?? j;
		let resolvedModel: string | undefined;
		if (latest.type === "worker") {
			const progressValue = latest.latestDetails?.progress;
			if (Array.isArray(progressValue)) {
				let progressRecord: Record<string, unknown> | undefined;
				for (const item of progressValue) {
					if (!item || typeof item !== "object") continue;
					const candidate = item as Record<string, unknown>;
					if (!progressRecord) progressRecord = candidate;
					if (candidate.id === latest.id) {
						progressRecord = candidate;
						break;
					}
				}
				const modelValue = progressRecord?.resolvedModel;
				if (typeof modelValue === "string") {
					const trimmed = modelValue.trim();
					if (trimmed) resolvedModel = trimmed;
				}
			}
		}
		return {
			id: latest.id,
			type: latest.type,
			status: latest.status as JobSnapshot["status"],
			label: latest.label,
			durationMs: Math.max(0, now - latest.startTime),
			...(resolvedModel ? { resolvedModel } : {}),
			...(latest.resultText ? { resultText: latest.resultText } : {}),
			...(latest.errorText ? { errorText: latest.errorText } : {}),
		};
	});
}

export function buildJobResult(
	session: ToolSession,
	manager: AsyncJobManager,
	op: "wait" | "cancel" | "jobs",
	jobs: TrackedJobLike[],
	cancelOutcomes: CancelOutcome[],
	agents: AgentActivitySnapshot[] = [],
): AgentToolResult<CoordinationDetails> {
	const seen = new Set<string>();
	const uniqueJobs = jobs.filter(j => {
		if (seen.has(j.id)) return false;
		seen.add(j.id);
		return true;
	});
	const jobResults = snapshotJobs(session, uniqueJobs);

	manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

	const completed = jobResults.filter(j => j.status !== "running");
	const running = jobResults.filter(j => j.status === "running");

	const lines: string[] = [];

	if (cancelOutcomes.length > 0) {
		lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
		for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
		lines.push("");
	}

	if (completed.length > 0) {
		lines.push(`## Completed (${completed.length})\n`);
		for (const j of completed) {
			lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
			lines.push(`Label: ${j.label}`);
			if (j.resultText) {
				lines.push("```", j.resultText, "```");
			}
			if (j.errorText) {
				lines.push(`Error: ${j.errorText}`);
			}
			lines.push("");
		}
	}

	if (running.length > 0) {
		lines.push(`## Still Running (${running.length})\n`);
		for (const j of running) {
			lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
		}
	}

	if (agents.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(...describeAgents(agents));
	}

	if (lines.length === 0) {
		lines.push("No background jobs.");
	}

	const details: CoordinationDetails = {
		op,
		jobs: jobResults,
		...(cancelOutcomes.length ? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) } : {}),
		...(agents.length ? { agents } : {}),
	};
	return {
		content: [{ type: "text", text: lines.join("\n").trimEnd() }],
		details,

		...(isWaitingPollDetails(details) ? { useless: true } : {}),
	};
}

export function noMatchingJobsResult(session: ToolSession, ids: string[]): AgentToolResult<CoordinationDetails> {
	const agents = runningAgentsOutsideJobs(session);
	const lines: string[] = [`No matching jobs found for IDs: ${ids.join(", ")}`];
	const registry = session.agentRegistry;
	for (const id of ids) {
		const ref = registry?.get(id);
		if (!ref) continue;
		lines.push(
			ref.status === "running"
				? `- \`${id}\` is a running agent with no job entry — message it via \`fleet\` send; transcript at history://${id}`
				: `- \`${id}\` is a ${ref.status} agent (its job is gone) — transcript at history://${id}`,
		);
	}
	if (agents.length > 0) {
		lines.push("", ...describeAgents(agents));
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "wait", jobs: [], ...(agents.length ? { agents } : {}) },

		...(agents.length === 0 ? { useless: true } : {}),
	};
}

export function nothingToWaitForResult(session: ToolSession): AgentToolResult<CoordinationDetails> {
	const agents = runningAgentsOutsideJobs(session);
	const lines: string[] = ["No running background jobs to wait for."];
	if (agents.length > 0) {
		lines.push("", ...describeAgents(agents));
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "wait", jobs: [], ...(agents.length ? { agents } : {}) },
		...(agents.length === 0 ? { useless: true } : {}),
	};
}

export async function executeCancel(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
	ids: string[],
): Promise<AgentToolResult<CoordinationDetails>> {
	const ownerFilter = ownerId ? { ownerId } : undefined;
	const registryOwnerId = session.getAgentId?.() ?? undefined;
	const cancelOutcomes: CancelOutcome[] = [];
	for (const id of ids) {
		const existing = manager.getJob(id);
		if (!existing || (ownerId && existing.ownerId !== ownerId)) {
			cancelOutcomes.push(await cancelAgentRegistration(session, registryOwnerId, id));
			continue;
		}
		if (existing.status !== "running") {
			const regOutcome = await cancelAgentRegistration(session, registryOwnerId, id);
			cancelOutcomes.push(
				regOutcome.status === "cancelled"
					? regOutcome
					: {
							id,
							status: "already_completed",
							message: `Background job ${id} is already ${existing.status}.`,
						},
			);
			continue;
		}
		const cancelled = manager.cancel(id, ownerFilter);
		cancelOutcomes.push(
			cancelled
				? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
				: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
		);
	}
	return buildJobResult(session, manager, "cancel", visibleJobs(manager, ids, ownerId), cancelOutcomes);
}

async function cancelAgentRegistration(
	session: ToolSession,
	ownerId: string | undefined,
	id: string,
): Promise<CancelOutcome> {
	const registry = session.agentRegistry;
	const ref = registry?.get(id);
	if (ref?.kind !== "sub") {
		return { id, status: "not_found", message: `Background job not found: ${id}` };
	}
	if (id === ownerId) {
		return { id, status: "not_found", message: `Cannot cancel yourself (${id}).` };
	}
	if (ownerId && ref.parentId !== ownerId) {
		return { id, status: "not_found", message: `Agent ${id} was not spawned by you and cannot be cancelled.` };
	}
	const lifecycle = session.agentLifecycle?.();
	try {
		if (ref.status === "running" && ref.session) {
			await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		if (lifecycle) {
			await lifecycle.release(id);
		} else {
			await ref.session?.dispose();
			registry?.unregister(id);
		}
	} catch (error) {
		return {
			id,
			status: "already_completed",
			message: `Agent ${id} could not be fully cancelled: ${error instanceof Error ? error.message : String(error)}.`,
		};
	}
	return { id, status: "cancelled", message: `Cancelled agent ${id} (killed session, dropped registration).` };
}

export function executeJobsSnapshot(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
): AgentToolResult<CoordinationDetails> {
	const jobs = manager.getAllJobs(ownerId ? { ownerId } : undefined);
	return buildJobResult(session, manager, "jobs", jobs, [], runningAgentsOutsideJobs(session));
}

interface JobRenderArgs {
	poll?: string[];
	cancel?: string[];
	list?: boolean;
}

function toJobRenderArgs(args: FleetRenderArgs | undefined): JobRenderArgs | undefined {
	if (!args) return undefined;
	switch (args.op) {
		case "wait":
			return { poll: args.ids };
		case "cancel":
			return { cancel: args.ids ?? [] };
		case "jobs":
			return { list: true };
		default:
			return {};
	}
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_COLLAPSED = 1;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;
const MODEL_BADGE_MAX_WIDTH = 48;

function statusToIcon(status: JobSnapshot["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
			return "error";
		case "cancelled":
			return "aborted";
		case "running":
			return "running";
	}
}

function statusToColor(status: JobSnapshot["status"]): ToolUIColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "warning";
		case "running":
			return "accent";
	}
}

function stripTaskResultEnvelope(text: string): string {
	if (!text.startsWith("<worker-result")) return text;
	const body = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2];
	return body?.trim() || text;
}

function flattenStructuredPreview(text: string): string {
	const first = text[0];
	if (first !== "{" && first !== "[") return text;
	return text.slice(0, PREVIEW_LINES_EXPANDED * PREVIEW_LINE_WIDTH * 2).replace(/\s+/g, " ");
}

function describeTarget(args: JobRenderArgs | undefined): string {
	if (args?.list) return "background jobs";
	const poll = args?.poll ?? [];
	const cancel = args?.cancel ?? [];
	const parts: string[] = [];
	if (cancel.length > 0) {
		parts.push(cancel.length === 1 ? `cancel ${cancel[0]}` : `cancel ${cancel.length} jobs`);
	}
	if (poll.length > 0) {
		parts.push(poll.length === 1 ? `poll ${poll[0]}` : `poll ${poll.length} jobs`);
	}
	if (parts.length === 0) return "all running jobs";
	return parts.join(", ");
}

export function jobsRenderCall(args: FleetRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
	const text = renderStatusLine({ icon: "pending", title: describeTarget(toJobRenderArgs(args)) || "Job" }, uiTheme);
	return new Text(text, 0, 0);
}

export function jobsRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme,
	hubArgs?: FleetRenderArgs,
): Component {
	const args = toJobRenderArgs(hubArgs);
	let jobs = result.details?.jobs ?? [];
	const agents = result.details?.agents ?? [];

	if (jobs.length === 0 && agents.length === 0) {
		const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
		const header = renderStatusLine({ icon: "warning", title: describeTarget(args) || "Job" }, uiTheme);
		return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
	}

	const isPollCall = args ? !args.list && (!args.cancel || args.cancel.length === 0 || args.poll !== undefined) : true;

	if (!options.isPartial && isPollCall && agents.length === 0) {
		jobs = jobs.filter(job => job.status !== "running");
		if (jobs.length === 0) {
			return new Text("", 0, 0);
		}
	}

	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const job of jobs) counts[job.status]++;

	const meta: string[] = [];
	if (counts.completed > 0) meta.push(uiTheme.fg("success", `${counts.completed} done`));
	if (counts.failed > 0) meta.push(uiTheme.fg("error", `${counts.failed} failed`));
	if (counts.cancelled > 0) meta.push(uiTheme.fg("warning", `${counts.cancelled} cancelled`));
	if (agents.length > 0 && jobs.length > 0) {
		meta.push(uiTheme.fg("accent", `${agents.length} agent${agents.length === 1 ? "" : "s"}`));
	}

	const headerIcon: ToolUIStatus =
		counts.failed > 0 ? "warning" : counts.running > 0 || agents.length > 0 ? "info" : "success";
	const jobsNoun = jobs.length === 1 ? "job" : "jobs";
	const description =
		jobs.length === 0
			? `${agents.length} running agent${agents.length === 1 ? "" : "s"} — no jobs`
			: counts.running > 0
				? counts.running === jobs.length
					? `waiting on ${jobs.length} ${jobsNoun}`
					: `waiting on ${counts.running} of ${jobs.length} ${jobsNoun}`
				: `${jobs.length} ${jobsNoun} settled`;

	const header = renderStatusLine(
		{
			icon: headerIcon,
			spinnerFrame: counts.running > 0 || agents.length > 0 ? options.spinnerFrame : undefined,
			title: description,
			meta,
		},
		uiTheme,
	);

	const statusOrder: Record<JobSnapshot["status"], number> = {
		running: 0,
		failed: 1,
		cancelled: 2,
		completed: 3,
	};
	const sortedJobs = [...jobs].sort((a, b) => {
		const diff = statusOrder[a.status] - statusOrder[b.status];
		if (diff !== 0) return diff;
		return b.durationMs - a.durationMs;
	});

	let cached: RenderCache | undefined;
	return {
		render(width: number): readonly string[] {
			const expanded = options.expanded;
			const spinnerFrame = options.spinnerFrame ?? 0;

			const shimmerActive = counts.running > 0 && options.spinnerFrame !== undefined && shimmerEnabled();
			const key = new Hasher().bool(expanded).u32(width).u32(spinnerFrame).bool(shimmerActive).digest();
			if (!shimmerActive && cached?.key === key) return cached.lines;

			const itemLines = renderTreeList<JobSnapshot>(
				{
					items: sortedJobs,
					expanded,
					maxCollapsed: COLLAPSED_LIST_LIMIT,
					itemType: "job",
					renderItem: job => {
						const lines: string[] = [];
						const icon = formatStatusIcon(
							statusToIcon(job.status),
							uiTheme,
							job.status === "running" ? options.spinnerFrame : undefined,
						);
						const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);

						const idPart = job.label.trim() === job.id ? "" : ` ${uiTheme.fg("muted", job.id)}`;
						const rawLabelLines = (job.label || "(no label)").split(/\r?\n/);
						const maxLabelLines = expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
						const visibleLabelLines = rawLabelLines
							.slice(0, maxLabelLines)
							.map(l => truncateToWidth(replaceTabs(l), LABEL_MAX_WIDTH, Ellipsis.Unicode));
						if (rawLabelLines.length > maxLabelLines && visibleLabelLines.length > 0) {
							const last = visibleLabelLines[visibleLabelLines.length - 1]!;
							visibleLabelLines[visibleLabelLines.length - 1] = `${last} …`;
						}
						const durationText = uiTheme.fg("dim", formatDuration(job.durationMs));
						const modelText =
							job.type === "worker" &&
							typeof job.resolvedModel === "string" &&
							job.resolvedModel.trim() &&
							settings.get("orchestrator.showResolvedModelBadge")
								? `${uiTheme.sep.dot}${uiTheme.fg(
										"dim",
										truncateToWidth(
											replaceTabs(job.resolvedModel.trim()),
											MODEL_BADGE_MAX_WIDTH,
											Ellipsis.Unicode,
										),
									)}`
								: "";

						const live = job.status === "running" && options.spinnerFrame !== undefined;
						const headRaw = visibleLabelLines[0] ?? "";
						const headLabel = live
							? shimmerEnabled()
								? shimmerText(headRaw, uiTheme)
								: uiTheme.fg("accent", headRaw)
							: uiTheme.fg("toolOutput", headRaw);
						lines.push(
							`${icon}${idPart} ${typeBadge} ${headLabel}${modelText}${modelText ? uiTheme.sep.dot : " "}${durationText}`,
						);
						for (let i = 1; i < visibleLabelLines.length; i++) {
							lines.push(`  ${uiTheme.fg("toolOutput", visibleLabelLines[i]!)}`);
						}

						const preview = flattenStructuredPreview(
							stripTaskResultEnvelope(job.errorText?.trim() || job.resultText?.trim() || ""),
						);
						if (preview) {
							const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
							const previewLines = getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode);
							const tone = job.errorText ? "error" : "dim";
							for (const pl of previewLines) {
								lines.push(`  ${uiTheme.fg(tone, pl)}`);
							}
						}
						return lines;
					},
				},
				uiTheme,
			);

			const agentLines =
				agents.length === 0
					? []
					: renderTreeList<AgentActivitySnapshot>(
							{
								items: agents,
								expanded,
								maxCollapsed: COLLAPSED_LIST_LIMIT,
								itemType: "agent",
								renderItem: agent => {
									const icon = agent.live
										? formatStatusIcon("running", uiTheme, options.spinnerFrame)
										: formatStatusIcon("warning", uiTheme);
									const badge = agent.live
										? formatBadge("agent", "accent", uiTheme)
										: formatBadge("agent · no turn", "warning", uiTheme);
									const gist = agent.activity
										? ` ${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(agent.activity), LABEL_MAX_WIDTH, Ellipsis.Unicode))}`
										: "";
									const parent = agent.parentId ? uiTheme.fg("dim", ` ← ${agent.parentId}`) : "";
									const age = uiTheme.fg("dim", formatDuration(agent.ageMs));
									return [`${icon} ${uiTheme.fg("muted", agent.id)} ${badge}${gist} ${age}${parent}`];
								},
							},
							uiTheme,
						);

			const all = [header, ...itemLines, ...agentLines].map(l => truncateToWidth(l, width, Ellipsis.Unicode));
			cached = { key, lines: all };
			return all;
		},
		invalidate() {
			cached = undefined;
		},
	};
}
