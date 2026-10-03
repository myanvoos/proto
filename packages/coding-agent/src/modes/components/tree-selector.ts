import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	EDITOR_LIMITS,
	extractPrintableText,
	fuzzyMatch,
	Input,
	matchesKey,
	TruncatedText,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { formatBytes, isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TreeFilterMode } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../../modes/utils/keybinding-matchers";
import type { SessionEntry, SessionTreeNode } from "../../session/session-entries";
import { shortenPath } from "../../tools/render-utils";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { resolveAssistantErrorPresentation } from "../utils/transcript-render-helpers";
import { bottomBorder, getDialogViewport, OverlayPanel, renderDialogContent, row, topBorder } from "./overlay-box";
import { centeredWindow, contentRowWidth, renderScrollableList } from "./selector-helpers";

function sanitizeTreeText(value: string): string {
	return sanitizeText(value.replace(/[\r\n\t]/g, " "));
}

function normalizeTreeText(value: string): string {
	return sanitizeTreeText(value).trim();
}

function sanitizeTreeValue(value: unknown): unknown {
	if (typeof value === "string") return normalizeTreeText(value);
	if (Array.isArray(value)) return value.map(sanitizeTreeValue);
	if (value !== null && typeof value === "object") {
		const sanitized = Object.create(null) as Record<string, unknown>;
		for (const [key, child] of Object.entries(value)) {
			sanitized[normalizeTreeText(key)] = sanitizeTreeValue(child);
		}
		return sanitized;
	}
	return value;
}

/** Advisor rows show `details.notes`, not the model-facing `<advisory>` content. */
function advisorTreeDisplay(details: unknown): { qualifier: string; text: string } {
	if (!isRecord(details) || !Array.isArray(details.notes)) return { qualifier: "", text: "" };
	const notes: string[] = [];
	const advisors: string[] = [];
	const severities: string[] = [];
	for (const note of details.notes) {
		if (!isRecord(note)) continue;
		if (typeof note.note === "string") notes.push(note.note);
		if (typeof note.advisor === "string") {
			const name = normalizeTreeText(note.advisor);
			if (name && name !== "default" && !advisors.includes(name)) advisors.push(name);
		}
		if (typeof note.severity === "string") {
			const severity = normalizeTreeText(note.severity);
			if (severity && !severities.includes(severity)) severities.push(severity);
		}
	}
	return { qualifier: [...advisors, ...severities].join(", "), text: notes.join(" ") };
}

/**
 * Strips one model-facing `<system-*>` envelope; nested system tags belong to the payload.
 * Linear scan, quote-aware so `>` inside attribute values doesn't end the opening tag.
 */
function stripSystemWrapper(content: string): string {
	const trimmed = content.trim();
	const opening = /^<(system-[\w-]+)/i.exec(trimmed);
	if (!opening) return content;

	const attributeStart = opening[0].length;
	const afterName = trimmed[attributeStart];
	if (afterName !== ">" && !/\s/.test(afterName ?? "")) return content;

	let quote: '"' | "'" | undefined;
	let openingEnd = -1;
	for (let index = attributeStart; index < trimmed.length; index++) {
		const character = trimmed[index];
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "<") {
			return content;
		} else if (character === ">") {
			openingEnd = index;
			break;
		}
	}
	if (openingEnd === -1 || quote) return content;

	const closingTag = `</${opening[1]}>`;
	const closingStart = trimmed.length - closingTag.length;
	if (closingStart <= openingEnd || trimmed.slice(closingStart).toLowerCase() !== closingTag.toLowerCase()) {
		return content;
	}
	return trimmed.slice(openingEnd + 1, closingStart).trim();
}

interface GutterInfo {
	position: number;
	show: boolean;
}

interface FlatNode {
	node: SessionTreeNode;

	indent: number;

	showConnector: boolean;

	isLast: boolean;

	gutters: GutterInfo[];

	isVirtualRootChild: boolean;
}

type FilterMode = TreeFilterMode;

interface ToolCallInfo {
	entryId: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** A subagent/side-agent row shown beneath the branch tree; Enter focuses it. */
export interface TreeAgentEntry {
	id: string;
	title: string;
	kindLabel: string;
	status: string;
	running: boolean;
	aborted: boolean;
	model?: string;
}

class TreeList implements Component {
	#flatNodes: FlatNode[] = [];
	#filteredNodes: FlatNode[] = [];
	#selectedIndex = 0;
	#filterMode: FilterMode;
	#searchQuery = "";
	#searchRejection: string | undefined;
	#toolCallMap: Map<string, ToolCallInfo> = new Map();
	#multipleRoots = false;
	#activePathIds: Set<string> = new Set();
	#lastSelectedId: string | null = null;
	#agents: TreeAgentEntry[] = [];
	#filteredAgents: TreeAgentEntry[] = [];
	#lastSelectedAgentId: string | null = null;

	onSelect?: (entryId: string, options: { summarize: boolean }) => void;
	onCancel?: () => void;
	onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;
	onFocusAgent?: (agentId: string) => void;

	constructor(
		tree: SessionTreeNode[],
		private readonly currentLeafId: string | null,
		private maxVisibleLines: number,
		initialFilterMode: FilterMode = "default",
		initialSelectedId?: string,
		private readonly resolveEntry?: (entryId: string) => SessionEntry | undefined,
		agents: TreeAgentEntry[] = [],
	) {
		this.#filterMode = initialFilterMode;
		this.#multipleRoots = tree.length > 1;
		this.#flatNodes = this.#flattenTree(tree);
		this.#agents = agents;
		this.#buildActivePath();
		this.#applyFilter();

		const targetId = initialSelectedId ?? currentLeafId;
		this.#selectedIndex = this.#findNearestVisibleIndex(targetId);
		this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? null;
	}

	#buildActivePath(): void {
		this.#activePathIds.clear();
		if (!this.currentLeafId) return;

		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.#flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		let currentId: string | null = this.currentLeafId;
		while (currentId) {
			this.#activePathIds.add(currentId);
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}
	}

	#findNearestVisibleIndex(entryId: string | null): number {
		if (this.#filteredNodes.length === 0) return 0;

		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.#flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		const visibleIdToIndex = new Map<string, number>(this.#filteredNodes.map((node, i) => [node.node.entry.id, i]));

		let currentId = entryId;
		while (currentId !== null) {
			const index = visibleIdToIndex.get(currentId);
			if (index !== undefined) return index;
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}

		return this.#filteredNodes.length - 1;
	}

	#flattenTree(roots: SessionTreeNode[]): FlatNode[] {
		const result: FlatNode[] = [];
		this.#toolCallMap.clear();

		type StackItem = [SessionTreeNode, number, boolean, boolean, GutterInfo[], boolean];
		const stack: StackItem[] = [];

		const containsActive = new Map<SessionTreeNode, boolean>();
		const leafId = this.currentLeafId;
		{
			const allNodes: SessionTreeNode[] = [];
			const preOrderStack: SessionTreeNode[] = [...roots];
			while (preOrderStack.length > 0) {
				const node = preOrderStack.pop()!;
				allNodes.push(node);

				for (let i = node.children.length - 1; i >= 0; i--) {
					preOrderStack.push(node.children[i]);
				}
			}

			for (let i = allNodes.length - 1; i >= 0; i--) {
				const node = allNodes[i];
				let has = leafId !== null && node.entry.id === leafId;
				for (const child of node.children) {
					if (containsActive.get(child)) {
						has = true;
					}
				}
				containsActive.set(node, has);
			}
		}

		const multipleRoots = roots.length > 1;
		const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
		for (let i = orderedRoots.length - 1; i >= 0; i--) {
			const isLast = i === orderedRoots.length - 1;
			stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, isLast, [], multipleRoots]);
		}

		while (stack.length > 0) {
			const [node, indent, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

			const entry = node.entry;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const content = (entry.message as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
							const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
							this.#toolCallMap.set(tc.id, { entryId: entry.id, name: tc.name, arguments: tc.arguments });
						}
					}
				}
			}

			result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

			const children = node.children;
			const multipleChildren = children.length > 1;

			const orderedChildren = (() => {
				const prioritized: SessionTreeNode[] = [];
				const rest: SessionTreeNode[] = [];
				for (const child of children) {
					if (containsActive.get(child)) {
						prioritized.push(child);
					} else {
						rest.push(child);
					}
				}
				return [...prioritized, ...rest];
			})();

			const childIndent = multipleChildren || isVirtualRootChild ? indent + 1 : indent;

			const connectorDisplayed = showConnector && !isVirtualRootChild;

			const currentDisplayIndent = this.#multipleRoots ? Math.max(0, indent - 1) : indent;
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			const childGutters: GutterInfo[] = connectorDisplayed
				? [...gutters, { position: connectorPosition, show: !isLast }]
				: gutters;

			for (let i = orderedChildren.length - 1; i >= 0; i--) {
				const childIsLast = i === orderedChildren.length - 1;
				stack.push([orderedChildren[i], childIndent, multipleChildren, childIsLast, childGutters, false]);
			}
		}

		return result;
	}

	/** Combined selectable count: branch entries first, then the agents section. */
	get #selectableCount(): number {
		return this.#filteredNodes.length + this.#filteredAgents.length;
	}

	#selectedAgent(): TreeAgentEntry | undefined {
		return this.#filteredAgents[this.#selectedIndex - this.#filteredNodes.length];
	}

	#applyFilter(): void {
		if (this.#filteredNodes.length > 0) {
			this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? this.#lastSelectedId;
		}

		const searchTokens = this.#searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

		this.#filteredNodes = this.#flatNodes.filter(flatNode => {
			const entry = flatNode.node.entry;
			const isCurrentLeaf = entry.id === this.currentLeafId;

			if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
				const msg = entry.message as { stopReason?: string; content?: unknown };
				const hasText = this.#hasTextContent(msg.content);
				const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";

				if (!hasText && !isErrorOrAborted) {
					return false;
				}
			}

			let passesFilter = true;

			const isSettingsEntry =
				entry.type === "label" ||
				entry.type === "custom" ||
				entry.type === "model_change" ||
				entry.type === "thinking_level_change" ||
				entry.type === "service_tier_change" ||
				entry.type === "title_change" ||
				entry.type === "credential_pin" ||
				entry.type === "session_init" ||
				entry.type === "ttsr_injection" ||
				entry.type === "mode_change" ||
				entry.type === "reset_boundary";

			switch (this.#filterMode) {
				case "user-only":
					passesFilter = entry.type === "message" && entry.message.role === "user";
					break;
				case "no-tools":
					passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
					break;
				case "labeled-only":
					passesFilter = flatNode.node.label !== undefined;
					break;
				case "all":
					passesFilter = true;
					break;
				default:
					passesFilter = !isSettingsEntry;
					break;
			}

			if (!passesFilter) return false;

			if (searchTokens.length > 0) {
				const nodeText = this.#getSearchableText(flatNode.node);
				return searchTokens.every(token => fuzzyMatch(token, nodeText).matches);
			}

			return true;
		});

		if (searchTokens.length > 0) {
			this.#filteredAgents = this.#agents.filter(agent => {
				const haystack = `${agent.title} ${agent.kindLabel} ${agent.status} ${agent.model ?? ""}`;
				return searchTokens.every(token => fuzzyMatch(token, haystack).matches);
			});
		} else {
			this.#filteredAgents = this.#agents;
		}

		if (this.#lastSelectedAgentId && this.#filteredAgents.some(agent => agent.id === this.#lastSelectedAgentId)) {
			const agentIndex = this.#filteredAgents.findIndex(agent => agent.id === this.#lastSelectedAgentId);
			this.#selectedIndex = this.#filteredNodes.length + agentIndex;
		} else {
			this.#lastSelectedAgentId = null;
			if (this.#lastSelectedId) {
				this.#selectedIndex = this.#findNearestVisibleIndex(this.#lastSelectedId);
			} else if (this.#selectedIndex >= this.#selectableCount) {
				this.#selectedIndex = Math.max(0, this.#selectableCount - 1);
			}
		}

		if (this.#selectedIndex < this.#filteredNodes.length && this.#filteredNodes.length > 0) {
			this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? this.#lastSelectedId;
		}
	}

	#getSearchableText(node: SessionTreeNode): string {
		// Full payloads are transient search inputs, never retained in the tree.
		const entry = this.resolveEntry?.(node.entry.id) ?? node.entry;
		const parts: string[] = [];

		if (node.label) {
			parts.push(node.label);
		}

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				parts.push(msg.role);
				if ("content" in msg && msg.content) {
					parts.push(this.#extractContent(msg.content, false));
				}
				if (msg.role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					if (bashMsg.command) parts.push(bashMsg.command);
				}
				break;
			}
			case "custom_message": {
				parts.push(entry.customType);
				if (entry.customType === "advisor") {
					const { qualifier, text } = advisorTreeDisplay(entry.details);
					parts.push(qualifier, text);
				} else {
					parts.push(stripSystemWrapper(this.#extractContent(entry.content, false)));
				}
				break;
			}
			case "compaction":
				parts.push("compaction");
				break;
			case "branch_summary":
				parts.push("branch summary", entry.summary);
				break;
			case "model_change":
				parts.push("model", entry.model);
				break;
			case "thinking_level_change":
				parts.push("thinking", entry.thinkingLevel ?? ThinkingLevel.Off);
				break;
			case "custom":
				parts.push("custom", entry.customType);
				break;
			case "label":
				parts.push("label", entry.label ?? "");
				break;
			case "service_tier_change":
				parts.push("service tier");
				if (entry.serviceTier) {
					const serviceTier = entry.serviceTier;
					for (const family in serviceTier) {
						const tier = serviceTier[family as keyof typeof serviceTier];
						if (tier) parts.push(family, tier);
					}
				}
				break;
			case "title_change":
				parts.push("title", entry.title);
				break;
			case "mode_change":
				parts.push("mode", entry.mode);
				break;
			case "credential_pin":
				parts.push("credential pin", entry.provider);
				break;
			case "ttsr_injection":
				parts.push("ttsr injection", ...entry.injectedRules);
				break;
			case "reset_boundary":
				parts.push("reset boundary");
				break;
			case "session_init":
				parts.push("session init");
				break;
		}

		return parts.join(" ");
	}

	setMaxHeight(rows: number): void {
		this.maxVisibleLines = Math.max(1, Math.trunc(rows));
	}

	invalidate(): void {}

	dispose(): void {
		this.#flatNodes = [];
		this.#filteredNodes = [];
		this.#toolCallMap.clear();
		this.#activePathIds.clear();
		this.#searchQuery = "";
		this.#lastSelectedId = null;
	}

	getSearchQuery(): string {
		return this.#searchQuery;
	}

	getSearchRejection(): string | undefined {
		return this.#searchRejection;
	}

	getSelectedNode(): SessionTreeNode | undefined {
		return this.#filteredNodes[this.#selectedIndex]?.node;
	}

	updateNodeLabel(entryId: string, label: string | undefined): void {
		for (const flatNode of this.#flatNodes) {
			if (flatNode.node.entry.id === entryId) {
				flatNode.node.label = label;
				break;
			}
		}
	}

	getFilterLabel(): string {
		switch (this.#filterMode) {
			case "no-tools":
				return " [no-tools]";
			case "user-only":
				return " [user]";
			case "labeled-only":
				return " [labeled]";
			case "all":
				return " [all]";
			default:
				return "";
		}
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];

		if (this.#selectableCount === 0) {
			if (this.#flatNodes.length === 0 && this.#agents.length === 0) {
				lines.push(truncateToWidth(theme.fg("muted", "No entries found"), width));
				lines.push(truncateToWidth(theme.fg("muted", `(0/0)${this.getFilterLabel()}`), width));
			} else if (this.#searchQuery.length > 0) {
				lines.push(truncateToWidth(theme.fg("muted", `No entries match search "${this.#searchQuery}"`), width));
				lines.push(truncateToWidth(theme.fg("muted", "Press Backspace to clear the search"), width));
				lines.push(
					truncateToWidth(
						theme.fg("muted", `(0/${this.#flatNodes.length + this.#agents.length})${this.getFilterLabel()}`),
						width,
					),
				);
			} else {
				const filterLabel = this.getFilterLabel().trim() || "[default]";
				lines.push(
					truncateToWidth(
						theme.fg(
							"muted",
							`${this.#flatNodes.length + this.#agents.length} entries hidden by the current filter ${filterLabel}`,
						),
						width,
					),
				);
				lines.push(truncateToWidth(theme.fg("muted", "Press Alt+A to show all, Alt+D for default"), width));
				lines.push(
					truncateToWidth(
						theme.fg("muted", `(0/${this.#flatNodes.length + this.#agents.length})${this.getFilterLabel()}`),
						width,
					),
				);
			}
			return lines.slice(0, this.maxVisibleLines);
		}

		const { startIndex, endIndex } = centeredWindow(this.#selectedIndex, this.#selectableCount, this.maxVisibleLines);

		const MIN_CONTENT_COLS = 24;
		const OVERHEAD_COLS = 4;
		const contentReserve = Math.max(MIN_CONTENT_COLS, Math.floor(width / 2));
		const maxIndentLevels = Math.max(0, Math.floor((width - contentReserve - OVERHEAD_COLS) / 3));

		const rowWidth = contentRowWidth(width, this.#selectableCount, this.maxVisibleLines);
		const rows: string[] = [];

		// One horizontal scroll offset for the whole window: per-row offsets would put a
		// different tree depth in the same column on each line and break connectors/gutters.
		const depthOf = (flatNode: FlatNode): number =>
			this.#multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;
		let deepest = 0;
		for (const flatNode of this.#filteredNodes.slice(startIndex, endIndex))
			deepest = Math.max(deepest, depthOf(flatNode));
		const windowOffset = Math.max(0, deepest - maxIndentLevels);

		for (let i = startIndex; i < endIndex; i++) {
			const agent =
				i >= this.#filteredNodes.length ? this.#filteredAgents[i - this.#filteredNodes.length] : undefined;
			if (agent) {
				if (i === this.#filteredNodes.length) {
					const header = theme.fg("muted", "── Agents (Enter to focus) ".padEnd(rowWidth, "─"));
					rows.push(truncateToWidth(header, rowWidth));
				}
				rows.push(this.#renderAgentRow(agent, i === this.#selectedIndex, rowWidth));
				continue;
			}
			const flatNode = this.#filteredNodes[i];
			const entry = flatNode.node.entry;
			const isSelected = i === this.#selectedIndex;

			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			const displayIndent = depthOf(flatNode);

			const hasConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			const connectorSymbol = hasConnector ? (flatNode.isLast ? theme.tree.last : theme.tree.branch) : "";
			const connectorChars = hasConnector ? Array.from(connectorSymbol) : [];
			const scrollOffset = Math.min(windowOffset, displayIndent);
			const renderedIndent = displayIndent - scrollOffset;
			const connectorPositionDisplay = hasConnector ? renderedIndent - 1 : -1;

			const totalChars = renderedIndent * 3;
			const prefixChars: string[] = [];
			for (let i = 0; i < totalChars; i++) {
				const level = Math.floor(i / 3);
				const originalLevel = level + scrollOffset;
				const posInLevel = i % 3;

				const gutter = flatNode.gutters.find(g => g.position === originalLevel);
				if (gutter) {
					if (posInLevel === 0) {
						prefixChars.push(gutter.show ? theme.tree.vertical : " ");
					} else {
						prefixChars.push(" ");
					}
				} else if (hasConnector && level === connectorPositionDisplay) {
					if (posInLevel === 0) {
						prefixChars.push(connectorChars[0] ?? " ");
					} else if (posInLevel === 1) {
						prefixChars.push(connectorChars[1] ?? theme.tree.horizontal);
					} else {
						prefixChars.push(connectorChars[2] ?? " ");
					}
				} else {
					prefixChars.push(" ");
				}
			}

			if (scrollOffset > 0 && prefixChars.length > 0) {
				prefixChars[0] = "…";
			}
			const prefix = prefixChars.join("");

			const isOnActivePath = this.#activePathIds.has(entry.id);
			const pathMarker = isOnActivePath && rowWidth >= 24 ? theme.fg("accent", `${theme.md.bullet} `) : "";

			const label = flatNode.node.label ? theme.fg("warning", `[${normalizeTreeText(flatNode.node.label)}] `) : "";
			const content = this.#getEntryDisplayText(flatNode.node, isSelected, rowWidth < 32);

			let line = cursor + theme.fg("dim", prefix) + pathMarker + label + content;
			if (isSelected) {
				line = theme.bg("selectedBg", line);
			}
			rows.push(truncateToWidth(line, rowWidth));
		}

		lines.push(
			...renderScrollableList(rows, {
				width,
				totalRows:
					this.#selectableCount +
					(endIndex > this.#filteredNodes.length && startIndex <= this.#filteredNodes.length ? 1 : 0),
				scrollOffset: startIndex,
			}),
		);

		return lines;
	}

	#renderAgentRow(agent: TreeAgentEntry, isSelected: boolean, rowWidth: number): string {
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
		const statusGlyph = agent.running
			? theme.fg("success", "●")
			: agent.aborted
				? theme.fg("error", "✗")
				: theme.fg("muted", "○");
		const title = normalizeTreeText(agent.title) || agent.id;
		const details: string[] = [agent.kindLabel];
		if (agent.model) details.push(agent.model);
		details.push(agent.status);
		const suffix = theme.fg("dim", `  ${details.join(" · ")}`);
		let line = `${cursor}${statusGlyph} ${title}${suffix}`;
		if (isSelected) line = theme.bg("selectedBg", line);
		return truncateToWidth(line, rowWidth);
	}

	#getEntryDisplayText(node: SessionTreeNode, isSelected: boolean, compact: boolean): string {
		const entry = node.entry;
		let result: string;

		const normalize = normalizeTreeText;

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				const role = msg.role;
				if (role === "user") {
					const msgWithContent = msg as { content?: unknown };
					const content = this.#extractContent(msgWithContent.content);
					result = theme.fg("accent", compact ? "U: " : "user: ") + content;
				} else if (role === "developer") {
					const msgWithContent = msg as { content?: unknown };
					const content = this.#extractContent(msgWithContent.content);
					result = theme.fg("dim", compact ? "D: " : "developer: ") + theme.fg("muted", content);
				} else if (role === "assistant") {
					const presentation = resolveAssistantErrorPresentation(msg);
					if (presentation.kind === "compact-recovered") {
						result =
							theme.fg("success", compact ? "A: " : "assistant: ") +
							theme.fg("dim", normalize(presentation.text));
						break;
					}
					const msgWithContent = msg as { content?: unknown; stopReason?: string; errorMessage?: string };
					const textContent = this.#extractContent(msgWithContent.content);
					if (textContent) {
						result = theme.fg("success", compact ? "A: " : "assistant: ") + textContent;
					} else if (presentation.kind === "full") {
						result =
							theme.fg("success", compact ? "A: " : "assistant: ") +
							theme.fg("error", truncateCodePoints(normalize(presentation.text), 80));
					} else if (msgWithContent.stopReason === "aborted") {
						result = theme.fg("success", compact ? "A: " : "assistant: ") + theme.fg("muted", "(aborted)");
					} else {
						result = theme.fg("success", compact ? "A: " : "assistant: ") + theme.fg("muted", "(no content)");
					}
				} else if (role === "toolResult") {
					const toolMsg = msg as { toolCallId?: string; toolName?: string };
					let toolCall = toolMsg.toolCallId ? this.#toolCallMap.get(toolMsg.toolCallId) : undefined;
					if (toolCall && this.resolveEntry) {
						// Only visible tool rows need arguments; keep the map metadata-only.
						const source = this.resolveEntry(toolCall.entryId);
						if (source?.type === "message" && source.message.role === "assistant") {
							const block = source.message.content.find(
								block => block.type === "toolCall" && block.id === toolMsg.toolCallId,
							);
							if (block?.type === "toolCall")
								toolCall = { entryId: source.id, name: block.name, arguments: block.arguments };
						}
					}
					if (toolCall) {
						result = theme.fg("muted", this.#formatToolCall(toolCall.name, toolCall.arguments));
					} else {
						result = theme.fg("muted", `[${normalize(toolMsg.toolName ?? "tool")}]`);
					}
				} else if (role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					result = theme.fg("dim", `[bash]: ${normalize(bashMsg.command ?? "")}`);
				} else {
					result = theme.fg("dim", `[${normalize(role)}]`);
				}
				break;
			}
			case "custom_message": {
				if (entry.customType === "advisor") {
					const { qualifier, text } = advisorTreeDisplay(entry.details);
					const label = qualifier ? `advisor (${qualifier}): ` : "advisor: ";
					result = theme.fg("customMessageLabel", label) + normalize(text);
					break;
				}
				const content =
					typeof entry.content === "string"
						? entry.content
						: entry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map(c => c.text)
								.join("");
				result =
					theme.fg("customMessageLabel", `[${normalize(entry.customType)}]: `) +
					normalize(stripSystemWrapper(content));
				break;
			}
			case "compaction": {
				const tokens = Math.round(entry.tokensBefore / 1000);
				result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
				break;
			}
			case "branch_summary":
				result = theme.fg("warning", `[branch summary]: `) + normalize(entry.summary);
				break;
			case "model_change":
				result = theme.fg("dim", `[model: ${normalize(entry.model)}]`);
				break;
			case "thinking_level_change":
				result = theme.fg("dim", `[thinking: ${normalize(entry.thinkingLevel ?? ThinkingLevel.Off)}]`);
				break;
			case "custom":
				result = theme.fg("dim", `[custom: ${normalize(entry.customType)}]`);
				break;
			case "label":
				result = theme.fg("dim", `[label: ${entry.label === undefined ? "(cleared)" : normalize(entry.label)}]`);
				break;
			case "service_tier_change": {
				const tiers = entry.serviceTier
					? Object.entries(entry.serviceTier)
							.map(([family, tier]) => `${normalize(family)}:${normalize(String(tier))}`)
							.join(" ")
					: "(default)";
				result = theme.fg("dim", `[service tier: ${tiers}]`);
				break;
			}
			case "title_change":
				result = theme.fg("dim", `[title: ${normalize(entry.title)}]`);
				break;
			case "mode_change":
				result = theme.fg("dim", `[mode: ${normalize(entry.mode)}]`);
				break;
			case "credential_pin":
				result = theme.fg("dim", `[credential pin: ${normalize(entry.provider)}]`);
				break;
			default:
				result = theme.fg("dim", `[${normalize(entry.type.replaceAll("_", " "))}]`);
		}

		return isSelected ? theme.bold(result) : result;
	}

	#extractContent(content: unknown, preview = true): string {
		const maxLen = 200;
		if (typeof content === "string") {
			const text = sanitizeTreeText(content);
			return (preview ? truncateCodePoints(text, maxLen) : text).trim();
		}
		if (Array.isArray(content)) {
			let result = "";
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					// Sanitize before the cap so control-only prefixes cannot hide the
					// first visible code points from the rendered row.
					result += sanitizeTreeText((c as { text: string }).text);
					if (preview && codePointLength(result) >= maxLen) return truncateCodePoints(result, maxLen);
				}
			}
			return result.trim();
		}
		return "";
	}

	#hasTextContent(content: unknown): boolean {
		if (typeof content === "string") return Boolean(canonicalizeMessage(content));
		if (Array.isArray(content)) {
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					const text = (c as { text?: string }).text;
					if (text && canonicalizeMessage(text)) return true;
				}
			}
		}
		return false;
	}

	#formatToolCall(name: string, args: Record<string, unknown>): string {
		switch (name) {
			case "read": {
				const path = shortenPath(normalizeTreeText(String(args.path || args.file_path || "")));
				const offset = args.offset as number | undefined;
				const limit = args.limit as number | undefined;
				let display = path;
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit !== undefined ? start + limit - 1 : "";
					display += normalizeTreeText(`:${start}${end ? `-${end}` : ""}`);
				}
				return `[read: ${display}]`;
			}
			case "bash": {
				const rawCmd = String(args.command || "");
				const flatCmd = normalizeTreeText(rawCmd);
				const cmd = truncateCodePoints(flatCmd, 50);
				return `[bash: ${cmd}${codePointLength(flatCmd) > 50 ? "..." : ""}]`;
			}
			case "ls": {
				const path = shortenPath(normalizeTreeText(String(args.path || ".")));
				return `[ls: ${path}]`;
			}
			default: {
				const argsJson = JSON.stringify(sanitizeTreeValue(args));
				const normalizedArgs = argsJson;
				const argsStr = truncateCodePoints(normalizedArgs, 40);
				return `[${normalizeTreeText(name)}: ${argsStr}${codePointLength(normalizedArgs) > 40 ? "..." : ""}]`;
			}
		}
	}

	#moveToAdjacentTurn(direction: -1 | 1): void {
		let index = Math.min(this.#selectedIndex, this.#filteredNodes.length - 1) + direction;
		for (; index >= 0 && index < this.#filteredNodes.length; index += direction) {
			const entry = this.#filteredNodes[index]?.node.entry;
			if (entry?.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
				this.#selectedIndex = index;
				return;
			}
		}
	}

	#focusAgent(agent: TreeAgentEntry): void {
		this.#lastSelectedAgentId = agent.id;
		if (this.onFocusAgent) this.onFocusAgent(agent.id);
	}

	handleInput(keyData: string): void {
		this.#searchRejection = undefined;
		if (matchesSelectUp(keyData)) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#selectableCount - 1 : this.#selectedIndex - 1;
		} else if (matchesSelectDown(keyData)) {
			this.#selectedIndex = this.#selectedIndex === this.#selectableCount - 1 ? 0 : this.#selectedIndex + 1;
		} else if (matchesKey(keyData, "alt+up")) {
			this.#moveToAdjacentTurn(-1);
		} else if (matchesKey(keyData, "alt+down")) {
			this.#moveToAdjacentTurn(1);
		} else if (matchesKey(keyData, "home")) {
			this.#selectedIndex = 0;
		} else if (matchesKey(keyData, "end")) {
			this.#selectedIndex = Math.max(0, this.#selectableCount - 1);
		} else if (matchesSelectPageUp(keyData) || matchesKey(keyData, "left")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.maxVisibleLines);
		} else if (matchesSelectPageDown(keyData) || matchesKey(keyData, "right")) {
			this.#selectedIndex = Math.min(this.#selectableCount - 1, this.#selectedIndex + this.maxVisibleLines);
		} else if (
			matchesKey(keyData, "shift+enter") ||
			matchesKey(keyData, "shift+return") ||
			keyData === "\n" ||
			keyData === "\x1b[13;2~"
		) {
			const agent = this.#selectedAgent();
			if (agent) {
				this.#focusAgent(agent);
			} else {
				const selected = this.#filteredNodes[this.#selectedIndex];
				if (selected && this.onSelect) {
					this.onSelect(selected.node.entry.id, { summarize: true });
				}
			}
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
			const agent = this.#selectedAgent();
			if (agent) {
				this.#focusAgent(agent);
			} else {
				const selected = this.#filteredNodes[this.#selectedIndex];
				if (selected && this.onSelect) {
					this.onSelect(selected.node.entry.id, { summarize: false });
				}
			}
		} else if (matchesAppInterrupt(keyData)) {
			if (this.#searchQuery) {
				this.#searchQuery = "";
				this.#applyFilter();
			} else {
				this.onCancel?.();
			}
		} else if (matchesKey(keyData, "ctrl+c")) {
			this.onCancel?.();
		} else if (matchesKey(keyData, "shift+ctrl+o") || matchesKey(keyData, "ctrl+shift+o")) {
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.#filterMode);
			this.#filterMode = modes[(currentIndex - 1 + modes.length) % modes.length];
			this.#applyFilter();
		} else if (matchesKey(keyData, "ctrl+o")) {
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.#filterMode);
			this.#filterMode = modes[(currentIndex + 1) % modes.length];
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+d")) {
			this.#filterMode = "default";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+t")) {
			this.#filterMode = "no-tools";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+u")) {
			this.#filterMode = "user-only";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+l")) {
			this.#filterMode = "labeled-only";
			this.#applyFilter();
		} else if (matchesKey(keyData, "alt+a")) {
			this.#filterMode = "all";
			this.#applyFilter();
		} else if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = this.#searchQuery.slice(0, -1);
				this.#applyFilter();
			}
		} else if (matchesKey(keyData, "shift+l") && !this.#searchQuery && !this.#selectedAgent()) {
			const selected = this.#filteredNodes[this.#selectedIndex];
			if (selected && this.onLabelEdit) {
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
		} else {
			const printableText = extractPrintableText(keyData);
			if (printableText) {
				if (Buffer.byteLength(this.#searchQuery) + Buffer.byteLength(printableText) > EDITOR_LIMITS.draftBytes) {
					this.#searchRejection = `Search exceeds ${formatBytes(EDITOR_LIMITS.draftBytes)}; input was not inserted`;
					return;
				}
				this.#searchQuery += printableText;
				this.#applyFilter();
			}
		}
	}
}

class SearchLine implements Component {
	constructor(private treeList: TreeList) {}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const rejection = this.treeList.getSearchRejection();
		if (rejection) return [truncateToWidth(theme.fg("warning", rejection), width)];
		const query = this.treeList.getSearchQuery();
		const label = `Search${this.treeList.getFilterLabel()}:`;
		if (query) {
			return [truncateToWidth(`${theme.fg("muted", label)} ${theme.fg("accent", query)}`, width)];
		}
		return [truncateToWidth(theme.fg("muted", label), width)];
	}

	handleInput(_keyData: string): void {}
}

class LabelInput implements Component {
	#input: Input;
	#maxHeight = 3;
	onSubmit?: (entryId: string, label: string | undefined) => void;
	onCancel?: () => void;

	constructor(
		private readonly entryId: string,
		currentLabel: string | undefined,
	) {
		this.#input = new Input();
		if (currentLabel) {
			this.#input.setValue(normalizeTreeText(currentLabel));
		}
	}

	invalidate(): void {}

	setMaxHeight(rows: number): void {
		this.#maxHeight = Math.max(1, Math.trunc(rows));
	}

	render(width: number): readonly string[] {
		return renderDialogContent(
			[new TruncatedText(theme.fg("muted", "Label (empty to remove):"), 0, 0), this.#input],
			this.#input,
			width,
			this.#maxHeight,
		).lines;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const value = this.#input.getValue().trim();
			this.onSubmit?.(this.entryId, value || undefined);
		} else if (matchesAppInterrupt(keyData)) {
			this.onCancel?.();
		} else {
			this.#input.handleInput(keyData);
		}
	}
}

function truncateCodePoints(text: string, max: number): string {
	if (text.length <= max) return text;
	return Array.from(text).slice(0, max).join("");
}

function codePointLength(text: string): number {
	return Array.from(text).length;
}

export class TreeSelectorComponent extends OverlayPanel {
	#treeList: TreeList;
	#labelInput: LabelInput | null = null;
	#height: number;
	#searchLine: SearchLine;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string, options: { summarize: boolean }) => void,
		onCancel: () => void,
		private readonly onLabelChangeCallback?: (entryId: string, label: string | undefined) => void,
		initialFilterMode: FilterMode = "default",
		resolveEntry?: (entryId: string) => SessionEntry | undefined,
		agents: TreeAgentEntry[] = [],
		onFocusAgent?: (agentId: string) => void,
	) {
		super("Session Tree");

		this.#height = Math.max(1, terminalHeight);
		this.#treeList = new TreeList(
			tree,
			currentLeafId,
			this.#height,
			initialFilterMode,
			undefined,
			resolveEntry,
			agents,
		);
		this.#searchLine = new SearchLine(this.#treeList);
		this.#treeList.onSelect = onSelect;
		this.#treeList.onCancel = onCancel;
		this.#treeList.onLabelEdit = (entryId, currentLabel) => this.#showLabelInput(entryId, currentLabel);
		this.#treeList.onFocusAgent = onFocusAgent;

		if (tree.length === 0 && agents.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	#showLabelInput(entryId: string, currentLabel: string | undefined): void {
		this.#labelInput = new LabelInput(entryId, currentLabel);
		this.#labelInput.onSubmit = (id, label) => {
			this.#treeList.updateNodeLabel(id, label);
			this.onLabelChangeCallback?.(id, label);
			this.#hideLabelInput();
		};
		this.#labelInput.onCancel = () => this.#hideLabelInput();
	}

	#hideLabelInput(): void {
		this.#labelInput = null;
	}

	override setMaxHeight(rows: number): void {
		this.#height = Math.max(1, Math.trunc(rows));
	}

	override render(width: number): readonly string[] {
		const layout = getDialogViewport(this.#height, this.#labelInput ? 0 : 1);
		const innerWidth = Math.max(1, layout.titleRows ? width - 4 : width);
		const active = this.#labelInput ?? this.#treeList;
		// The real composer supplies the current slot height on every render/resize.
		// Give the active editor/list its budget before painting optional chrome.
		active.setMaxHeight(layout.bodyRows + layout.dividerRows);
		const search = this.#searchLine.render(innerWidth);
		const footer = this.#labelInput
			? innerWidth < 24
				? "↵ save Esc back"
				: "Enter:save Esc:cancel"
			: !layout.headerRows && (this.#treeList.getSearchQuery() || this.#treeList.getFilterLabel())
				? (search[0] ?? "")
				: innerWidth < 32
					? "↵ open Esc back"
					: "Enter:switch Esc:cancel ↑/↓:move L:label ^O:filter";
		return [
			...(layout.titleRows ? [topBorder(width, this.#labelInput ? "Edit label" : this.title)] : []),
			...(layout.headerRows ? search.map(line => row(line, width, layout.titleRows > 0)) : []),
			...active.render(innerWidth).map(line => row(line, width, layout.titleRows > 0)),
			...(layout.footerRows ? [row(footer, width, layout.titleRows > 0)] : []),
			...(layout.bottomRows ? [bottomBorder(width)] : []),
		];
	}

	handleInput(keyData: string): void {
		if (this.#labelInput) {
			this.#labelInput.handleInput(keyData);
		} else {
			this.#treeList.handleInput(keyData);
		}
	}

	override dispose(): void {
		this.#treeList.dispose();
		this.#labelInput = null;
		super.dispose();
	}

	getTreeList(): TreeList {
		return this.#treeList;
	}
}
