import {
	type Component,
	Container,
	FuzzyText,
	Input,
	matchesKey,
	padding,
	replaceTabs,
	routeSgrMouseInput,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { SessionInfo, SessionStatus } from "../../session/session-listing";
import { shortenPath } from "../../tools/render-utils";
import { HookSelectorComponent } from "./hook-selector";
import { bottomBorder, OverlayPanel, row, topBorder } from "./overlay-box";

function formatSessionStatus(status: SessionStatus | undefined): string | undefined {
	switch (status) {
		case "complete":
			return theme.fg("success", `${theme.status.success} done`);
		case "interrupted":
			return theme.fg("warning", `${theme.status.warning} interrupted`);
		case "aborted":
			return theme.fg("muted", `${theme.status.aborted} aborted`);
		case "error":
			return theme.fg("error", `${theme.status.error} error`);
		case "pending":
			return theme.fg("accent", `${theme.status.pending} pending`);
		default:
			return undefined;
	}
}

type SessionHistoryMatcher = (query: string) => string[];

function sessionSearchText(session: SessionInfo): string {
	const parts = [
		session.id,
		session.title ?? "",
		session.cwd ?? "",
		session.firstMessage ?? "",
		session.allMessagesText,
		session.path,
	];
	return parts.filter(Boolean).join(" ");
}

const kSearchTextLower = Symbol("session.searchTextLower");

interface SearchableSessionInfo extends SessionInfo {
	[kSearchTextLower]?: string;
}

function sessionTextLower(session: SessionInfo): string {
	const tagged = session as SearchableSessionInfo;
	let textLower = tagged[kSearchTextLower];
	if (textLower === undefined) {
		textLower = sessionSearchText(session).toLowerCase();
		tagged[kSearchTextLower] = textLower;
	}
	return textLower;
}

function tokenizeSessionQuery(query: string): string[] {
	const trimmed = query.trim().toLowerCase();
	return trimmed ? trimmed.split(/\s+/) : [];
}

function compareSessionRecency(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime();
}

const MIN_PURE_FUZZY_TOKEN_SCORE = -20;

interface RankedSessionMatch {
	session: SessionInfo;
	score: number;
	index: number;
}

function isLiteralMatch(textLower: string, tokens: string[]): boolean {
	for (const token of tokens) {
		if (!textLower.includes(token)) return false;
	}
	return true;
}

function scoreFuzzySession(
	session: SessionInfo,
	index: number,
	tokens: string[],
	fuzzy: FuzzyText,
): RankedSessionMatch | undefined {
	let score = 0;
	let worstTokenScore = Number.NEGATIVE_INFINITY;
	for (const token of tokens) {
		const match = fuzzy.match(token);
		if (!match.matches) return undefined;
		score += match.score;
		worstTokenScore = Math.max(worstTokenScore, match.score);
	}
	if (worstTokenScore >= MIN_PURE_FUZZY_TOKEN_SCORE) return undefined;
	return { session, score, index };
}

function compareLiteralRank(a: RankedSessionMatch, b: RankedSessionMatch): number {
	return compareSessionRecency(a.session, b.session) || a.index - b.index;
}

function compareFuzzyRank(a: RankedSessionMatch, b: RankedSessionMatch): number {
	return a.score - b.score || compareSessionRecency(a.session, b.session) || a.index - b.index;
}

export function rankSessionSearchMatches(allSessions: SessionInfo[], query: string): SessionInfo[] {
	const tokens = tokenizeSessionQuery(query);
	if (tokens.length === 0) return allSessions;

	const literal: RankedSessionMatch[] = [];
	const fuzzyMatches: RankedSessionMatch[] = [];
	for (let index = 0; index < allSessions.length; index++) {
		const session = allSessions[index]!;
		const textLower = sessionTextLower(session);
		if (isLiteralMatch(textLower, tokens)) {
			literal.push({ session, score: 0, index });
			continue;
		}
		const match = scoreFuzzySession(session, index, tokens, new FuzzyText(textLower));
		if (match) fuzzyMatches.push(match);
	}

	literal.sort(compareLiteralRank);
	fuzzyMatches.sort(compareFuzzyRank);
	const out: SessionInfo[] = [];
	for (const match of literal) out.push(match.session);
	for (const match of fuzzyMatches) out.push(match.session);
	return out;
}

export function mergeSessionRanking(
	allSessions: SessionInfo[],
	fuzzy: SessionInfo[],
	historyIds: string[],
): SessionInfo[] {
	if (historyIds.length === 0) return fuzzy;

	const sessionsById = new Map<string, SessionInfo>();
	for (const session of allSessions) {
		if (!sessionsById.has(session.id)) sessionsById.set(session.id, session);
	}

	const historyMatches: SessionInfo[] = [];
	const historyPaths = new Set<string>();
	for (const id of historyIds) {
		const session = sessionsById.get(id);
		if (!session || historyPaths.has(session.path)) continue;
		historyMatches.push(session);
		historyPaths.add(session.path);
	}
	if (historyMatches.length === 0) return fuzzy;

	const metadataOnly = fuzzy.filter(session => !historyPaths.has(session.path));
	return [...historyMatches, ...metadataOnly];
}

const HISTORY_MERGE_DEBOUNCE_MS = 150;

const HISTORY_MERGE_MIN_QUERY = 2;

const FUZZY_SCAN_INLINE_COUNT = 100;

const FUZZY_SCAN_CHUNK_COUNT = 150;

const SESSION_MINUTE_MS = 60_000;
const SESSION_HOUR_MS = 3_600_000;
const SESSION_DAY_MS = 86_400_000;
const SESSION_WEEK_MS = 604_800_000;

interface CachedSessionDate {
	modifiedMs: number;
	timeBucket: number;
	value: string;
}

function sessionItemHeight(session: SessionInfo): number {
	return session.title ? 4 : 3;
}

class SessionList implements Component {
	#filteredSessions: SessionInfo[] = [];
	#filteredTitlePrefix: number[] = [0];
	#filteredTotalRows = 0;
	#selectedIndex: number = 0;

	#hitRows: (number | undefined)[] = [];
	readonly #searchInput: Input;
	onSelect?: (session: SessionInfo) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	onToggleScope?: () => void;

	readonly #getTerminalRows: () => number;

	onDeleteRequest?: (session: SessionInfo) => void;

	#allSessions: SessionInfo[];
	#showCwd: boolean;
	#pinnedIds: ReadonlySet<string>;
	readonly #historyMatcher?: SessionHistoryMatcher;
	#historyMergeTimer: NodeJS.Timeout | undefined;

	onRequestRender?: () => void;

	#literalRanked: RankedSessionMatch[] = [];

	#fuzzyRanked: RankedSessionMatch[] = [];

	#historyIds: string[] = [];

	#scanGeneration = 0;
	#scanTimer: NodeJS.Timeout | undefined;

	#selectionMoved = false;
	#formattedDates = new Map<string, CachedSessionDate>();
	#normalizedMessages = new Map<string, { source: string; value: string }>();

	constructor(
		sessions: SessionInfo[],
		showCwd = false,
		historyMatcher?: SessionHistoryMatcher,
		getTerminalRows: () => number = () => 24,
		pinnedIds: ReadonlySet<string> = new Set(),
	) {
		this.#getTerminalRows = getTerminalRows;
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#pinnedIds = pinnedIds;
		this.#historyMatcher = historyMatcher;
		this.#setFilteredSessions(sessions);
		this.#searchInput = new Input();

		this.#searchInput.onSubmit = () => {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected) {
				this.onSelect?.(selected);
			}
		};
	}

	#setFilteredSessions(sessions: SessionInfo[]): void {
		this.#filteredSessions = sessions;
		const titlePrefix = new Array<number>(sessions.length + 1);
		titlePrefix[0] = 0;
		for (let index = 0; index < sessions.length; index++) {
			titlePrefix[index + 1] = titlePrefix[index]! + (sessions[index]!.title ? 1 : 0);
		}
		this.#filteredTitlePrefix = titlePrefix;
		this.#filteredTotalRows = sessions.length * 3 + titlePrefix[sessions.length]!;
	}

	#formatDate(session: SessionInfo, nowMs: number): string {
		const modifiedMs = session.modified.getTime();
		const ageMs = nowMs - modifiedMs;
		const timeBucket =
			ageMs < SESSION_HOUR_MS
				? Math.floor(nowMs / SESSION_MINUTE_MS)
				: ageMs < SESSION_DAY_MS
					? Math.floor(nowMs / SESSION_HOUR_MS)
					: ageMs < SESSION_WEEK_MS
						? Math.floor(nowMs / SESSION_DAY_MS)
						: 0;
		const cached = this.#formattedDates.get(session.path);
		if (cached && cached.modifiedMs === modifiedMs && cached.timeBucket === timeBucket) return cached.value;

		const diffMins = Math.floor(ageMs / SESSION_MINUTE_MS);
		const diffHours = Math.floor(ageMs / SESSION_HOUR_MS);
		const diffDays = Math.floor(ageMs / SESSION_DAY_MS);
		const value =
			diffMins < 1
				? "just now"
				: diffMins < 60
					? `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`
					: diffHours < 24
						? `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`
						: diffDays === 1
							? "1 day ago"
							: diffDays < 7
								? `${diffDays} days ago`
								: session.modified.toLocaleDateString();
		this.#formattedDates.set(session.path, { modifiedMs, timeBucket, value });
		return value;
	}

	#normalizedMessage(session: SessionInfo): string {
		const cached = this.#normalizedMessages.get(session.path);
		if (cached?.source === session.firstMessage) return cached.value;
		const value = session.firstMessage.replace(/\n/g, " ").trim();
		this.#normalizedMessages.set(session.path, { source: session.firstMessage, value });
		return value;
	}

	#lineBudget(): number {
		const CHROME = 7;
		const RESERVE = 1;
		return Math.max(8, this.#getTerminalRows() - CHROME - RESERVE);
	}

	#pageSize(): number {
		return Math.max(2, Math.floor(this.#lineBudget() / 4));
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean, pinnedIds?: ReadonlySet<string>): void {
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		if (pinnedIds !== undefined) this.#pinnedIds = pinnedIds;
		this.#selectedIndex = 0;
		this.#filterSessions(this.#searchInput.getValue());
	}

	#filterSessions(query: string): void {
		this.#scanGeneration++;
		if (this.#scanTimer !== undefined) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		this.#selectionMoved = false;
		this.#historyIds = [];
		this.#literalRanked = [];
		this.#fuzzyRanked = [];

		const tokens = tokenizeSessionQuery(query);
		if (tokens.length === 0) {
			this.#setFilteredSessions(this.#allSessions);
			this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredSessions.length - 1));
			this.#scheduleHistoryMerge(query);
			return;
		}

		const literal: RankedSessionMatch[] = [];
		const rest: number[] = [];
		const all = this.#allSessions;
		for (let index = 0; index < all.length; index++) {
			if (isLiteralMatch(sessionTextLower(all[index]!), tokens)) {
				literal.push({ session: all[index]!, score: 0, index });
			} else {
				rest.push(index);
			}
		}
		literal.sort(compareLiteralRank);
		this.#literalRanked = literal;

		this.#scanFuzzySlice(this.#scanGeneration, tokens, rest, 0, FUZZY_SCAN_INLINE_COUNT);
		this.#composeFiltered();
		this.#scheduleHistoryMerge(query);
	}

	#scanFuzzySlice(generation: number, tokens: string[], rest: number[], start: number, budget: number): void {
		const all = this.#allSessions;
		const end = Math.min(rest.length, start + budget);
		for (let i = start; i < end; i++) {
			const index = rest[i]!;
			const session = all[index]!;
			const match = scoreFuzzySession(session, index, tokens, new FuzzyText(sessionTextLower(session)));
			if (match) this.#fuzzyRanked.push(match);
		}
		if (end >= rest.length) return;
		this.#scanTimer = setTimeout(() => {
			this.#scanTimer = undefined;
			if (generation !== this.#scanGeneration) return;
			const before = this.#fuzzyRanked.length;
			this.#scanFuzzySlice(generation, tokens, rest, end, FUZZY_SCAN_CHUNK_COUNT);
			if (this.#fuzzyRanked.length > before) {
				this.#composeFiltered();
				this.onRequestRender?.();
			}
		}, 0);
	}

	#composeFiltered(): void {
		this.#fuzzyRanked.sort(compareFuzzyRank);
		const base: SessionInfo[] = [];
		for (const match of this.#literalRanked) base.push(match.session);
		for (const match of this.#fuzzyRanked) base.push(match.session);
		this.#setFilteredSessions(
			this.#historyIds.length > 0 ? mergeSessionRanking(this.#allSessions, base, this.#historyIds) : base,
		);
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredSessions.length - 1));
	}

	#scheduleHistoryMerge(query: string): void {
		if (this.#historyMergeTimer !== undefined) {
			clearTimeout(this.#historyMergeTimer);
			this.#historyMergeTimer = undefined;
		}
		const matcher = this.#historyMatcher;
		const trimmed = query.trim();
		if (!matcher || trimmed.length < HISTORY_MERGE_MIN_QUERY) return;
		this.#historyMergeTimer = setTimeout(() => {
			this.#historyMergeTimer = undefined;
			if (this.#searchInput.getValue() !== query) return;
			if (this.#selectionMoved) return;
			const historyIds = matcher(trimmed);
			if (historyIds.length === 0) return;
			this.#historyIds = historyIds;
			this.#composeFiltered();
			this.onRequestRender?.();
		}, HISTORY_MERGE_DEBOUNCE_MS);
	}

	dispose(): void {
		this.#scanGeneration++;
		if (this.#scanTimer !== undefined) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		if (this.#historyMergeTimer !== undefined) {
			clearTimeout(this.#historyMergeTimer);
			this.#historyMergeTimer = undefined;
		}
	}

	removeSession(sessionPath: string): void {
		const index = this.#allSessions.findIndex(s => s.path === sessionPath);
		if (index === -1) return;
		this.#allSessions.splice(index, 1);

		this.#filterSessions(this.#searchInput.getValue());

		if (this.#selectedIndex >= this.#filteredSessions.length) {
			this.#selectedIndex = Math.max(0, this.#filteredSessions.length - 1);
		}
	}

	hitTestSession(line: number): number | undefined {
		return this.#hitRows[line];
	}

	handleWheel(delta: -1 | 1): void {
		if (this.#filteredSessions.length === 0) return;
		this.#selectionMoved = true;
		this.#selectedIndex = Math.max(0, Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + delta));
	}

	selectAndConfirm(index: number): void {
		const session = this.#filteredSessions[index];
		if (!session) return;
		this.#selectedIndex = index;
		this.onSelect?.(session);
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];

		lines.push(...this.#searchInput.render(width));
		lines.push("");

		if (this.#filteredSessions.length === 0) {
			if (this.#showCwd) {
				lines.push(truncateToWidth(theme.fg("muted", "No sessions found"), width));
			} else {
				lines.push(
					truncateToWidth(theme.fg("muted", "No sessions in current folder. Press Tab to view all."), width),
				);
			}
			return lines;
		}

		const filtered = this.#filteredSessions;
		const budget = this.#lineBudget();
		let startIndex = this.#selectedIndex;
		let endIndex = this.#selectedIndex + 1;
		let used = sessionItemHeight(filtered[this.#selectedIndex]!);

		for (let preferDown = true; ; preferDown = !preferDown) {
			const canDown = endIndex < filtered.length && used + sessionItemHeight(filtered[endIndex]!) <= budget;
			const canUp = startIndex > 0 && used + sessionItemHeight(filtered[startIndex - 1]!) <= budget;
			if (!canDown && !canUp) break;
			if (canDown && (preferDown || !canUp)) {
				used += sessionItemHeight(filtered[endIndex]!);
				endIndex++;
			} else {
				startIndex--;
				used += sessionItemHeight(filtered[startIndex]!);
			}
		}

		const sessionLines: string[] = [];
		const sessionRowIndex: number[] = [];
		const overflow = startIndex > 0 || endIndex < filtered.length;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
		const nowMs = Date.now();
		const cursorSymbol = `${theme.nav.cursor} `;
		const cursorWidth = visibleWidth(cursorSymbol);
		const dim = (value: string) => theme.fg("dim", value);
		const dot = dim(theme.sep.dot);
		const pinPrefixWidth = visibleWidth(`${theme.icon.pin} `);
		const pinnedPrefix = theme.fg("accent", `${theme.icon.pin} `);
		for (let i = startIndex; i < endIndex; i++) {
			const blockStart = sessionLines.length;
			const session = this.#filteredSessions[i];
			const isSelected = i === this.#selectedIndex;

			const normalizedMessage = this.#normalizedMessage(session);

			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = rowWidth - cursorWidth;

			const isPinned = this.#pinnedIds.has(session.id);
			const pinPrefix = isPinned ? pinnedPrefix : "";
			const sessionPinWidth = isPinned ? pinPrefixWidth : 0;
			const maxTextWidth = Math.max(0, maxWidth - sessionPinWidth);

			if (session.title) {
				const truncatedTitle = truncateToWidth(session.title, maxTextWidth);
				const titleLine = `${cursor}${pinPrefix}${isSelected ? theme.bold(truncatedTitle) : truncatedTitle}`;
				sessionLines.push(titleLine);

				const truncatedPreview = truncateToWidth(normalizedMessage, maxWidth);
				sessionLines.push(`  ${theme.fg("dim", truncatedPreview)}`);
			} else {
				const truncatedMsg = truncateToWidth(normalizedMessage, maxTextWidth);
				const messageLine = `${cursor}${pinPrefix}${isSelected ? theme.bold(truncatedMsg) : truncatedMsg}`;
				sessionLines.push(messageLine);
			}

			const modified = this.#formatDate(session, nowMs);
			let metadata = `  ${dim(modified)} ${dot} ${dim(formatBytes(session.size))}`;
			const status = formatSessionStatus(session.status);
			if (status) {
				metadata += ` ${dot} ${status}`;
			}
			if (session.parentSessionPath) {
				metadata += ` ${dot} ${dim(`${theme.icon.branch} fork`)}`;
			}
			if (this.#showCwd && session.cwd) {
				metadata += ` ${dot} ${dim(shortenPath(session.cwd))}`;
			}
			const metadataLine = truncateToWidth(metadata, rowWidth);

			sessionLines.push(metadataLine);

			if (i < endIndex - 1) sessionLines.push("");
			for (let k = blockStart; k < sessionLines.length; k++) sessionRowIndex[k] = i;
		}

		const totalRows = this.#filteredTotalRows - 1;
		const offsetRows = startIndex * 3 + this.#filteredTitlePrefix[startIndex]!;
		const height = sessionLines.length;
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		const showScrollbar = safeWidth > 0 && totalRows > height;
		const contentWidth = Math.max(0, safeWidth - (showScrollbar ? 1 : 0));
		const maxScrollOffset = Math.max(0, totalRows - height);
		const scrollOffset = Math.max(0, Math.min(offsetRows, maxScrollOffset));
		const thumbSize = showScrollbar ? Math.max(1, Math.min(Math.floor((height * height) / totalRows), height)) : 0;
		const thumbTravel = height - thumbSize;
		const thumbStart =
			showScrollbar && maxScrollOffset > 0 ? Math.round((scrollOffset / maxScrollOffset) * thumbTravel) : 0;
		const sessionRegionStart = lines.length;
		for (let row = 0; row < height; row++) {
			const source = sessionLines[row] ?? "";
			const truncated = truncateToWidth(replaceTabs(source), contentWidth);
			if (!showScrollbar) {
				lines.push(truncated);
			} else {
				const content = `${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
				const isThumb = row >= thumbStart && row < thumbStart + thumbSize;
				const bar = isThumb ? theme.fg("accent", "█") : theme.fg("muted", "│");
				lines.push(`${content}${bar}`);
			}
			this.#hitRows[sessionRegionStart + row] = sessionRowIndex[row];
		}

		return lines;
	}

	handleInput(keyData: string): void {
		if (
			matchesKey(keyData, "delete") ||
			(matchesKey(keyData, "backspace") && this.#searchInput.getValue().length === 0)
		) {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onDeleteRequest) {
				this.onDeleteRequest(selected);
			}
			return;
		}

		if (matchesSelectUp(keyData)) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}

		if (matchesSelectDown(keyData)) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + 1);
			return;
		}

		if (matchesKey(keyData, "pageUp")) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#pageSize());
			return;
		}

		if (matchesKey(keyData, "pageDown")) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + this.#pageSize());
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected);
			}
			return;
		}

		if (matchesAppInterrupt(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}

		if (matchesKey(keyData, "ctrl+c")) {
			this.onExit();
			return;
		}

		if (matchesKey(keyData, "tab")) {
			this.onToggleScope?.();
			return;
		}

		this.#searchInput.handleInput(keyData);
		this.#filterSessions(this.#searchInput.getValue());
	}
}

export interface SessionSelectorOptions {
	onDelete?: (session: SessionInfo) => Promise<boolean>;
	historyMatcher?: SessionHistoryMatcher;

	loadAllSessions?: () => Promise<SessionInfo[]>;

	allSessions?: SessionInfo[];

	title?: string;

	scopeLabel?: string | false;

	showCwd?: boolean;

	getTerminalRows?: () => number;

	fillHeight?: boolean;

	pinnedIds?: ReadonlySet<string>;
}

export class SessionSelectorComponent extends OverlayPanel {
	#sessionList: SessionList;
	#confirmationDialog: HookSelectorComponent | null = null;

	#contentSlot: Container;
	#messageContainer: Container;
	#onDelete?: (session: SessionInfo) => Promise<boolean>;
	#onRequestRender?: () => void;
	readonly #loadAllSessions?: () => Promise<SessionInfo[]>;
	#folderSessions: SessionInfo[];
	#globalSessions: SessionInfo[] | null = null;
	#scope: "folder" | "all" = "folder";
	#toggling = false;
	#inputLocked = false;

	#listLineOffset = 0;

	#footerStart = 0;
	readonly #getTerminalRows: () => number;
	readonly #fillHeight: boolean;
	readonly #title: string;
	readonly #scopeLabel: string | false | undefined;

	constructor(
		sessions: SessionInfo[],
		onSelect: (session: SessionInfo) => void,
		onCancel: () => void,
		onExit: () => void,
		options: SessionSelectorOptions = {},
	) {
		super(options.title ?? "Resume Session");

		this.#messageContainer = new Container();
		this.#onDelete = options.onDelete;
		this.#loadAllSessions = options.loadAllSessions;
		this.#folderSessions = sessions;
		this.#globalSessions = options.allSessions ?? null;
		this.#getTerminalRows = options.getTerminalRows ?? (() => 24);
		this.#fillHeight = options.fillHeight ?? false;
		this.#title = options.title ?? "Resume Session";
		this.#scopeLabel = options.scopeLabel;
		this.title = this.#headerLabel();

		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);

		this.#sessionList = new SessionList(
			sessions,
			options.showCwd ?? false,
			options.historyMatcher,
			options.getTerminalRows,
			options.pinnedIds,
		);

		this.#sessionList.onSelect = session => {
			this.#sessionList.dispose();
			onSelect(session);
		};
		this.#sessionList.onCancel = () => {
			this.#sessionList.dispose();
			onCancel();
		};
		this.#sessionList.onExit = () => {
			this.#sessionList.dispose();
			onExit();
		};
		this.#sessionList.onRequestRender = () => this.#onRequestRender?.();
		this.#sessionList.onDeleteRequest = (session: SessionInfo) => {
			this.#showDeleteConfirmation(session);
		};
		if (this.#loadAllSessions || this.#globalSessions) {
			this.#sessionList.onToggleScope = () => {
				void this.#toggleScope();
			};
		}
		this.#contentSlot = new Container();
		this.#contentSlot.addChild(this.#sessionList);
		this.addChild(this.#contentSlot);
	}

	#headerLabel(): string {
		if (this.#scopeLabel === false) return this.#title;
		const scopeLabel = this.#scopeLabel ?? (this.#scope === "all" ? "all projects" : "current folder");
		return `${this.#title} (${scopeLabel})`;
	}

	async #toggleScope(): Promise<void> {
		if (this.#toggling || this.#confirmationDialog) return;
		if (this.#scope === "folder") {
			let global = this.#globalSessions;
			if (!global) {
				if (!this.#loadAllSessions) return;
				this.#toggling = true;
				this.#messageContainer.clear();
				this.#messageContainer.addChild(new Text(theme.fg("muted", "Loading all projects…"), 0, 0));
				this.#onRequestRender?.();
				try {
					global = await this.#loadAllSessions();
				} catch (err) {
					this.#showError(err instanceof Error ? err.message : String(err));
					this.#toggling = false;
					this.#onRequestRender?.();
					return;
				}
				this.#globalSessions = global;
				this.#messageContainer.clear();
				this.#toggling = false;
			}
			this.#scope = "all";
			this.#sessionList.setSessions(global, true);
		} else {
			this.#scope = "folder";
			this.#sessionList.setSessions(this.#folderSessions, false);
		}
		this.title = this.#headerLabel();
		this.#onRequestRender?.();
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}

	lockInput(): void {
		this.#inputLocked = true;
	}

	unlockInput(): void {
		this.#inputLocked = false;
	}

	override dispose(): void {
		this.#sessionList.dispose();
		super.dispose();
	}

	#clearError(): void {
		this.#messageContainer.clear();
	}

	#showError(message: string): void {
		this.#messageContainer.clear();
		this.#messageContainer.addChild(new Text(theme.fg("error", `Error: ${replaceTabs(message)}`), 0, 0));
		this.#messageContainer.addChild(new Spacer(1));
	}

	#showDeleteConfirmation(session: SessionInfo): void {
		const displayName = session.title || session.firstMessage.slice(0, 40) || session.id;
		const closeDialog = () => {
			this.#confirmationDialog = null;

			this.#contentSlot.clear();
			this.#contentSlot.addChild(this.#sessionList);
			this.#onRequestRender?.();
		};
		this.#confirmationDialog = new HookSelectorComponent(
			`Delete session?\n${displayName}`,
			["Yes", "No"],
			async (option: string) => {
				if (option === "Yes" && this.#onDelete) {
					this.#clearError();
					try {
						const deleted = await this.#onDelete(session);
						if (deleted) {
							this.#sessionList.removeSession(session.path);
						}
					} catch (err) {
						this.#showError(err instanceof Error ? err.message : String(err));
					}
				}
				closeDialog();
			},
			closeDialog,
		);

		this.#contentSlot.clear();
		this.#contentSlot.addChild(this.#confirmationDialog);
		this.#onRequestRender?.();
	}

	override render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		const lines: string[] = [topBorder(width, this.title)];
		for (const child of this.children) {
			const childLines = child.render(innerWidth);
			if (child === this.#contentSlot) this.#listLineOffset = lines.length;
			for (const line of childLines) lines.push(row(line, width));
		}
		const footer = this.#footerLines(width);
		if (this.#fillHeight) {
			const target = Math.max(0, this.#getTerminalRows() - footer.length);
			if (lines.length > target) lines.length = target;
			else for (let i = lines.length; i < target; i++) lines.push(row("", width));
		}
		this.#footerStart = lines.length;
		for (const line of footer) lines.push(line);
		return lines;
	}

	#footerLines(width: number): string[] {
		const scopeHint = this.#scope === "all" ? "current folder" : "all projects";
		const hint = theme.fg("muted", `[Del/⌫ delete · Enter select · Tab ${scopeHint} · Esc cancel]`);
		return [row("", width), row(hint, width), row("", width), bottomBorder(width)];
	}

	handleInput(keyData: string): void {
		if (this.#inputLocked) return;
		if (keyData.startsWith("\x1b[<")) {
			this.#handleMouse(keyData);
			return;
		}
		if (this.#confirmationDialog) {
			this.#confirmationDialog.handleInput(keyData);
		} else {
			this.#sessionList.handleInput(keyData);
		}
	}

	#handleMouse(data: string): void {
		if (this.#confirmationDialog) return;
		routeSgrMouseInput(data, event => {
			if (event.wheel !== null) {
				this.#sessionList.handleWheel(event.wheel);
				return true;
			}
			if (!event.leftClick || event.row >= this.#footerStart) return true;
			const index = this.#sessionList.hitTestSession(event.row - this.#listLineOffset);
			if (index !== undefined) this.#sessionList.selectAndConfirm(index);
			return true;
		});
	}

	getSessionList(): SessionList {
		return this.#sessionList;
	}
}
