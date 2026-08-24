/**
 * State layer for the full-screen agents view: unified records over live
 * registry refs and persisted session listings, hierarchy indexing, row
 * building, scoping, selection resolution, and search filtering.
 *
 * Ported from prime-agent's agents-view-state.ts onto proto data sources:
 * - live agents: AgentRegistry.global() refs (running/idle/parked/aborted)
 * - persisted sessions: SessionManager.listAll()/listSessions SessionInfo
 * - hierarchy: ref.parentId links plus proto's transcript layout (child
 *   transcripts live next to the parent file under `<parent-basename>/`),
 *   which yields the parent session path without extra filesystem probes.
 */
import * as path from "node:path";
import type { AgentRef } from "../../../registry/agent-registry";
import type { SessionInfo } from "../../../session/session-listing";

export type AgentsViewSection = "running" | "idle" | "inactive";

/** View root: every session, or the attached session's subtree. */
export type AgentsViewScope = "current" | "global";

/** Merged durable/live view of one browsable agent session. */
export interface AgentsViewRecord {
	ref?: AgentRef;
	session?: SessionInfo;
	/** Stable UI key: canonical transcript path, then registry id, then session id. */
	identity: string;
	/** Alternate keys that re-find this record across live↔persisted flips. */
	identityAliases: readonly string[];
	section: AgentsViewSection;
	searchableText: string;
}

export type AgentsViewRowKind = "agent" | "subagent-summary" | "subagent" | "subagent-code";

// Hard cap on spawn-task lines shown so a large assignment never floods the view.
const MAX_SPAWN_TASK_LINES = 10;

export interface AgentsViewRow {
	kind: AgentsViewRowKind;
	section: AgentsViewSection;
	record: AgentsViewRecord | undefined;
	title: string;
	subtitle: string;
	details: string;
	detailsWidth: number;
	depth: number;
	selectable: boolean;
	runningSubagentCount: number;
	/** Unique selection identity for this row. */
	identity: string;
	/** Identity of the agent row this row is nested under. */
	parentIdentity?: string;
	/** True when the selected agent row can drill into its subtree. */
	hasChildren?: boolean;
	/** True when this subagent-summary row's list is expanded. */
	expanded?: boolean;
	/** True when any child carries a spawn task that can be revealed. */
	hasSpawnTask?: boolean;
	/** Full spawn-task text carried by subagent rows for grouping/reveal. */
	spawnTask?: string;
	/** One source line of the spawn task, for "subagent-code" rows. */
	code?: string;
}

export interface AgentsViewIndex {
	byKey: Map<string, AgentsViewRecord>;
	childrenByParent: Map<AgentsViewRecord, AgentsViewRecord[]>;
}

function fileIdentity(sessionPath: string): string {
	return `file:${path.resolve(sessionPath)}`;
}

/**
 * Proto nests a subagent's transcript next to its parent session file under a
 * directory named after the parent's basename: `<dir>/<parent>.jsonl` owns
 * `<dir>/<parent>/<child>.jsonl`. Invert that layout to recover the parent
 * session path. Purely lexical — a miss simply matches no record.
 */
function derivedParentSessionFile(sessionFile: string): string | undefined {
	const dir = path.dirname(sessionFile);
	const parentBasename = path.basename(dir);
	if (!parentBasename || parentBasename === "/" || parentBasename.startsWith(".")) return undefined;
	const candidate = path.join(path.dirname(dir), `${parentBasename}.jsonl`);
	return candidate === sessionFile ? undefined : candidate;
}

function refAliases(ref: AgentRef): string[] {
	const aliases: string[] = [];
	if (ref.sessionFile) aliases.push(fileIdentity(ref.sessionFile));
	aliases.push(`active:${ref.id}`);
	return aliases;
}

function sessionAliases(session: SessionInfo): string[] {
	return [fileIdentity(session.path), `session:${session.id}`];
}

function createSearchableText(ref: AgentRef | undefined, session: SessionInfo | undefined): string {
	return [
		session?.id,
		session?.title,
		session?.firstMessage,
		session?.cwd,
		session?.path,
		session?.parentSessionPath,
		session?.allMessagesText.slice(0, 8192),
		ref?.id,
		ref?.displayName,
		ref?.activity,
		ref?.history?.resolvedModel,
		ref?.history?.agent,
	]
		.filter(part => typeof part === "string" && part.length > 0)
		.join(" ");
}

/** Classify a merged record into Running / Idle / Inactive. */
export function classifyAgentsViewRecord(record: Pick<AgentsViewRecord, "ref">): AgentsViewSection {
	if (!record.ref) return "inactive";
	switch (record.ref.status) {
		case "running":
			return "running";
		case "idle":
		case "parked":
			return "idle";
		case "aborted":
			return "inactive";
	}
}

function buildRecord(ref: AgentRef | undefined, session: SessionInfo | undefined): AgentsViewRecord {
	let identity: string;
	let aliases: string[];
	if (ref && session) {
		aliases = [...new Set([...refAliases(ref), ...sessionAliases(session)])];
		identity = ref.sessionFile ? fileIdentity(ref.sessionFile) : `active:${ref.id}`;
	} else if (ref) {
		aliases = refAliases(ref);
		identity = ref.sessionFile ? fileIdentity(ref.sessionFile) : `active:${ref.id}`;
	} else if (session) {
		aliases = sessionAliases(session);
		identity = fileIdentity(session.path);
	} else {
		throw new Error("Agents view record needs a registry ref or a session");
	}
	const record: AgentsViewRecord = {
		...(ref ? { ref } : {}),
		...(session ? { session } : {}),
		identity,
		identityAliases: aliases,
		section: "inactive",
		searchableText: "",
	};
	record.section = classifyAgentsViewRecord(record);
	record.searchableText = createSearchableText(ref, session);
	return record;
}

/**
 * Merge live registry refs and the persisted session catalog into unified
 * records. Refs win for lifecycle state; sessions enrich durable fields and
 * contribute standalone Inactive rows when nothing lives for them.
 */
export function reconcileAgentsViewRecords(
	refs: readonly AgentRef[],
	sessions: readonly SessionInfo[],
): AgentsViewRecord[] {
	const records: AgentsViewRecord[] = [];
	const byAlias = new Map<string, AgentsViewRecord>();

	for (const ref of refs) {
		const record = buildRecord(ref, undefined);
		records.push(record);
		for (const alias of record.identityAliases) byAlias.set(alias, record);
	}

	for (const session of sessions) {
		const aliases = sessionAliases(session);
		const existing = aliases.map(alias => byAlias.get(alias)).find(Boolean);
		if (existing) {
			existing.session = session;
			existing.identityAliases = [...new Set([...existing.identityAliases, ...aliases])];
			existing.searchableText = createSearchableText(existing.ref, session);
			for (const alias of aliases) byAlias.set(alias, existing);
			continue;
		}
		const record = buildRecord(undefined, session);
		records.push(record);
		for (const alias of record.identityAliases) byAlias.set(alias, record);
	}

	return records;
}

export function getRecordSessionFile(record: AgentsViewRecord): string | undefined {
	return record.ref?.sessionFile ?? record.session?.path;
}

/** Parent lookup keys: transcript-layout paths first, then registry lineage. */
function parentKeys(record: AgentsViewRecord): string[] {
	const keys: string[] = [];
	const sessionFile = getRecordSessionFile(record);
	if (sessionFile) {
		const derived = derivedParentSessionFile(sessionFile);
		if (derived) keys.push(fileIdentity(derived));
	}
	if (record.session?.parentSessionPath) keys.push(fileIdentity(record.session.parentSessionPath));
	// `active:<parentId>` last: a parked worker's parentId can be the generic
	// MAIN_AGENT_ID owner rather than the transcript parent.
	if (record.ref?.parentId) keys.push(`active:${record.ref.parentId}`);
	return keys;
}

function findParentRecord(record: AgentsViewRecord, index: AgentsViewIndex): AgentsViewRecord | undefined {
	return parentKeys(record)
		.map(key => index.byKey.get(key))
		.find(Boolean);
}

export function buildAgentsViewIndex(records: readonly AgentsViewRecord[]): AgentsViewIndex {
	const byKey = new Map<string, AgentsViewRecord>();
	for (const record of records) {
		for (const key of record.identityAliases) byKey.set(key, record);
	}
	const childrenByParent = new Map<AgentsViewRecord, AgentsViewRecord[]>();
	for (const record of records) {
		const parent = findParentRecord(record, { byKey, childrenByParent });
		if (!parent || parent === record) continue;
		const children = childrenByParent.get(parent) ?? [];
		children.push(record);
		childrenByParent.set(parent, children);
	}
	return { byKey, childrenByParent };
}

/** Restrict records to the scoped root and every descendant of that root. */
export function scopeToRecordSubtree(
	records: readonly AgentsViewRecord[],
	rootIdentity: string | undefined,
	index: AgentsViewIndex,
): AgentsViewRecord[] {
	if (!rootIdentity) return [...records];
	const root = index.byKey.get(rootIdentity);
	if (!root) return [];
	const retained = new Set<AgentsViewRecord>();
	const queue = [root];
	for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
		const current = queue[queueIndex];
		if (!current || retained.has(current)) continue;
		retained.add(current);
		queue.push(...(index.childrenByParent.get(current) ?? []));
	}
	return records.filter(record => retained.has(record));
}

/** Filter to matching records while keeping ancestors of every match. */
export function filterAgentsViewRecords(
	records: readonly AgentsViewRecord[],
	matches: (searchableText: string) => boolean,
	index: AgentsViewIndex,
): AgentsViewRecord[] {
	const retained = new Set<AgentsViewRecord>();
	for (const record of records) {
		if (!matches(record.searchableText)) continue;
		let current: AgentsViewRecord | undefined = record;
		while (current && !retained.has(current)) {
			retained.add(current);
			current = findParentRecord(current, index);
		}
	}
	// Keep catalog order so row ranking and sections remain authoritative.
	return records.filter(record => retained.has(record));
}

interface SpawnTaskGroup {
	task?: string;
	rows: MutableAgentsViewRow[];
}

// Subagents spawned with an identical assignment share its text; group them so
// each assignment renders once, above the subagents it launched. Different
// turns produce different tasks and therefore distinct groups.
function groupChildrenBySpawnTask(children: readonly MutableAgentsViewRow[]): SpawnTaskGroup[] {
	const NO_TASK_KEY = " no-spawn-task";
	const groups = new Map<string, SpawnTaskGroup>();
	for (const child of children) {
		const task = child.spawnTask;
		const key = task ?? NO_TASK_KEY;
		const group = groups.get(key);
		if (group) {
			group.rows.push(child);
		} else {
			groups.set(key, { ...(task ? { task } : {}), rows: [child] });
		}
	}
	return [...groups.values()];
}

function buildSpawnTaskRows(parent: AgentsViewRow, task: string, depth: number, groupIndex: number): AgentsViewRow[] {
	const makeRow = (code: string, lineIndex: string): AgentsViewRow => ({
		kind: "subagent-code",
		section: parent.section,
		record: parent.record,
		title: "",
		subtitle: "",
		details: "",
		detailsWidth: 0,
		runningSubagentCount: 0,
		depth,
		// Task rows are read-only context; selection skips over them.
		selectable: false,
		identity: `code:${parent.identity}:${groupIndex}:${lineIndex}`,
		parentIdentity: parent.identity,
		code,
	});
	const allLines = task.replace(/\s+$/, "").split("\n");
	// Cap the body so a long program can't flood the view; note the remainder.
	const lines = allLines.slice(0, MAX_SPAWN_TASK_LINES).map((line, i) => makeRow(line, String(i)));
	const hidden = allLines.length - lines.length;
	if (hidden > 0) {
		lines.push(makeRow(`… +${hidden} more ${hidden === 1 ? "line" : "lines"}`, "more"));
	}
	// A blank panel line above and below pads the program into a clean block.
	return [makeRow("", "pad-top"), ...lines, makeRow("", "pad-bottom")];
}

type MutableAgentsViewRow = AgentsViewRow;

function getTimestamp(value: Date | number | undefined): number {
	if (value === undefined) return 0;
	const timestamp = value instanceof Date ? value.getTime() : value;
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getLastActivity(record: AgentsViewRecord | undefined): number {
	if (record?.ref) return getTimestamp(record.ref.lastActivity);
	return getTimestamp(record?.session?.modified);
}

function sectionRank(section: AgentsViewSection): number {
	switch (section) {
		case "running":
			return 0;
		case "idle":
			return 1;
		case "inactive":
			return 2;
	}
}

function compareAgentsViewRows(a: AgentsViewRow, b: AgentsViewRow): number {
	const sectionDiff = sectionRank(a.section) - sectionRank(b.section);
	if (sectionDiff !== 0) return sectionDiff;
	if (a.section !== "running") {
		const activityDiff = getLastActivity(b.record) - getLastActivity(a.record);
		if (activityDiff !== 0) return activityDiff;
	}
	const createdDiff = getTimestamp(b.record?.session?.created) - getTimestamp(a.record?.session?.created);
	if (createdDiff !== 0) return createdDiff;
	const titleDiff = a.title.localeCompare(b.title);
	if (titleDiff !== 0) return titleDiff;
	return a.identity.localeCompare(b.identity);
}

/** Relative age cell content: bare units (42m / 2h / 1d), right-aligned width-10 column. */
function formatRowDetails(row: AgentsViewRow): string {
	const age = formatRelativeAge(getLastActivity(row.record));
	if (row.section !== "inactive") return age;
	const count = row.record?.session?.messageCount;
	return count !== undefined ? `${count} · ${age}` : age;
}

export function formatRelativeAge(valueMs: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - valueMs) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Explicit names read bold downstream; fallback titles stay plain. */
export function hasExplicitTitle(record: AgentsViewRecord): boolean {
	return Boolean(record.session?.title);
}

export function getRecordTitle(record: AgentsViewRecord): string {
	const candidates = [
		record.session?.title,
		record.ref?.displayName,
		record.session?.firstMessage,
		record.session ? path.basename(record.session.cwd ?? "") : undefined,
		record.ref?.history?.agent,
		record.session?.id,
		record.ref?.id,
	];
	for (const candidate of candidates) {
		const normalized = candidate?.replace(/\s+/g, " ").trim();
		if (normalized) return normalized;
	}
	return "(no messages)";
}

export function getStatusLabel(record: AgentsViewRecord): string {
	const ref = record.ref;
	if (ref?.activity) return ref.activity;
	if (ref) {
		switch (ref.status) {
			case "running":
				return "running";
			case "idle":
				return "idle";
			case "parked":
				return "parked";
			case "aborted":
				return "aborted";
		}
	}
	switch (record.session?.status) {
		case "complete":
			return "completed";
		case "pending":
			return "pending";
		case "error":
			return "error";
		case "interrupted":
		case "aborted":
			return "interrupted";
		default:
			return "";
	}
}

/** Resolve a row index after a rebuild: exact identity, then clamp, then first selectable. */
export function resolveAgentsViewSelectionIndex(
	rows: readonly AgentsViewRow[],
	identity: string | undefined,
	preferredIndex: number,
): number {
	const findSelectable = (predicate: (row: AgentsViewRow) => boolean): number =>
		rows.findIndex(row => row.selectable && predicate(row));

	if (identity !== undefined) {
		const exact = findSelectable(row => row.identity === identity);
		if (exact >= 0) return exact;
	}
	const bounded = Math.max(0, Math.min(preferredIndex, rows.length - 1));
	if (rows[bounded]?.selectable) return bounded;
	const firstSelectable = findSelectable(() => true);
	return firstSelectable >= 0 ? firstSelectable : 0;
}

export function countAgentsBySection(rows: readonly AgentsViewRow[]): Record<AgentsViewSection, number> {
	const agents = rows.filter(row => row.kind === "agent");
	return {
		running: agents.filter(row => row.section === "running").length,
		idle: agents.filter(row => row.section === "idle").length,
		inactive: agents.filter(row => row.section === "inactive").length,
	};
}

export function sectionTitle(section: AgentsViewSection): string {
	switch (section) {
		case "running":
			return "Running";
		case "idle":
			return "Idle";
		case "inactive":
			return "Inactive";
	}
}

// ---------------------------------------------------------------------------
// Scope frames (drill-in/out)
// ---------------------------------------------------------------------------

export interface AgentsViewScopeFrame {
	identity: string;
	/** Title captured when the frame was pushed, so the header survives refreshes. */
	rootTitle: string;
}

/** Push a scope frame; re-pushing the current top replaces it. */
export function transitionAgentsViewScope(
	frames: readonly AgentsViewScopeFrame[],
	frame: AgentsViewScopeFrame,
): AgentsViewScopeFrame[] {
	const top = frames.at(-1);
	if (top?.identity === frame.identity) return [...frames.slice(0, -1), frame];
	return [...frames, frame];
}

/** Drop frames whose root record vanished; keeps the deepest surviving chain. */
export function resolveAgentsViewScopeFrames(
	frames: readonly AgentsViewScopeFrame[],
	index: AgentsViewIndex,
): { frames: AgentsViewScopeFrame[]; droppedFrames: number } {
	for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex--) {
		const frame = frames[frameIndex];
		if (frame && index.byKey.has(frame.identity)) {
			return { frames: frames.slice(0, frameIndex + 1), droppedFrames: frames.length - frameIndex - 1 };
		}
	}
	return { frames: [], droppedFrames: frames.length };
}

/**
 * Build the flattened row tree. Direct children of the scope root render as
 * top-level agent rows (drill-in flattening); deeper descendants become nested
 * subagent rows under synthetic subagent-summary rows.
 */
export function buildAgentsViewRows(
	records: readonly AgentsViewRecord[],
	expandedSubagentParents: ReadonlySet<string>,
	programShownParents: ReadonlySet<string>,
	spawnTasks: ReadonlyMap<string, string>,
	scopeRootIdentity?: string,
): AgentsViewRow[] {
	const index = buildAgentsViewIndex(records);
	const scopeRootAliases = new Set(
		scopeRootIdentity ? (index.byKey.get(scopeRootIdentity)?.identityAliases ?? []) : [],
	);

	const baseRows: MutableAgentsViewRow[] = records.map(record => {
		const spawnTaskSource = getRecordSessionFile(record);
		const spawnTask = spawnTaskSource ? spawnTasks.get(spawnTaskSource) : undefined;
		const isChildOfScopeRoot = scopeRootAliases.size > 0 && parentKeys(record).some(key => scopeRootAliases.has(key));
		// Direct children of the scope root render as top-level agent rows
		// (drill-in flattening); only deeper lineage nests.
		const nestedByLineage = Boolean(record.ref && (record.ref.kind === "sub" || record.ref.parentId));
		const nested = nestedByLineage && !isChildOfScopeRoot;
		return {
			kind: nested ? "subagent" : "agent",
			section: record.section,
			record,
			title: getRecordTitle(record),
			subtitle: getStatusLabel(record),
			details: "",
			detailsWidth: 10,
			depth: 0,
			selectable: true,
			runningSubagentCount: 0,
			identity: record.identity,
			...(spawnTask ? { spawnTask } : {}),
		};
	});

	const rowsByKey = new Map<string, MutableAgentsViewRow>();
	for (const row of baseRows) {
		for (const key of row.record?.identityAliases ?? []) rowsByKey.set(key, row);
	}

	const childrenByParent = new Map<MutableAgentsViewRow, MutableAgentsViewRow[]>();
	const nestedRows = new Set<MutableAgentsViewRow>();
	for (const row of baseRows) {
		if (row.kind !== "subagent" || !row.record) continue;
		const parent = parentKeys(row.record)
			.map(key => rowsByKey.get(key))
			.find(Boolean);
		if (!parent || parent === row) {
			// A child can arrive before its parent record; keep it reachable as a
			// root until the parent appears.
			row.kind = "agent";
			continue;
		}
		nestedRows.add(row);
		row.parentIdentity = parent.identity;
		if (row.section === "running") parent.runningSubagentCount += 1;
		const siblings = childrenByParent.get(parent) ?? [];
		siblings.push(row);
		childrenByParent.set(parent, siblings);
	}

	const roots = baseRows.filter(row => !nestedRows.has(row));
	const visibleRoots = scopeRootIdentity ? roots.filter(row => row.identity !== scopeRootIdentity) : roots;

	const flattened: AgentsViewRow[] = [];
	const emit = (row: MutableAgentsViewRow, depth: number): void => {
		row.depth = depth;
		row.details = formatRowDetails(row);
		flattened.push(row);
		const children = childrenByParent.get(row) ?? [];
		if (children.length === 0) return;
		row.hasChildren = true;
		const sortedChildren = [...children].sort(compareAgentsViewRows);
		const hasSpawnTask = sortedChildren.some(child => Boolean(child.spawnTask));
		const expanded = expandedSubagentParents.has(row.identity);
		flattened.push(createSubagentSummaryRow(row, sortedChildren, depth + 1, hasSpawnTask, expanded));
		if (!expanded) return;
		const showProgram = programShownParents.has(row.identity);
		const groups = groupChildrenBySpawnTask(sortedChildren);
		for (const [groupIndex, group] of groups.entries()) {
			if (showProgram && group.task) {
				flattened.push(...buildSpawnTaskRows(row, group.task, depth + 1, groupIndex));
			}
			for (const child of group.rows) {
				child.parentIdentity = row.identity;
				child.details = formatRowDetails(child);
				emit(child, depth + 1);
			}
		}
	};
	for (const root of visibleRoots.sort(compareAgentsViewRows)) {
		emit(root, 0);
	}
	return flattened;
}

function createSubagentSummaryRow(
	parent: AgentsViewRow,
	children: readonly AgentsViewRow[],
	depth: number,
	hasSpawnTask: boolean,
	expanded: boolean,
): AgentsViewRow {
	const totalCount = children.length;
	const running = parent.runningSubagentCount;
	const subagentTitle =
		running > 0
			? `${running} ${running === 1 ? "subagent" : "subagents"} running`
			: `${totalCount} ${totalCount === 1 ? "subagent" : "subagents"}`;
	return {
		kind: "subagent-summary",
		section: parent.section,
		record: parent.record,
		title: subagentTitle,
		subtitle: "",
		details: "",
		detailsWidth: 0,
		depth,
		selectable: true,
		runningSubagentCount: running,
		identity: `subagents:${parent.identity}`,
		parentIdentity: parent.identity,
		hasSpawnTask,
		expanded,
	};
}
