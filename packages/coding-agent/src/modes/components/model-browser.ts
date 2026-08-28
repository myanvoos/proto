import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import {
	type Component,
	fuzzyRank,
	Input,
	matchesKey,
	ScrollView,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import { getKnownRoleIds, getRoleInfo, MODEL_ROLE_IDS } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import type { ModelPerfStats } from "../../session/agent-storage";
import { parseThinkingLevel } from "../../thinking";
import { type ThemeColor, theme } from "../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";

export interface ModelBrowserItem {
	provider: string;
	id: string;
	model: Model;
	selector: string;

	labelColor?: ThemeColor;
}

interface RoleAssignment {
	model: Model;
	thinkingLevel: ThinkingLevel;

	autoSelected: boolean;
}

export type RoleAssignments = Record<string, RoleAssignment | undefined>;

export function resolveRoleAssignments(
	settings: Settings,
	allModels: ReadonlyArray<Model>,
	autoCandidates: ReadonlyArray<Model>,
): RoleAssignments {
	const resolvedThinkingLevel = (
		role: string,
		resolved: { explicitThinkingLevel: boolean; thinkingLevel?: ThinkingLevel },
	): ThinkingLevel => {
		if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined) {
			return resolved.thinkingLevel;
		}
		if (role === "default") {
			return parseThinkingLevel(settings.get("defaultThinkingLevel")) ?? ThinkingLevel.Inherit;
		}
		return ThinkingLevel.Inherit;
	};

	const roles: RoleAssignments = {};
	const matchPreferences = getModelMatchPreferences(settings);
	const knownRoles = getKnownRoleIds(settings);
	const configuredRoles = new Set<string>();
	const catalog = [...allModels];

	for (const role of knownRoles) {
		const roleValue = settings.getModelRole(role);
		if (!roleValue) continue;
		configuredRoles.add(role);
		const resolved = resolveModelRoleValue(roleValue, catalog, { settings, matchPreferences });
		if (resolved.model) {
			roles[role] = {
				model: resolved.model,
				thinkingLevel: resolvedThinkingLevel(role, resolved),
				autoSelected: false,
			};
		}
	}

	if (autoCandidates.length > 0) {
		const candidates = [...autoCandidates];
		for (const role of knownRoles) {
			if (configuredRoles.has(role)) continue;
			const resolved = resolveModelRoleValue(`pi/${role}`, candidates, { settings, matchPreferences });
			if (!resolved.model) continue;
			roles[role] = {
				model: resolved.model,
				thinkingLevel: resolvedThinkingLevel(role, resolved),
				autoSelected: true,
			};
		}
	}

	return roles;
}

export function buildBrowserItems(models: ReadonlyArray<Model>): ModelBrowserItem[] {
	return models.map(model => ({
		provider: model.provider,
		id: model.id,
		model,
		selector: `${model.provider}/${model.id}`,
	}));
}

function extractVersionNumber(id: string): number {
	const dotMatch = id.match(/(?:^|[-_])(\d+\.\d+)/);
	if (dotMatch) return Number.parseFloat(dotMatch[1]);

	const dashMatch = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
	if (dashMatch) return Number.parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);

	const singleMatch = id.match(/(?:^|[-_])(\d+)/);
	if (singleMatch) return Number.parseFloat(singleMatch[1]);
	return 0;
}

function computeModelRank(model: Model, roles: RoleAssignments): number {
	let i = 0;
	while (i < MODEL_ROLE_IDS.length) {
		const assigned = roles[MODEL_ROLE_IDS[i]];
		if (assigned && modelsAreEqual(assigned.model, model)) {
			break;
		}
		i++;
	}
	return i;
}

interface SortModelItemsOptions {
	roles?: RoleAssignments;
	mruOrder?: ReadonlyArray<string>;

	skipRoleRank?: boolean;
}

export function sortModelItems(items: ModelBrowserItem[], options: SortModelItemsOptions = {}): void {
	const { roles = {}, mruOrder = [], skipRoleRank = false } = options;
	const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

	const dateRe = /-(\d{8})$/;
	const latestRe = /-latest$/;

	items.sort((a, b) => {
		if (!skipRoleRank) {
			const aRank = computeModelRank(a.model, roles);
			const bRank = computeModelRank(b.model, roles);
			if (aRank !== bRank) return aRank - bRank;
		}

		const aMru = mruIndex.get(a.selector) ?? Number.MAX_SAFE_INTEGER;
		const bMru = mruIndex.get(b.selector) ?? Number.MAX_SAFE_INTEGER;
		if (aMru !== bMru) return aMru - bMru;

		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;

		const aPri = a.model.priority ?? Number.MAX_SAFE_INTEGER;
		const bPri = b.model.priority ?? Number.MAX_SAFE_INTEGER;
		if (aPri !== bPri) return aPri - bPri;

		const aVer = extractVersionNumber(a.id);
		const bVer = extractVersionNumber(b.id);
		if (aVer !== bVer) return bVer - aVer;

		const aIsLatest = latestRe.test(a.id);
		const bIsLatest = latestRe.test(b.id);
		const aDate = a.id.match(dateRe)?.[1] ?? "";
		const bDate = b.id.match(dateRe)?.[1] ?? "";

		const aHasRecency = aIsLatest || aDate !== "";
		const bHasRecency = bIsLatest || bDate !== "";
		if (aHasRecency !== bHasRecency) return aHasRecency ? -1 : 1;

		if (!aHasRecency) return a.id.localeCompare(b.id);

		if (aIsLatest !== bIsLatest) return aIsLatest ? -1 : 1;

		if (aDate && bDate) return bDate.localeCompare(aDate);

		return aIsLatest ? -1 : bIsLatest ? 1 : a.id.localeCompare(b.id);
	});
}

export function thinkingLevelGlyph(level: ThinkingLevel): string {
	const glyphOf = (symbol: string) => symbol.split(" ")[0] ?? symbol;
	switch (level) {
		case ThinkingLevel.Off:
			return theme.status.disabled;
		case ThinkingLevel.Minimal:
			return glyphOf(theme.thinking.minimal);
		case ThinkingLevel.Low:
			return glyphOf(theme.thinking.low);
		case ThinkingLevel.Medium:
			return glyphOf(theme.thinking.medium);
		case ThinkingLevel.High:
			return glyphOf(theme.thinking.high);
		case ThinkingLevel.XHigh:
			return glyphOf(theme.thinking.xhigh);
		case ThinkingLevel.Max:
			return glyphOf(theme.thinking.max);
		case ThinkingLevel.Inherit:
			return "";
	}
}

function formatRoleChip(role: string, assignment: RoleAssignment, settings: Settings): string {
	const info = getRoleInfo(role, settings);
	const label = (info.tag ?? info.name ?? role).toLowerCase();
	const glyph = thinkingLevelGlyph(assignment.thinkingLevel);
	const suffix = glyph ? ` ${theme.fg("dim", glyph)}` : "";
	if (assignment.autoSelected) {
		return theme.fg("dim", `${theme.status.shadowed} ${label}`) + suffix;
	}
	return theme.fg(info.color ?? "muted", `${theme.status.enabled} ${label}`) + suffix;
}

function formatCostPair(model: Model): string {
	const cost = model.cost;
	if (!cost || (cost.input <= 0 && cost.output <= 0)) return "free";
	const fmt = (n: number): string => {
		if (n <= 0) return "0";
		const s = n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
		return s.replace(/\.?0+$/, "");
	};
	return `$${fmt(cost.input)}/${fmt(cost.output)}`;
}

function formatContext(model: Model): string {
	const ctx = model.contextWindow ?? 0;
	if (ctx <= 0) return "";
	return `${formatNumber(ctx).toLowerCase()} ${theme.icon.context.replace(/:$/, "")}`;
}

function formatTps(tps: number): string {
	const value = tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
	return `${value}t/s`;
}

function formatTtft(ms: number): string {
	const seconds = ms / 1000;
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

function padLeftVisible(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? " ".repeat(missing) + text : text;
}

interface ModelBrowserOptions {
	showProvider?: boolean;

	currentContextTokens?: number;

	markOverContext?: boolean;

	emptyText?: () => string | undefined;
}

const LIST_ROW_START = 2;

const DETAIL_ROWS = 3;

const PERF_TPS_MIN_WIDTH = 76;

const PERF_FULL_MIN_WIDTH = 96;

type PerfMode = "off" | "tps" | "full";

export class ModelBrowser implements Component {
	#settings: Settings;
	#searchInput = new Input();
	#baseItems: ModelBrowserItem[] = [];
	#visibleItems: ModelBrowserItem[] = [];
	#roles: RoleAssignments = {};
	#mruOrder: ReadonlyArray<string> = [];
	#perf: ReadonlyMap<string, ModelPerfStats> = new Map();
	#selectedIndex = 0;
	#hoveredIndex: number | null = null;
	#maxVisible = 10;
	#showProvider: boolean;
	#currentContextTokens: number;
	#markOverContext: boolean;
	#emptyText?: () => string | undefined;

	#preserveQueryOrder = false;

	#windowStart = 0;
	#windowCount = 0;

	#focused = true;

	#currentSelector: string | undefined;

	onActivate?: (item: ModelBrowserItem) => void;
	onSelectionChange?: (item: ModelBrowserItem | undefined) => void;
	onQueryChange?: (query: string) => void;

	onCancel?: () => void;

	constructor(settings: Settings, options: ModelBrowserOptions = {}) {
		this.#settings = settings;
		this.#showProvider = options.showProvider ?? true;
		const tokens = options.currentContextTokens ?? 0;
		this.#currentContextTokens = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
		this.#markOverContext = options.markOverContext ?? false;
		this.#emptyText = options.emptyText;
	}

	setCurrentSelector(selector: string | undefined): void {
		this.#currentSelector = selector;
	}

	setItems(items: ModelBrowserItem[]): void {
		const selectedKey = this.getSelected()?.selector;
		this.#baseItems = items;
		this.#applyQuery();
		if (selectedKey) {
			this.selectSelector(selectedKey);
		}
	}

	setRoles(roles: RoleAssignments): void {
		this.#roles = roles;
	}

	setMruOrder(order: ReadonlyArray<string>): void {
		this.#mruOrder = order;
	}

	setPerfStats(perf: ReadonlyMap<string, ModelPerfStats>): void {
		this.#perf = perf;
	}

	setMaxVisible(rows: number): void {
		this.#maxVisible = Math.max(1, rows);
	}

	setShowProvider(show: boolean): void {
		this.#showProvider = show;
	}

	setPreserveQueryOrder(preserve: boolean): void {
		this.#preserveQueryOrder = preserve;
	}

	setMarkOverContext(mark: boolean): void {
		this.#markOverContext = mark;
	}

	setFocused(focused: boolean): void {
		this.#focused = focused;
	}

	get renderedRows(): number {
		return LIST_ROW_START + this.#maxVisible + DETAIL_ROWS;
	}

	get query(): string {
		return this.#searchInput.getValue();
	}

	setQuery(query: string): void {
		this.#searchInput.setValue(query);
		this.#applyQuery();
	}

	getSelected(): ModelBrowserItem | undefined {
		return this.#visibleItems[this.#selectedIndex];
	}

	get visibleCount(): number {
		return this.#visibleItems.length;
	}

	selectSelector(selector: string): boolean {
		const index = this.#visibleItems.findIndex(item => item.selector === selector);
		if (index < 0) return false;
		this.#selectedIndex = this.#coerceSelectedIndex(index);
		this.#ensureSelectedVisible();
		return true;
	}

	#isDisabled(item: ModelBrowserItem): boolean {
		return item.id === "separator";
	}

	isOverContext(item: ModelBrowserItem): boolean {
		if (item.id === "separator") return false;
		if (!this.#markOverContext || this.#currentContextTokens <= 0) return false;
		const contextWindow = item.model.contextWindow ?? 0;
		return contextWindow > 0 && this.#currentContextTokens > contextWindow;
	}

	#coerceSelectedIndex(index: number): number {
		const maxIndex = this.#visibleItems.length - 1;
		if (maxIndex < 0) return 0;
		const clamped = Math.max(0, Math.min(index, maxIndex));
		const clampedItem = this.#visibleItems[clamped];
		if (clampedItem && !this.#isDisabled(clampedItem)) return clamped;
		for (let i = clamped + 1; i <= maxIndex; i++) {
			const item = this.#visibleItems[i];
			if (item && !this.#isDisabled(item)) return i;
		}
		for (let i = clamped - 1; i >= 0; i--) {
			const item = this.#visibleItems[i];
			if (item && !this.#isDisabled(item)) return i;
		}
		return clamped;
	}

	#clampWindowStart(start: number): number {
		return Math.max(0, Math.min(start, this.#visibleItems.length - this.#maxVisible));
	}

	#ensureSelectedVisible(): void {
		if (this.#selectedIndex < this.#windowStart) {
			this.#windowStart = this.#selectedIndex;
		} else if (this.#selectedIndex >= this.#windowStart + this.#maxVisible) {
			this.#windowStart = this.#selectedIndex - this.#maxVisible + 1;
		}
		this.#windowStart = this.#clampWindowStart(this.#windowStart);
	}

	moveSelection(delta: number, options: { wrap?: boolean } = {}): void {
		const count = this.#visibleItems.length;
		if (count === 0) return;
		if (options.wrap ?? true) {
			let index = this.#selectedIndex;
			for (let step = 0; step < count; step++) {
				index = (index + delta + count) % count;
				const item = this.#visibleItems[index];
				if (item && !this.#isDisabled(item)) {
					this.#setSelectedIndex(index);
					return;
				}
			}
			return;
		}
		const target = Math.max(0, Math.min(this.#selectedIndex + delta, count - 1));
		this.#setSelectedIndex(this.#coerceSelectedIndex(target));
	}

	#setSelectedIndex(index: number): void {
		if (index === this.#selectedIndex) return;
		this.#selectedIndex = index;
		this.#ensureSelectedVisible();
		this.onSelectionChange?.(this.getSelected());
	}

	#isRecentOrRole(item: ModelBrowserItem): boolean {
		if (this.#mruOrder.includes(item.selector)) return true;
		for (const role in this.#roles) {
			const r = this.#roles[role];
			if (r && modelsAreEqual(r.model, item.model)) return true;
		}
		return false;
	}
	#insertSeparator(items: ModelBrowserItem[]): ModelBrowserItem[] {
		const filtered = items.filter(item => item.id !== "separator");
		const firstNonRecentIndex = filtered.findIndex(item => !this.#isRecentOrRole(item));
		if (firstNonRecentIndex > 0 && firstNonRecentIndex < filtered.length) {
			const separatorItem: ModelBrowserItem = {
				id: "separator",
				provider: "",
				selector: "separator",
				model: buildModel({
					id: "separator",
					name: "separator",
					api: "ollama-chat",
					provider: "",
					baseUrl: "",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 0,
					maxTokens: 0,
				}),
			};
			return [...filtered.slice(0, firstNonRecentIndex), separatorItem, ...filtered.slice(firstNonRecentIndex)];
		}
		return filtered;
	}

	#applyQuery(): void {
		const query = this.#searchInput.getValue();
		let items: ModelBrowserItem[];
		if (query.trim()) {
			const ranked = fuzzyRank(this.#baseItems, query, ({ provider, id }) => `${provider}/${id}`);
			const matches = ranked.map(result => result.item);
			if (this.#preserveQueryOrder) {
				items = matches;
			} else {
				sortModelItems(matches, { roles: this.#roles, mruOrder: this.#mruOrder, skipRoleRank: true });
				const buckets = new Map<ModelBrowserItem, number>();
				for (const result of ranked) buckets.set(result.item, Math.round(result.score / 10));
				matches.sort((a, b) => (buckets.get(a) ?? 0) - (buckets.get(b) ?? 0));
				items = matches;
			}
		} else {
			items = this.#baseItems;
		}
		this.#visibleItems = this.#insertSeparator(items);
		this.#selectedIndex = this.#coerceSelectedIndex(Math.min(this.#selectedIndex, this.#visibleItems.length - 1));
		this.#ensureSelectedVisible();
		this.onSelectionChange?.(this.getSelected());
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) {
			this.handleCancel();
			return;
		}
		if (matchesSelectUp(data)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.moveSelection(1);
			return;
		}
		if (matchesSelectPageUp(data)) {
			this.moveSelection(-this.#maxVisible, { wrap: false });
			return;
		}
		if (matchesSelectPageDown(data)) {
			this.moveSelection(this.#maxVisible, { wrap: false });
			return;
		}
		if (matchesKey(data, "home")) {
			this.moveSelection(-this.#visibleItems.length, { wrap: false });
			return;
		}
		if (matchesKey(data, "end")) {
			this.moveSelection(this.#visibleItems.length, { wrap: false });
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const selected = this.getSelected();
			if (selected && !this.#isDisabled(selected)) {
				this.onActivate?.(selected);
			}
			return;
		}

		const before = this.#searchInput.getValue();
		this.#searchInput.handleInput(data);
		const after = this.#searchInput.getValue();
		if (after !== before) {
			this.#applyQuery();
			this.onQueryChange?.(after);
		}
	}

	handleCancel(): void {
		if (this.#searchInput.getValue().length > 0) {
			this.setQuery("");
			this.onQueryChange?.("");
			return;
		}
		this.onCancel?.();
	}

	routeMouse(event: SgrMouseEvent, line: number): void {
		if (event.wheel !== null) {
			this.#windowStart = this.#clampWindowStart(this.#windowStart + event.wheel);
			this.#hoveredIndex = this.#hoverIndexAt(line);
			return;
		}
		if (event.motion) {
			this.#hoveredIndex = this.#hoverIndexAt(line);
			return;
		}
		if (!event.leftClick) return;
		const index = this.#hoverIndexAt(line);
		const item = index !== null ? this.#visibleItems[index] : undefined;
		if (index === null || !item) return;

		if (index === this.#selectedIndex) {
			this.onActivate?.(item);
		} else {
			this.#setSelectedIndex(index);
		}
	}

	clearHover(): void {
		this.#hoveredIndex = null;
	}

	#hoverIndexAt(line: number): number | null {
		const listLine = line - LIST_ROW_START;
		if (listLine < 0 || listLine >= this.#windowCount) return null;
		const index = this.#windowStart + listLine;
		const item = this.#visibleItems[index];
		if (!item || this.#isDisabled(item)) return null;
		return index;
	}

	#perfCell(item: ModelBrowserItem, mode: PerfMode): string {
		if (mode === "off") return "";
		const perf = this.#perf.get(item.selector);
		if (!perf) return "";
		const tps = formatTps(perf.tps);
		if (mode === "full" && perf.ttftMs !== null) return `${formatTtft(perf.ttftMs)} ${tps}`;
		return tps;
	}

	#renderRow(
		item: ModelBrowserItem,
		width: number,
		selected: boolean,
		hovered: boolean,
		ctxWidth: number,
		costWidth: number,
		perfWidth: number,
		perfMode: PerfMode,
	): string {
		if (item.id === "separator") {
			const dashCount = Math.max(0, width - 4);
			const line = theme.fg("muted", "─".repeat(dashCount));
			return `  ${line}  `;
		}
		const overContext = this.isOverContext(item);
		const prefix = selected && this.#focused ? `${theme.fg("accent", theme.nav.cursor)} ` : "  ";
		const providerPrefix = this.#showProvider ? theme.fg("dim", `${item.provider}/`) : "";
		const name = item.labelColor
			? theme.fg(item.labelColor, item.id)
			: selected
				? theme.fg("accent", item.id)
				: item.id;
		const currentMark =
			item.selector === this.#currentSelector ? ` ${theme.fg("success", theme.status.enabled)}` : "";
		const overLimit = overContext
			? ` ${theme.status.disabled} context>${formatNumber(item.model.contextWindow ?? 0).toLowerCase()}`
			: "";
		let left = `${prefix}${providerPrefix}${name}${currentMark}${overLimit}`;

		const perfCol =
			perfWidth > 0 ? `${theme.fg("dim", padLeftVisible(this.#perfCell(item, perfMode), perfWidth))}  ` : "";
		const meta = `${perfCol}${theme.fg("dim", padLeftVisible(formatContext(item.model), ctxWidth))}  ${theme.fg("dim", padLeftVisible(formatCostPair(item.model), costWidth))}`;
		const metaWidth = ctxWidth + costWidth + 2 + (perfWidth > 0 ? perfWidth + 2 : 0);
		const available = Math.max(1, width - metaWidth - 1);
		left = truncateToWidth(left, available);
		const gap = Math.max(0, available - visibleWidth(left));

		let line = `${left}${" ".repeat(gap)} ${meta}`;
		if (overContext) {
			const plainPrefix = Bun.stripANSI(prefix);
			line = `${prefix}${theme.fg("dim", Bun.stripANSI(line).slice(plainPrefix.length))}`;
		}

		if (hovered) {
			line = theme.bg("selectedBg", line);
		}
		return line;
	}

	#detailLines(width: number): [string, string] {
		const selected = this.getSelected();
		if (!selected) return ["", ""];
		const model = selected.model;

		const facts: string[] = [model.name];
		if (model.contextWindow) facts.push(`${formatNumber(model.contextWindow).toLowerCase()} ctx`);
		if (model.maxTokens) facts.push(`${formatNumber(model.maxTokens).toLowerCase()} out`);
		facts.push(`${formatCostPair(model)} per M`);
		if (model.reasoning) facts.push("reasoning");
		if (model.input.includes("image")) facts.push("vision");
		const perf = this.#perf.get(selected.selector);
		if (perf) {
			facts.push(`~${formatTps(perf.tps)}`);
			if (perf.ttftMs !== null) facts.push(`${formatTtft(perf.ttftMs)} ttft`);
		}
		const line1 = truncateToWidth(theme.fg("muted", `  ${facts.join(" · ")}`), width);

		if (this.isOverContext(selected)) {
			const warning = `  ${theme.status.disabled} context ${formatNumber(this.#currentContextTokens).toLowerCase()} exceeds ${formatNumber(model.contextWindow ?? 0).toLowerCase()} limit · compacts with current model, then switches`;
			return [line1, truncateToWidth(theme.fg("warning", warning), width)];
		}

		const chips: string[] = [];
		if (selected.selector === this.#currentSelector) {
			chips.push(theme.fg("success", `${theme.status.enabled} current`));
		}
		const seen = new Set<string>();
		const pushRole = (role: string) => {
			if (seen.has(role)) return;
			seen.add(role);
			const assignment = this.#roles[role];
			if (!assignment || !modelsAreEqual(assignment.model, model)) return;
			if (getRoleInfo(role, this.#settings).hidden) return;
			chips.push(formatRoleChip(role, assignment, this.#settings));
		};
		for (const role of MODEL_ROLE_IDS) pushRole(role);
		for (const role in this.#roles) pushRole(role);
		const line2 = chips.length > 0 ? truncateToWidth(`  ${chips.join(theme.fg("dim", " · "))}`, width) : "";
		return [line1, line2];
	}

	render(width: number): string[] {
		const lines: string[] = [];

		const searchIcon = theme.fg("accent", theme.symbol("icon.search"));
		const inputWidth = Math.max(4, width - visibleWidth(theme.symbol("icon.search")) - 2);
		lines.push(` ${searchIcon} ${this.#searchInput.render(inputWidth)[0] ?? ""}`);
		lines.push("");

		const total = this.#visibleItems.length;

		this.#windowStart = this.#clampWindowStart(this.#windowStart);
		const startIndex = this.#windowStart;
		const endIndex = Math.min(startIndex + this.#maxVisible, total);
		this.#windowCount = Math.max(0, endIndex - startIndex);

		if (total === 0) {
			const message =
				this.#emptyText?.() ?? (this.query.trim() ? "  No matching models" : "  No models available in this scope");
			lines.push(truncateToWidth(theme.fg("muted", message), width));
			for (let i = 1; i < this.#maxVisible; i++) lines.push("");
		} else {
			let ctxWidth = 0;
			let costWidth = 0;
			const perfMode: PerfMode = width >= PERF_FULL_MIN_WIDTH ? "full" : width >= PERF_TPS_MIN_WIDTH ? "tps" : "off";
			let perfWidth = 0;
			for (let i = startIndex; i < endIndex; i++) {
				const item = this.#visibleItems[i];
				if (!item) continue;
				ctxWidth = Math.max(ctxWidth, visibleWidth(formatContext(item.model)));
				costWidth = Math.max(costWidth, visibleWidth(formatCostPair(item.model)));
				perfWidth = Math.max(perfWidth, visibleWidth(this.#perfCell(item, perfMode)));
			}

			const rows: string[] = [];
			for (let i = startIndex; i < endIndex; i++) {
				const item = this.#visibleItems[i];
				if (!item) continue;
				rows.push(
					this.#renderRow(
						item,
						width - 1,
						i === this.#selectedIndex,
						i === this.#hoveredIndex,
						ctxWidth,
						costWidth,
						perfWidth,
						perfMode,
					),
				);
			}
			const scrollView = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			scrollView.setScrollOffset(startIndex);
			lines.push(...scrollView.render(width));
			for (let i = rows.length; i < this.#maxVisible; i++) lines.push("");
		}

		lines.push("");
		const [detail1, detail2] = this.#detailLines(width);
		lines.push(detail1);
		lines.push(detail2);
		return lines;
	}

	invalidate(): void {}
}
