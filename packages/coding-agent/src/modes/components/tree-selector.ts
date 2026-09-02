import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	Container,
	extractPrintableText,
	fuzzyMatch,
	Input,
	matchesKey,
	Spacer,
	TruncatedText,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type { TreeFilterMode } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../../modes/utils/keybinding-matchers";
import type { SessionTreeNode } from "../../session/session-entries";
import { shortenPath } from "../../tools/render-utils";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { resolveAssistantErrorPresentation } from "../utils/transcript-render-helpers";
import { OverlayPanel, PanelDivider } from "./overlay-box";
import { centeredWindow, contentRowWidth, renderScrollableList } from "./selector-helpers";

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
	name: string;
	arguments: Record<string, unknown>;
}

class TreeList implements Component {
	#flatNodes: FlatNode[] = [];
	#filteredNodes: FlatNode[] = [];
	#selectedIndex = 0;
	#filterMode: FilterMode;
	#searchQuery = "";
	#toolCallMap: Map<string, ToolCallInfo> = new Map();
	#multipleRoots = false;
	#activePathIds: Set<string> = new Set();
	#lastSelectedId: string | null = null;

	onSelect?: (entryId: string, options: { summarize: boolean }) => void;
	onCancel?: () => void;
	onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	constructor(
		tree: SessionTreeNode[],
		private readonly currentLeafId: string | null,
		private readonly maxVisibleLines: number,
		initialFilterMode: FilterMode = "default",
		initialSelectedId?: string,
	) {
		this.#filterMode = initialFilterMode;
		this.#multipleRoots = tree.length > 1;
		this.#flatNodes = this.#flattenTree(tree);
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
							this.#toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
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

		if (this.#lastSelectedId) {
			this.#selectedIndex = this.#findNearestVisibleIndex(this.#lastSelectedId);
		} else if (this.#selectedIndex >= this.#filteredNodes.length) {
			this.#selectedIndex = Math.max(0, this.#filteredNodes.length - 1);
		}

		if (this.#filteredNodes.length > 0) {
			this.#lastSelectedId = this.#filteredNodes[this.#selectedIndex]?.node.entry.id ?? this.#lastSelectedId;
		}
	}

	#getSearchableText(node: SessionTreeNode): string {
		const entry = node.entry;
		const parts: string[] = [];

		if (node.label) {
			parts.push(node.label);
		}

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				parts.push(msg.role);
				if ("content" in msg && msg.content) {
					parts.push(this.#extractContent(msg.content));
				}
				if (msg.role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					if (bashMsg.command) parts.push(bashMsg.command);
				}
				break;
			}
			case "custom_message": {
				parts.push(entry.customType);
				if (typeof entry.content === "string") {
					parts.push(entry.content);
				} else {
					parts.push(this.#extractContent(entry.content));
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

	invalidate(): void {}

	getSearchQuery(): string {
		return this.#searchQuery;
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

	#getFilterLabel(): string {
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

		if (this.#filteredNodes.length === 0) {
			if (this.#flatNodes.length === 0) {
				lines.push(truncateToWidth(theme.fg("muted", "No entries found"), width));
				lines.push(truncateToWidth(theme.fg("muted", `(0/0)${this.#getFilterLabel()}`), width));
			} else if (this.#searchQuery.length > 0) {
				lines.push(truncateToWidth(theme.fg("muted", `No entries match search "${this.#searchQuery}"`), width));
				lines.push(truncateToWidth(theme.fg("muted", "Press Backspace to clear the search"), width));
				lines.push(
					truncateToWidth(theme.fg("muted", `(0/${this.#flatNodes.length})${this.#getFilterLabel()}`), width),
				);
			} else {
				const filterLabel = this.#getFilterLabel().trim() || "[default]";
				lines.push(
					truncateToWidth(
						theme.fg("muted", `${this.#flatNodes.length} entries hidden by the current filter ${filterLabel}`),
						width,
					),
				);
				lines.push(truncateToWidth(theme.fg("muted", "Press Alt+A to show all, Alt+D for default"), width));
				lines.push(
					truncateToWidth(theme.fg("muted", `(0/${this.#flatNodes.length})${this.#getFilterLabel()}`), width),
				);
			}
			return lines;
		}

		const { startIndex, endIndex } = centeredWindow(
			this.#selectedIndex,
			this.#filteredNodes.length,
			this.maxVisibleLines,
		);

		const MIN_CONTENT_COLS = 24;
		const OVERHEAD_COLS = 4;
		const contentReserve = Math.max(MIN_CONTENT_COLS, Math.floor(width / 2));
		const maxIndentLevels = Math.max(1, Math.floor((width - contentReserve - OVERHEAD_COLS) / 3));

		const rowWidth = contentRowWidth(width, this.#filteredNodes.length, this.maxVisibleLines);
		const rows: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = this.#filteredNodes[i];
			const entry = flatNode.node.entry;
			const isSelected = i === this.#selectedIndex;

			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			const displayIndent = this.#multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;

			const hasConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			const connectorSymbol = hasConnector ? (flatNode.isLast ? theme.tree.last : theme.tree.branch) : "";
			const connectorChars = hasConnector ? Array.from(connectorSymbol) : [];
			const renderedIndent = Math.min(displayIndent, maxIndentLevels);
			const scrollOffset = displayIndent - renderedIndent;
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
			const pathMarker = isOnActivePath ? theme.fg("accent", `${theme.md.bullet} `) : "";

			const label = flatNode.node.label ? theme.fg("warning", `[${flatNode.node.label}] `) : "";
			const content = this.#getEntryDisplayText(flatNode.node, isSelected);

			let line = cursor + theme.fg("dim", prefix) + pathMarker + label + content;
			if (isSelected) {
				line = theme.bg("selectedBg", line);
			}
			rows.push(truncateToWidth(line, rowWidth));
		}

		lines.push(
			...renderScrollableList(rows, {
				width,
				totalRows: this.#filteredNodes.length,
				scrollOffset: startIndex,
			}),
		);

		const filterLabel = this.#getFilterLabel();
		if (filterLabel) {
			lines.push(truncateToWidth(theme.fg("muted", filterLabel.trim()), width));
		}

		return lines;
	}

	#getEntryDisplayText(node: SessionTreeNode, isSelected: boolean): string {
		const entry = node.entry;
		let result: string;

		const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				const role = msg.role;
				if (role === "user") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.#extractContent(msgWithContent.content));
					result = theme.fg("accent", "user: ") + content;
				} else if (role === "developer") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.#extractContent(msgWithContent.content));
					result = theme.fg("dim", "developer: ") + theme.fg("muted", content);
				} else if (role === "assistant") {
					const presentation = resolveAssistantErrorPresentation(msg);
					if (presentation.kind === "compact-recovered") {
						result = theme.fg("success", "assistant: ") + theme.fg("dim", presentation.text);
						break;
					}
					const msgWithContent = msg as { content?: unknown; stopReason?: string; errorMessage?: string };
					const textContent = normalize(this.#extractContent(msgWithContent.content));
					if (textContent) {
						result = theme.fg("success", "assistant: ") + textContent;
					} else if (presentation.kind === "full") {
						result =
							theme.fg("success", "assistant: ") + theme.fg("error", normalize(presentation.text).slice(0, 80));
					} else if (msgWithContent.stopReason === "aborted") {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
					} else {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
					}
				} else if (role === "toolResult") {
					const toolMsg = msg as { toolCallId?: string; toolName?: string };
					const toolCall = toolMsg.toolCallId ? this.#toolCallMap.get(toolMsg.toolCallId) : undefined;
					if (toolCall) {
						result = theme.fg("muted", this.#formatToolCall(toolCall.name, toolCall.arguments));
					} else {
						result = theme.fg("muted", `[${toolMsg.toolName ?? "tool"}]`);
					}
				} else if (role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					result = theme.fg("dim", `[bash]: ${normalize(bashMsg.command ?? "")}`);
				} else {
					result = theme.fg("dim", `[${role}]`);
				}
				break;
			}
			case "custom_message": {
				const content =
					typeof entry.content === "string"
						? entry.content
						: entry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map(c => c.text)
								.join("");
				result = theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(content);
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
				result = theme.fg("dim", `[model: ${entry.model}]`);
				break;
			case "thinking_level_change":
				result = theme.fg("dim", `[thinking: ${entry.thinkingLevel ?? ThinkingLevel.Off}]`);
				break;
			case "custom":
				result = theme.fg("dim", `[custom: ${entry.customType}]`);
				break;
			case "label":
				result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
				break;
			case "service_tier_change": {
				const tiers = entry.serviceTier
					? Object.entries(entry.serviceTier)
							.map(([family, tier]) => `${family}:${tier}`)
							.join(" ")
					: "(default)";
				result = theme.fg("dim", `[service tier: ${tiers}]`);
				break;
			}
			case "title_change":
				result = theme.fg("dim", `[title: ${normalize(entry.title)}]`);
				break;
			case "mode_change":
				result = theme.fg("dim", `[mode: ${entry.mode}]`);
				break;
			case "credential_pin":
				result = theme.fg("dim", `[credential pin: ${entry.provider}]`);
				break;
			default:
				result = theme.fg("dim", `[${entry.type.replaceAll("_", " ")}]`);
		}

		return isSelected ? theme.bold(result) : result;
	}

	#extractContent(content: unknown): string {
		const maxLen = 200;
		if (typeof content === "string") return content.slice(0, maxLen);
		if (Array.isArray(content)) {
			let result = "";
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					result += (c as { text: string }).text;
					if (result.length >= maxLen) return result.slice(0, maxLen);
				}
			}
			return result;
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
				const path = shortenPath(String(args.path || args.file_path || ""));
				const offset = args.offset as number | undefined;
				const limit = args.limit as number | undefined;
				let display = path;
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit !== undefined ? start + limit - 1 : "";
					display += `:${start}${end ? `-${end}` : ""}`;
				}
				return `[read: ${display}]`;
			}
			case "bash": {
				const rawCmd = String(args.command || "");
				const cmd = rawCmd
					.replace(/[\n\t]/g, " ")
					.trim()
					.slice(0, 50);
				return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
			}
			case "ls": {
				const path = shortenPath(String(args.path || "."));
				return `[ls: ${path}]`;
			}
			default: {
				const argsStr = JSON.stringify(args).slice(0, 40);
				return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
			}
		}
	}

	#moveToAdjacentTurn(direction: -1 | 1): void {
		for (
			let index = this.#selectedIndex + direction;
			index >= 0 && index < this.#filteredNodes.length;
			index += direction
		) {
			const entry = this.#filteredNodes[index]?.node.entry;
			if (entry?.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
				this.#selectedIndex = index;
				return;
			}
		}
	}

	handleInput(keyData: string): void {
		if (matchesSelectUp(keyData)) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredNodes.length - 1 : this.#selectedIndex - 1;
		} else if (matchesSelectDown(keyData)) {
			this.#selectedIndex = this.#selectedIndex === this.#filteredNodes.length - 1 ? 0 : this.#selectedIndex + 1;
		} else if (matchesKey(keyData, "alt+up")) {
			this.#moveToAdjacentTurn(-1);
		} else if (matchesKey(keyData, "alt+down")) {
			this.#moveToAdjacentTurn(1);
		} else if (matchesKey(keyData, "home")) {
			this.#selectedIndex = 0;
		} else if (matchesKey(keyData, "end")) {
			this.#selectedIndex = Math.max(0, this.#filteredNodes.length - 1);
		} else if (matchesSelectPageUp(keyData) || matchesKey(keyData, "left")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.maxVisibleLines);
		} else if (matchesSelectPageDown(keyData) || matchesKey(keyData, "right")) {
			this.#selectedIndex = Math.min(this.#filteredNodes.length - 1, this.#selectedIndex + this.maxVisibleLines);
		} else if (
			matchesKey(keyData, "shift+enter") ||
			matchesKey(keyData, "shift+return") ||
			keyData === "\n" ||
			keyData === "\x1b[13;2~"
		) {
			const selected = this.#filteredNodes[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id, { summarize: true });
			}
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
			const selected = this.#filteredNodes[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id, { summarize: false });
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
		} else if (matchesKey(keyData, "shift+l") && !this.#searchQuery) {
			const selected = this.#filteredNodes[this.#selectedIndex];
			if (selected && this.onLabelEdit) {
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
		} else {
			const printableText = extractPrintableText(keyData);
			if (printableText) {
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
		const query = this.treeList.getSearchQuery();
		if (query) {
			return [truncateToWidth(`${theme.fg("muted", "Search:")} ${theme.fg("accent", query)}`, width)];
		}
		return [truncateToWidth(theme.fg("muted", "Search:"), width)];
	}

	handleInput(_keyData: string): void {}
}

class LabelInput implements Component {
	#input: Input;
	onSubmit?: (entryId: string, label: string | undefined) => void;
	onCancel?: () => void;

	constructor(
		private readonly entryId: string,
		currentLabel: string | undefined,
	) {
		this.#input = new Input();
		if (currentLabel) {
			this.#input.setValue(currentLabel);
		}
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		lines.push(truncateToWidth(theme.fg("muted", "Label (empty to remove):"), width));
		lines.push(...this.#input.render(width));
		lines.push(truncateToWidth(theme.fg("dim", "enter: save  esc: cancel"), width));
		return lines;
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

export class TreeSelectorComponent extends OverlayPanel {
	#treeList: TreeList;
	#labelInput: LabelInput | null = null;
	#labelInputContainer: Container;
	#treeContainer: Container;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string, options: { summarize: boolean }) => void,
		onCancel: () => void,
		private readonly onLabelChangeCallback?: (entryId: string, label: string | undefined) => void,
		initialFilterMode: FilterMode = "default",
	) {
		super("Session Tree");

		const PANEL_CHROME_ROWS = 8;
		const maxVisibleLines = Math.max(
			1,
			Math.min(Math.max(5, Math.floor(terminalHeight / 2)), terminalHeight - PANEL_CHROME_ROWS),
		);

		this.#treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialFilterMode);
		this.#treeList.onSelect = onSelect;
		this.#treeList.onCancel = onCancel;
		this.#treeList.onLabelEdit = (entryId, currentLabel) => this.#showLabelInput(entryId, currentLabel);

		this.#treeContainer = new Container();
		this.#treeContainer.addChild(this.#treeList);

		this.#labelInputContainer = new Container();

		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					"Enter: switch. Alt+↑/↓: previous/next turn. PgUp/PgDn (←/→): page. Home/End: first/last item. Shift+Enter: summarize & switch. Shift+L: label. Ctrl+O: filter. Alt+D/T/U/L/A: filter. Type to search",
				),
				0,
				0,
			),
		);
		this.addChild(new SearchLine(this.#treeList));
		this.addChild(new PanelDivider());
		this.addChild(new Spacer(1));
		this.addChild(this.#treeContainer);
		this.addChild(this.#labelInputContainer);
		this.addChild(new Spacer(1));

		if (tree.length === 0) {
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

		this.#treeContainer.clear();
		this.#labelInputContainer.clear();
		this.#labelInputContainer.addChild(this.#labelInput);
	}

	#hideLabelInput(): void {
		this.#labelInput = null;
		this.#labelInputContainer.clear();
		this.#treeContainer.clear();
		this.#treeContainer.addChild(this.#treeList);
	}

	handleInput(keyData: string): void {
		if (this.#labelInput) {
			this.#labelInput.handleInput(keyData);
		} else {
			this.#treeList.handleInput(keyData);
		}
	}

	getTreeList(): TreeList {
		return this.#treeList;
	}
}
