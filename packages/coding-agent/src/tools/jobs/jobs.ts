import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { AsyncJob, AsyncJobEvent, AsyncJobManager } from "../../async";
import { settings } from "../../config/settings";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { JobRef, WatchRef } from "../../jobs/contracts";
import { shimmerEnabled, shimmerText } from "../../modes/theme/shimmer";
import type { Theme } from "../../modes/theme/theme";
import type { MonitorDetails } from "../../monitor/types";
import { asyncJobRawArtifactId, formatAsyncJobTextForContext } from "../../session/async-job-delivery";
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
import type { JobSnapshot, JobStatus, JobsDetails } from "./types";

/** Async jobs and watches are owned by the async-job owner key; an unowned caller sees only unowned jobs. */
export function asyncJobOwner(session: ToolSession): string | undefined {
	return session.getAsyncJobOwnerId?.() ?? undefined;
}

export function refForJob(job: AsyncJob): JobRef | WatchRef {
	return { kind: job.type === "monitor" ? "watch" : "job", id: job.id };
}

/** The caller's job with this id and kind, or undefined: foreign and expired jobs are indistinguishable. */
export function ownedJob(
	manager: AsyncJobManager,
	ownerId: string | undefined,
	ref: JobRef | WatchRef,
): AsyncJob | undefined {
	const job = manager.getJob(ref.id);
	if (!job || job.ownerId !== ownerId) return undefined;
	return refForJob(job).kind === ref.kind ? job : undefined;
}

function resolvedModelOf(job: AsyncJob): string | undefined {
	if (job.type !== "worker") return undefined;
	const progressValue = job.latestDetails?.progress;
	if (!Array.isArray(progressValue)) return undefined;
	let progressRecord: Record<string, unknown> | undefined;
	for (const item of progressValue) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		if (!progressRecord) progressRecord = candidate;
		if (candidate.id === job.id) {
			progressRecord = candidate;
			break;
		}
	}
	const modelValue = progressRecord?.resolvedModel;
	return typeof modelValue === "string" && modelValue.trim() ? modelValue.trim() : undefined;
}

export function snapshotJob(manager: AsyncJobManager, job: AsyncJob, events?: AsyncJobEvent[]): JobSnapshot {
	const resolvedModel = resolvedModelOf(job);
	return {
		ref: refForJob(job),
		type: job.type,
		status: job.status,
		settled: manager.isSettled(job.id),
		label: job.label,
		durationMs: Math.max(0, Date.now() - job.startTime),
		...(job.agentId ? { agentId: job.agentId } : {}),
		...(resolvedModel ? { resolvedModel } : {}),
		...(job.monitor ? { watch: { ...job.monitor } } : {}),
		...(events?.length ? { events } : {}),
		...(job.resultText ? { resultText: job.resultText } : {}),
		rawArtifactId: asyncJobRawArtifactId(job),
		...(job.errorText ? { errorText: job.errorText } : {}),
	};
}

const CAPPED_JOB_TEXT_MAX_ENTRIES = 64;
/** Repeated observations re-render the same finished job, so each one keeps a single artifact. */
const cappedJobText = new LRUCache<string, string>({ max: CAPPED_JOB_TEXT_MAX_ENTRIES });

/**
 * Job text reaches the model here exactly as it does through async delivery, so both paths share
 * one cap and one `artifact://` pointer instead of dumping whole job outputs.
 */
async function forContext(
	session: ToolSession,
	jobId: string,
	kind: "result" | "error",
	text: string,
	rawArtifactId?: string,
): Promise<string> {
	const key = `${jobId}:${kind}:${text.length}`;
	const cached = cappedJobText.get(key);
	if (cached !== undefined) return cached;
	const formatted = await formatAsyncJobTextForContext(
		text,
		toolType => {
			const allocate = session.allocateOutputArtifact;
			return allocate ? allocate(toolType) : Promise.resolve({});
		},
		rawArtifactId,
	);
	if (formatted !== text) cappedJobText.set(key, formatted);
	return formatted;
}

export function describeWatch(watch: MonitorDetails): string {
	const parts: string[] = [watch.mode, `${watch.eventCount} events (limit ${watch.maxEvents} outputs)`];
	if (watch.match !== undefined) parts.push(`match /${watch.match}/u`);
	if (watch.everyMs !== undefined) parts.push(`every ${watch.everyMs}ms`);
	if (watch.timeoutMs !== undefined) parts.push(`timeout ${watch.timeoutMs}ms`);
	if (watch.stopReason) parts.push(`stopped: ${watch.stopReason}`);
	if (watch.exitCode !== undefined) parts.push(`exit ${watch.exitCode}`);
	const target = watch.sourceDescription ? `source: ${watch.sourceDescription}` : `command: ${watch.command ?? ""}`;
	return `${parts.join(" · ")} — ${target}`;
}

function refText(job: JobSnapshot): string {
	return `{"kind":"${job.ref.kind}","id":"${job.ref.id}"}`;
}

/** Render snapshots for the model. Reading never acknowledges; callers that consume do so explicitly. */
export async function describeJobs(session: ToolSession, jobs: JobSnapshot[]): Promise<string[]> {
	const lines: string[] = [];
	const events = jobs.flatMap(job => job.events ?? []);
	if (events.length > 0) {
		lines.push(`## Watch events (${events.length})\n`);
		for (const event of events) lines.push(`### ${event.jobId} — ${event.kind} #${event.sequence}`, event.text, "");
	}
	const completed = jobs.filter(job => job.status !== "running");
	const running = jobs.filter(job => job.status === "running");
	if (completed.length > 0) {
		lines.push(`## Settled (${completed.length})\n`);
		for (const job of completed) {
			const teardown = job.settled ? "" : " (teardown still in progress)";
			lines.push(`### ${job.ref.id} [${job.type}] — ${job.status}${teardown}`);
			lines.push(`Ref: ${refText(job)}`, `Label: ${job.label}`);
			if (job.watch) lines.push(describeWatch(job.watch));
			if (job.resultText)
				lines.push(
					"```",
					await forContext(session, job.ref.id, "result", job.resultText, job.rawArtifactId),
					"```",
				);
			if (job.errorText) lines.push(`Error: ${await forContext(session, job.ref.id, "error", job.errorText)}`);
			lines.push("");
		}
	}
	if (running.length > 0) {
		lines.push(`## Running (${running.length})\n`);
		for (const job of running) {
			lines.push(`- ${refText(job)} [${job.type}] — ${job.label}`);
			if (job.watch) lines.push(`  ${describeWatch(job.watch)}`);
		}
	}
	return lines;
}

/** A waiting frame: every watched job still running and nothing to report yet. */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as JobsDetails | undefined;
	if (d?.op !== "wait" || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.message || d.exited?.length || d.jobs.some(job => job.events?.length)) return false;
	return d.jobs.every(job => job?.status === "running");
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_COLLAPSED = 1;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;
const MODEL_BADGE_MAX_WIDTH = 48;

function statusToIcon(status: JobStatus): ToolUIStatus {
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

function statusToColor(status: JobStatus): ToolUIColor {
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

/** Tree rendering shared by list, inspect, cancel, unwatch and wait results over job snapshots. */
export function renderJobTree(
	jobs: JobSnapshot[],
	fallbackText: string,
	options: RenderResultOptions,
	uiTheme: Theme,
	title: string,
	hideRunning: boolean,
): Component {
	let visible = jobs;
	if (!options.isPartial && hideRunning) {
		visible = jobs.filter(job => job.status !== "running" || job.events?.length);
		if (visible.length === 0) return new Text("", 0, 0);
	}
	if (visible.length === 0) {
		const header = renderStatusLine({ icon: "warning", title }, uiTheme);
		return new Text([header, formatEmptyMessage(replaceTabs(fallbackText || "No jobs"), uiTheme)].join("\n"), 0, 0);
	}

	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const job of visible) counts[job.status]++;
	const eventCount = visible.reduce((count, job) => count + (job.events?.length ?? 0), 0);
	const meta: string[] = [];
	if (eventCount > 0) meta.push(uiTheme.fg("accent", `${eventCount} events`));
	if (counts.completed > 0) meta.push(uiTheme.fg("success", `${counts.completed} done`));
	if (counts.failed > 0) meta.push(uiTheme.fg("error", `${counts.failed} failed`));
	if (counts.cancelled > 0) meta.push(uiTheme.fg("warning", `${counts.cancelled} cancelled`));

	const headerIcon: ToolUIStatus = counts.failed > 0 ? "warning" : counts.running > 0 ? "info" : "success";
	const noun = visible.length === 1 ? "job" : "jobs";
	const description =
		eventCount > 0
			? "watch events received"
			: counts.running > 0
				? counts.running === visible.length
					? `${title}: ${visible.length} running`
					: `${title}: ${counts.running} of ${visible.length} ${noun} running`
				: `${title}: ${visible.length} ${noun} settled`;
	const header = renderStatusLine(
		{
			icon: headerIcon,
			spinnerFrame: counts.running > 0 ? options.spinnerFrame : undefined,
			title: description,
			meta,
		},
		uiTheme,
	);

	const statusOrder: Record<JobStatus, number> = { running: 0, failed: 1, cancelled: 2, completed: 3 };
	const sortedJobs = [...visible].sort(
		(a, b) => statusOrder[a.status] - statusOrder[b.status] || b.durationMs - a.durationMs,
	);

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
						const badge = formatBadge(
							job.ref.kind === "watch" ? `watch · ${job.watch?.mode ?? "source"}` : job.type,
							statusToColor(job.status),
							uiTheme,
						);
						const idPart = job.label.trim() === job.ref.id ? "" : ` ${uiTheme.fg("muted", job.ref.id)}`;
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
							job.type === "worker" && job.resolvedModel && settings.get("orchestrator.showResolvedModelBadge")
								? `${uiTheme.sep.dot}${uiTheme.fg(
										"dim",
										truncateToWidth(replaceTabs(job.resolvedModel), MODEL_BADGE_MAX_WIDTH, Ellipsis.Unicode),
									)}`
								: "";
						const live = job.status === "running" && options.spinnerFrame !== undefined;
						const headRaw = visibleLabelLines[0] ?? "";
						const headLabel = live
							? shimmerEnabled()
								? shimmerText(headRaw, uiTheme)
								: uiTheme.fg("accent", headRaw)
							: uiTheme.fg("toolOutput", headRaw);
						const teardown = job.settled ? "" : ` ${uiTheme.fg("warning", "tearing down")}`;
						lines.push(
							`${icon}${idPart} ${badge} ${headLabel}${modelText}${modelText ? uiTheme.sep.dot : " "}${durationText}${job.status !== "running" ? teardown : ""}`,
						);
						for (let i = 1; i < visibleLabelLines.length; i++) {
							lines.push(`  ${uiTheme.fg("toolOutput", visibleLabelLines[i]!)}`);
						}
						const preview = flattenStructuredPreview(
							stripTaskResultEnvelope(
								job.events?.map(event => event.text).join("\n") ||
									job.errorText?.trim() ||
									job.resultText?.trim() ||
									"",
							),
						);
						if (preview) {
							const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
							const tone = job.errorText ? "error" : "dim";
							for (const line of getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode)) {
								lines.push(`  ${uiTheme.fg(tone, line)}`);
							}
						}
						return lines;
					},
				},
				uiTheme,
			);
			const all = [header, ...itemLines].map(l => truncateToWidth(l, width, Ellipsis.Unicode));
			cached = { key, lines: all };
			return all;
		},
		invalidate() {
			cached = undefined;
		},
	};
}
