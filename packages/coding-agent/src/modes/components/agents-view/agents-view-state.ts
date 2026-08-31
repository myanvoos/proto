import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AgentRef, MAIN_AGENT_ID } from "../../../registry/agent-registry";
import type { SessionInfo } from "../../../session/session-listing";

export type AgentsViewSection = "running" | "idle" | "current" | "inactive";

export type AgentsViewScope = "current" | "global";

export interface AgentsViewRecord {
	ref?: AgentRef;
	session?: SessionInfo;

	identity: string;

	identityAliases: readonly string[];
	section: AgentsViewSection;
	searchableText: string;
}

type AgentsViewRowKind = "agent" | "subagent-summary" | "subagent" | "subagent-code";

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

	identity: string;

	parentIdentity?: string;

	hasChildren?: boolean;

	expanded?: boolean;

	hasSpawnTask?: boolean;

	spawnTask?: string;

	code?: string;
}

export interface AgentsViewIndex {
	byKey: Map<string, AgentsViewRecord>;
	childrenByParent: Map<AgentsViewRecord, AgentsViewRecord[]>;
}
export interface AgentsViewPersistentState {
	scopeFrames?: AgentsViewScopeFrame[];
	selectedRowIdentity?: string;
	query?: string;
	expandedSubagentParents?: Set<string>;
	programShownParents?: Set<string>;
}

function extractTextFromMessageContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		out += `${block.text}\n`;
	}
	return out;
}

export function extractLastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		const text = extractTextFromMessageContent(msg.content).trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

export function getRecordModelLabel(record: AgentsViewRecord | undefined): string | undefined {
	if (!record) return undefined;
	return record.ref?.history?.resolvedModel ?? undefined;
}

export function formatModelCellLabel(model: { provider: string; id: string }, level?: string): string {
	if (!level || level === "off") return `${model.provider}/${model.id}`;
	return `${model.provider}/${model.id}:${level}`;
}

function fileIdentity(sessionPath: string): string {
	return `file:${path.resolve(sessionPath)}`;
}

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

function classifyAgentsViewRecord(record: Pick<AgentsViewRecord, "ref" | "session">): AgentsViewSection {
	if (!record.ref) {
		if (record.session?.liveStreaming) return "running";
		return "inactive";
	}
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

function parentKeys(record: AgentsViewRecord): string[] {
	const keys: string[] = [];
	const sessionFile = getRecordSessionFile(record);
	if (sessionFile) {
		const derived = derivedParentSessionFile(sessionFile);
		if (derived) keys.push(fileIdentity(derived));
	}
	if (record.session?.parentSessionPath) keys.push(fileIdentity(record.session.parentSessionPath));

	if (record.ref?.parentId && record.ref.parentId !== MAIN_AGENT_ID) {
		keys.push(`active:${record.ref.parentId}`);
	}
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

	return records.filter(record => retained.has(record));
}

interface SpawnTaskGroup {
	task?: string;
	rows: MutableAgentsViewRow[];
}

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

		selectable: false,
		identity: `code:${parent.identity}:${groupIndex}:${lineIndex}`,
		parentIdentity: parent.identity,
		code,
	});
	const allLines = task.replace(/\s+$/, "").split("\n");

	const lines = allLines.slice(0, MAX_SPAWN_TASK_LINES).map((line, i) => makeRow(line, String(i)));
	const hidden = allLines.length - lines.length;
	if (hidden > 0) {
		lines.push(makeRow(`… +${hidden} more ${hidden === 1 ? "line" : "lines"}`, "more"));
	}

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
		case "current":
			return 2;
		case "inactive":
			return 3;
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

export function formatRowDetails(row: AgentsViewRow): string {
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

function getStatusLabel(record: AgentsViewRecord): string {
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
	if (record.session?.liveStreaming) return "running";
	if (record.session?.liveOpen) return "in use";
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
	const counts: Record<AgentsViewSection, number> = { running: 0, idle: 0, current: 0, inactive: 0 };
	let displaySection: AgentsViewSection | undefined;
	for (const row of rows) {
		if (row.depth === 0) displaySection = row.section;
		const section = displaySection ?? row.section;
		if (row.kind === "agent" || row.kind === "subagent") counts[section]++;
	}
	return counts;
}

export function sectionTitle(section: AgentsViewSection): string {
	switch (section) {
		case "running":
			return "Running";
		case "idle":
			return "Idle";
		case "current":
			return "Current";
		case "inactive":
			return "Inactive";
	}
}

export interface AgentsViewScopeFrame {
	identity: string;

	rootTitle: string;
}

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
		return {
			kind: "agent" as const,
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

	const childOfScopeRoot = (record: AgentsViewRecord): boolean =>
		scopeRootAliases.size > 0 && parentKeys(record).some(key => scopeRootAliases.has(key));

	const childrenByParent = new Map<MutableAgentsViewRow, MutableAgentsViewRow[]>();
	const nestedRows = new Set<MutableAgentsViewRow>();
	for (const row of baseRows) {
		if (!row.record) continue;
		// Children of the scope root render as roots — the scoped view flattens one level.
		if (childOfScopeRoot(row.record)) continue;
		const ref = row.record.ref;
		const refNested = Boolean(ref && (ref.kind === "sub" || ref.parentId));
		const parent = parentKeys(row.record)
			.map(key => rowsByKey.get(key))
			.find(Boolean);
		if (!parent || parent === row) continue;
		nestedRows.add(row);
		row.kind = "subagent";
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
