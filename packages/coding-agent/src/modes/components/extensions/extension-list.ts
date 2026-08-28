import { type Component, matchesKey, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { isProviderEnabled } from "../../../discovery";
import { theme } from "../../../modes/theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../../utils/keybinding-matchers";
import { clampSelection, contentRowWidth, renderScrollableList, searchableChar } from "../selector-helpers";
import { applyFilter } from "./state-manager";
import type { Extension, ExtensionKind, ExtensionState } from "./types";

interface ExtensionListCallbacks {
	onSelectionChange?: (extension: Extension | null) => void;

	onToggle?: (extensionId: string, enabled: boolean) => void;

	onMasterToggle?: (providerId: string) => void;

	masterSwitchProvider?: string | null;
}

const DEFAULT_MAX_VISIBLE = 15;

type ListItem =
	| { type: "master"; providerId: string; providerName: string; enabled: boolean }
	| { type: "kind-header"; kind: ExtensionKind; label: string; icon: string; count: number }
	| { type: "extension"; item: Extension };

export class ExtensionList implements Component {
	#listItems: ListItem[] = [];
	#selectedIndex = 0;
	#scrollOffset = 0;
	#searchQuery = "";
	#focused = false;
	#masterSwitchProvider: string | null = null;
	#maxVisible: number;
	#hoveredIndex: number | null = null;

	#visibleCount = 0;

	constructor(
		private extensions: Extension[],
		private readonly callbacks: ExtensionListCallbacks = {},
		maxVisible?: number,
	) {
		this.#masterSwitchProvider = callbacks.masterSwitchProvider ?? null;
		this.#maxVisible = maxVisible ?? DEFAULT_MAX_VISIBLE;
		this.#rebuildList();
	}

	setMaxVisible(maxVisible: number): void {
		this.#maxVisible = maxVisible;
		this.#clampSelection();
	}

	setExtensions(extensions: Extension[]): void {
		this.extensions = extensions;
		this.#rebuildList();
		this.#clampSelection();
	}

	setFocused(focused: boolean): void {
		this.#focused = focused;
	}

	setMasterSwitchProvider(providerId: string | null): void {
		this.#masterSwitchProvider = providerId;
		this.#rebuildList();
	}

	getSearchQuery(): string {
		return this.#searchQuery;
	}

	resetSelection(): void {
		this.#selectedIndex = 0;
		this.#scrollOffset = 0;
		this.#notifySelectionChange();
	}

	getSelectedExtension(): Extension | null {
		const item = this.#listItems[this.#selectedIndex];
		return item?.type === "extension" ? item.item : null;
	}

	getSelectedKind(): ExtensionKind | null {
		const item = this.#listItems[this.#selectedIndex];
		return item?.type === "kind-header" ? item.kind : null;
	}

	setSearchQuery(query: string): void {
		this.#searchQuery = query;
		this.#rebuildList();
		this.#selectedIndex = 0;
		this.#scrollOffset = 0;
		this.#notifySelectionChange();
	}

	clearSearch(): void {
		this.setSearchQuery("");
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#visibleCount = 0;

		const searchPrefix = theme.fg("muted", "Search: ");
		const searchText = this.#searchQuery || (this.#focused ? "" : theme.fg("dim", "type to filter"));
		const cursor = this.#focused ? theme.fg("accent", "_") : "";
		lines.push(searchPrefix + searchText + cursor);
		lines.push("");

		if (this.#listItems.length === 0) {
			lines.push(theme.fg("muted", "  No extensions found for this provider."));
			return lines;
		}

		const masterDisabled = this.#masterSwitchProvider !== null && !isProviderEnabled(this.#masterSwitchProvider);

		const startIdx = this.#scrollOffset;
		const endIdx = Math.min(startIdx + this.#maxVisible, this.#listItems.length);

		const rowWidth = contentRowWidth(width, this.#listItems.length, this.#maxVisible);

		const rows: string[] = [];
		for (let i = startIdx; i < endIdx; i++) {
			const listItem = this.#listItems[i];
			const isSelected = this.#focused && i === this.#selectedIndex;
			const isHovered = this.#focused && i === this.#hoveredIndex && !isSelected;

			let rowStr: string;
			if (listItem.type === "master") {
				rowStr = this.#renderMasterSwitch(listItem, isSelected, rowWidth);
			} else if (listItem.type === "kind-header") {
				rowStr = this.#renderKindHeader(listItem, isSelected, rowWidth);
			} else {
				rowStr = this.#renderExtensionRow(listItem.item, isSelected, rowWidth, masterDisabled);
			}
			if (isHovered) rowStr = theme.bg("selectedBg", rowStr);
			rows.push(rowStr);
		}
		this.#visibleCount = rows.length;

		lines.push(
			...renderScrollableList(rows, {
				width,
				totalRows: this.#listItems.length,
				scrollOffset: this.#scrollOffset,
			}),
		);

		return lines;
	}

	#renderMasterSwitch(item: ListItem & { type: "master" }, isSelected: boolean, width: number): string {
		const checkbox = item.enabled
			? theme.fg("success", theme.checkbox.checked)
			: theme.fg("dim", theme.checkbox.unchecked);
		const icon = theme.icon.package;
		const label = `Enable ${item.providerName}`;
		const badge = theme.fg("warning", "(Master Switch)");

		let line = `${checkbox} ${icon} ${label}  ${badge}`;

		if (isSelected) {
			line = theme.bold(theme.fg("accent", line));
			line = theme.bg("selectedBg", line);
		} else if (!item.enabled) {
			line = theme.fg("dim", line);
		}

		return truncateToWidth(line, width);
	}

	#renderKindHeader(item: ListItem & { type: "kind-header" }, isSelected: boolean, width: number): string {
		const countBadge = theme.fg("muted", `(${item.count})`);
		let line = `${item.icon} ${item.label} ${countBadge}`;

		if (isSelected) {
			line = theme.bold(theme.fg("accent", line));
			line = theme.bg("selectedBg", line);
		} else {
			line = theme.fg("muted", line);
		}

		return truncateToWidth(line, width);
	}

	#renderExtensionRow(ext: Extension, isSelected: boolean, width: number, masterDisabled: boolean): string {
		const effectivelyDisabled = masterDisabled || ext.state === "disabled";

		const stateIcon = this.#getStateIcon(ext.state, masterDisabled);

		let name = ext.displayName;
		const nameWidth = Math.min(24, width - 16);

		let line = `   ${stateIcon} `;

		if (isSelected && !masterDisabled) {
			name = theme.bold(theme.fg("accent", name));
		} else if (effectivelyDisabled) {
			name = theme.fg("dim", name);
		} else if (ext.state === "shadowed") {
			name = theme.fg("warning", name);
		}

		const namePadded = this.#padText(name, nameWidth);
		line += namePadded;

		if (ext.trigger) {
			const triggerStyle = effectivelyDisabled ? "dim" : "muted";
			const remainingWidth = width - visibleWidth(line) - 2;
			if (remainingWidth > 5) {
				line += `  ${truncateToWidth(theme.fg(triggerStyle as "dim" | "muted", ext.trigger), remainingWidth)}`;
			}
		}

		if (isSelected) {
			line = theme.bg("selectedBg", line);
		}

		return truncateToWidth(line, width);
	}

	#getKindIcon(kind: ExtensionKind): string {
		switch (kind) {
			case "extension-module":
				return theme.icon.extensionTool;
			case "skill":
				return theme.icon.extensionSkill;
			case "tool":
				return theme.icon.extensionTool;
			case "slash-command":
				return theme.icon.extensionSlashCommand;
			case "mcp":
				return theme.icon.extensionMcp;
			case "rule":
				return theme.icon.extensionRule;
			case "hook":
				return theme.icon.extensionHook;
			case "prompt":
				return theme.icon.extensionPrompt;
			case "context-file":
				return theme.icon.extensionContextFile;
			case "instruction":
				return theme.icon.extensionInstruction;
			default:
				return theme.format.bullet;
		}
	}

	#getStateIcon(state: ExtensionState, masterDisabled: boolean): string {
		if (masterDisabled) {
			return theme.fg("dim", theme.status.disabled);
		}
		switch (state) {
			case "active":
				return theme.fg("success", theme.status.enabled);
			case "disabled":
				return theme.fg("dim", theme.status.disabled);
			case "shadowed":
				return theme.fg("warning", theme.status.shadowed);
		}
	}

	#padText(text: string, targetWidth: number): string {
		const width = visibleWidth(text);
		if (width >= targetWidth) {
			return truncateToWidth(text, targetWidth);
		}
		return text + padding(targetWidth - width);
	}

	#rebuildList(): void {
		this.#listItems = [];

		const filtered = this.#searchQuery.length > 0 ? applyFilter(this.extensions, this.#searchQuery) : this.extensions;

		if (this.#searchQuery.length > 0) {
			for (const ext of filtered) {
				this.#listItems.push({ type: "extension", item: ext });
			}
			return;
		}

		if (this.#masterSwitchProvider) {
			const providerName = filtered[0]?.source.providerName ?? this.#masterSwitchProvider;
			const enabled = isProviderEnabled(this.#masterSwitchProvider);

			this.#listItems.push({
				type: "master",
				providerId: this.#masterSwitchProvider,
				providerName,
				enabled,
			});

			for (const ext of filtered) {
				this.#listItems.push({ type: "extension", item: ext });
			}
			return;
		}

		const byKind = new Map<ExtensionKind, Extension[]>();
		for (const ext of filtered) {
			const list = byKind.get(ext.kind) ?? [];
			list.push(ext);
			byKind.set(ext.kind, list);
		}

		const kindOrder: ExtensionKind[] = [
			"extension-module",
			"skill",
			"tool",
			"slash-command",
			"rule",
			"mcp",
			"hook",
			"prompt",
			"context-file",
			"instruction",
		];

		for (const kind of kindOrder) {
			const items = byKind.get(kind);
			if (!items || items.length === 0) continue;

			this.#listItems.push({
				type: "kind-header",
				kind,
				label: this.#getKindLabel(kind),
				icon: this.#getKindIcon(kind),
				count: items.length,
			});

			for (const ext of items) {
				this.#listItems.push({ type: "extension", item: ext });
			}
		}
	}

	#getKindLabel(kind: ExtensionKind): string {
		switch (kind) {
			case "extension-module":
				return "Extension Modules";
			case "skill":
				return "Skills";
			case "tool":
				return "Tools";
			case "slash-command":
				return "Commands";
			case "rule":
				return "Rules";
			case "mcp":
				return "MCP Servers";
			case "hook":
				return "Hooks";
			case "prompt":
				return "Prompts";
			case "context-file":
				return "Context";
			case "instruction":
				return "Instructions";
			default:
				return kind;
		}
	}

	#clampSelection(): void {
		const next = clampSelection(this.#selectedIndex, this.#scrollOffset, this.#listItems.length, this.#maxVisible);
		this.#selectedIndex = next.selectedIndex;
		this.#scrollOffset = next.scrollOffset;
	}

	#activateSelected(): void {
		const item = this.#listItems[this.#selectedIndex];
		if (item?.type === "master") {
			this.callbacks.onMasterToggle?.(item.providerId);
		} else if (item?.type === "extension") {
			const masterDisabled = this.#masterSwitchProvider !== null && !isProviderEnabled(this.#masterSwitchProvider);
			if (!masterDisabled) {
				const newEnabled = item.item.state === "disabled";
				this.callbacks.onToggle?.(item.item.id, newEnabled);
			}
		}
	}

	setHoverIndex(index: number | null): void {
		this.#hoveredIndex = index;
	}

	hitTest(line: number): number | null {
		const rowLine = line - 2;
		if (rowLine < 0 || rowLine >= this.#visibleCount) return null;
		const index = this.#scrollOffset + rowLine;
		return index < this.#listItems.length ? index : null;
	}

	handleWheel(delta: -1 | 1): void {
		if (delta < 0) this.#moveSelectionUp();
		else this.#moveSelectionDown();
	}

	handleClick(line: number): void {
		const index = this.hitTest(line);
		if (index === null) return;
		if (index === this.#selectedIndex) {
			this.#activateSelected();
			return;
		}
		this.#selectedIndex = index;
		this.#notifySelectionChange();
	}

	handleInput(data: string): void {
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			this.#moveSelectionUp();
			return;
		}

		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			this.#moveSelectionDown();
			return;
		}

		if (data === " " || matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateSelected();
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.#searchQuery.length > 0) {
				this.setSearchQuery(this.#searchQuery.slice(0, -1));
			}
			return;
		}

		const char = searchableChar(data);
		if (char !== null) {
			this.setSearchQuery(this.#searchQuery + char);
		}
	}

	#moveSelectionUp(): void {
		if (this.#selectedIndex > 0) {
			this.#selectedIndex--;
			if (this.#selectedIndex < this.#scrollOffset) {
				this.#scrollOffset = this.#selectedIndex;
			}
			this.#notifySelectionChange();
		}
	}

	#moveSelectionDown(): void {
		if (this.#selectedIndex < this.#listItems.length - 1) {
			this.#selectedIndex++;
			if (this.#selectedIndex >= this.#scrollOffset + this.#maxVisible) {
				this.#scrollOffset = this.#selectedIndex - this.#maxVisible + 1;
			}
			this.#notifySelectionChange();
		}
	}

	#notifySelectionChange(): void {
		const ext = this.getSelectedExtension();
		this.callbacks.onSelectionChange?.(ext);
	}
}
