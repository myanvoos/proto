import { Ellipsis, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ExtensionUISelectItem } from "../extensibility/extensions";
import { theme } from "../modes/theme/theme";

export const OTHER_OPTION = "Other (type your own)";

interface AskOption {
	label: string;
	description?: string;
}

function getSelectOptionLabel(option: ExtensionUISelectItem): string {
	return typeof option === "string" ? option : option.label;
}

function toSelectOption(option: AskOption, label = option.label): ExtensionUISelectItem {
	return option.description ? { label, description: option.description } : label;
}

const RECOMMENDED_SUFFIX = " (Recommended)";

function getDoneOptionLabel(): string {
	return `${theme.status.success} Done selecting`;
}

function addRecommendedSuffix(options: AskOption[], recommendedIndex?: number): ExtensionUISelectItem[] {
	if (recommendedIndex === undefined || recommendedIndex < 0 || recommendedIndex >= options.length) {
		return options.map(option => toSelectOption(option));
	}
	return options.map((option, i) => {
		const label =
			i === recommendedIndex && !option.label.endsWith(RECOMMENDED_SUFFIX)
				? option.label + RECOMMENDED_SUFFIX
				: option.label;
		return toSelectOption(option, label);
	});
}

function stripRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

interface CustomInputContext {
	selectionMarker: "radio" | "checkbox";
	checkedIndices?: readonly number[];
	markableCount: number;
}

const MAX_CUSTOM_INPUT_OPTION_ROWS = 8;
const MAX_CUSTOM_INPUT_TITLE_ROWS = 16;
const MIN_CUSTOM_INPUT_CONTENT_WIDTH = 20;

const CUSTOM_INPUT_CHROME_COLUMNS = 8;
const CUSTOM_INPUT_DESCRIPTION_INDENT = "    ";

function customInputContentWidth(): number {
	const cols = process.stdout.columns ?? 80;
	return Math.max(MIN_CUSTOM_INPUT_CONTENT_WIDTH, cols - CUSTOM_INPUT_CHROME_COLUMNS);
}

function clampLineToWidth(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	return truncateToWidth(line, width, Ellipsis.Unicode);
}

function flattenDescription(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function getSelectOptionDescription(option: ExtensionUISelectItem): string | undefined {
	return typeof option === "string" ? undefined : option.description;
}

interface CustomInputOptionGap {
	total: number;
	checked: number;
}

interface CustomInputOptionWindow {
	indices: number[];
	gapBefore: Map<number, CustomInputOptionGap>;
}

function pickCustomInputOptionWindow(
	total: number,
	selectedIndex: number,
	checked: ReadonlySet<number>,
): CustomInputOptionWindow {
	if (total === 0) return { indices: [], gapBefore: new Map() };
	if (total <= MAX_CUSTOM_INPUT_OPTION_ROWS) {
		return {
			indices: Array.from({ length: total }, (_, i) => i),
			gapBefore: new Map(),
		};
	}
	const keep = new Set<number>();
	const addIfRoom = (index: number) => {
		if (index >= 0 && index < total && keep.size < MAX_CUSTOM_INPUT_OPTION_ROWS) {
			keep.add(index);
		}
	};
	addIfRoom(selectedIndex);
	addIfRoom(0);
	for (const i of [...checked].sort((a, b) => a - b)) {
		addIfRoom(i);
	}
	for (let i = 0; i < total && keep.size < MAX_CUSTOM_INPUT_OPTION_ROWS; i++) {
		addIfRoom(i);
	}
	const indices = [...keep].sort((a, b) => a - b);
	const gapBefore = new Map<number, CustomInputOptionGap>();
	const countCheckedBetween = (startInclusive: number, endExclusive: number): number => {
		let count = 0;
		for (const i of checked) {
			if (i >= startInclusive && i < endExclusive) count++;
		}
		return count;
	};
	let prev = -1;
	for (const idx of indices) {
		if (idx > prev + 1) {
			gapBefore.set(idx, {
				total: idx - prev - 1,
				checked: countCheckedBetween(prev + 1, idx),
			});
		}
		prev = idx;
	}
	if (prev < total - 1) {
		gapBefore.set(total, {
			total: total - 1 - prev,
			checked: countCheckedBetween(prev + 1, total),
		});
	}
	return { indices, gapBefore };
}

interface CustomInputRow {
	text: string;

	priority: number;
}

function buildCustomInputRows(
	question: string,
	options: ExtensionUISelectItem[],
	context: CustomInputContext,
	contentWidth: number,
): CustomInputRow[] {
	const selectedIndex = options.findIndex(option => getSelectOptionLabel(option) === OTHER_OPTION);
	const checked = new Set(context.checkedIndices ?? []);
	const window = pickCustomInputOptionWindow(options.length, selectedIndex, checked);
	const rows: CustomInputRow[] = [];
	rows.push({ text: clampLineToWidth(question, contentWidth), priority: -1 });
	rows.push({ text: "", priority: -1 });

	const emitGap = (gap: CustomInputOptionGap) => {
		const checkedSuffix = gap.checked > 0 ? `, ${gap.checked} checked` : "";
		rows.push({
			text: clampLineToWidth(
				`    … ${gap.total} more option${gap.total === 1 ? "" : "s"}${checkedSuffix} …`,
				contentWidth,
			),
			priority: 2,
		});
	};

	for (const index of window.indices) {
		const gap = window.gapBefore.get(index);
		if (gap !== undefined) emitGap(gap);
		const option = options[index]!;
		const label = getSelectOptionLabel(option);
		const isSelected = index === selectedIndex;
		const isMarkable = index < context.markableCount;
		const prefix =
			context.selectionMarker === "radio" && (isMarkable || isSelected)
				? `${isSelected ? theme.radio.selected : theme.radio.unselected} `
				: context.selectionMarker === "checkbox" && isMarkable
					? `${checked.has(index) ? theme.checkbox.checked : theme.checkbox.unchecked} `
					: isSelected
						? `${theme.nav.cursor} `
						: "  ";
		rows.push({ text: clampLineToWidth(prefix + label, contentWidth), priority: -1 });
		const description = getSelectOptionDescription(option);
		if (description) {
			const flat = flattenDescription(description);
			if (flat) {
				rows.push({
					text: clampLineToWidth(`${CUSTOM_INPUT_DESCRIPTION_INDENT}${flat}`, contentWidth),

					priority: isSelected ? 2 : checked.has(index) ? 1 : 0,
				});
			}
		}
	}

	const trailingGap = window.gapBefore.get(options.length);
	if (trailingGap !== undefined) emitGap(trailingGap);
	rows.push({ text: "", priority: -1 });
	rows.push({ text: "Enter your response:", priority: -1 });
	return rows;
}

function applyCustomInputRowBudget(rows: CustomInputRow[], budget: number): CustomInputRow[] {
	if (rows.length <= budget) return rows;

	const droppable = rows
		.map((row, index) => ({ row, index }))
		.filter(entry => entry.row.priority >= 0)
		.sort((a, b) => a.row.priority - b.row.priority || b.index - a.index);
	const removed = new Set<number>();
	for (const { index } of droppable) {
		if (rows.length - removed.size <= budget) break;
		removed.add(index);
	}
	return rows.filter((_, i) => !removed.has(i));
}

function formatCustomInputTitle(
	question: string,
	options: ExtensionUISelectItem[],
	context: CustomInputContext,
): string {
	const contentWidth = customInputContentWidth();
	const rows = buildCustomInputRows(question, options, context, contentWidth);
	return applyCustomInputRowBudget(rows, MAX_CUSTOM_INPUT_TITLE_ROWS)
		.map(row => row.text)
		.join("\n");
}

interface SelectionResult {
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	noteOption?: string;
	navigation?: "back" | "forward";
	cancelled?: boolean;
}

interface NavigationControls {
	allowBack: boolean;
	allowForward: boolean;
	progressText?: string;
}
interface AskSingleQuestionOptions {
	recommended?: number;
	signal?: AbortSignal;
	initialSelection?: Pick<SelectionResult, "selectedOptions" | "customInput" | "note">;
	navigation?: NavigationControls;
}

export interface AskSelectionUI {
	select(
		prompt: string,
		options: ExtensionUISelectItem[],
		options_?: {
			initialIndex?: number;
			signal?: AbortSignal;
			outline?: boolean;
			onLeft?: () => void;
			onRight?: () => void;
			helpText?: string;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: readonly number[];
			markableCount?: number;
		},
	): Promise<string | undefined>;
	editor(
		title: string,
		prefill?: string,
		dialogOptions?: { signal?: AbortSignal },
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;
}

export async function askSingleQuestion(
	ui: AskSelectionUI,
	question: string,
	questionOptions: AskOption[],
	multi: boolean,
	options: AskSingleQuestionOptions = {},
): Promise<SelectionResult> {
	const { recommended, signal, initialSelection, navigation } = options;
	const doneLabel = getDoneOptionLabel();
	let selectedOptions = [...(initialSelection?.selectedOptions ?? [])];
	let customInput = initialSelection?.customInput;
	const note = initialSelection?.note;

	const selectOption = async (
		prompt: string,
		optionsToShow: ExtensionUISelectItem[],
		initialIndex?: number,
		marker?: { selectionMarker: "radio" | "checkbox"; checkedIndices?: readonly number[]; markableCount: number },
	): Promise<{ choice: string | undefined; navigation?: "back" | "forward" }> => {
		let navigationAction: "back" | "forward" | undefined;
		const choice = await untilAborted(signal, () =>
			ui.select(prompt, optionsToShow, {
				initialIndex,
				signal,
				outline: true,
				helpText: navigation
					? "up/down navigate  enter select  ←/→ question  esc cancel"
					: "up/down navigate  enter select  esc cancel",
				...marker,
				onLeft: navigation?.allowBack
					? () => {
							navigationAction = "back";
						}
					: undefined,
				onRight: navigation?.allowForward
					? () => {
							navigationAction = "forward";
						}
					: undefined,
			}),
		);
		return { choice, navigation: navigationAction };
	};

	const promptForCustomInput = async (
		title: string,
		optionsToShow: ExtensionUISelectItem[],
		context: CustomInputContext,
	): Promise<{ input: string | undefined }> => {
		const dialogOptions = signal ? { signal } : undefined;
		const editorTitle = formatCustomInputTitle(title, optionsToShow, context);
		const showCustomInput = () => ui.editor(editorTitle, undefined, dialogOptions, { promptStyle: true });
		const input = signal ? await untilAborted(signal, showCustomInput) : await showCustomInput();
		return { input };
	};

	const promptWithProgress = navigation?.progressText ? `${question} (${navigation.progressText})` : question;
	if (multi) {
		const selected = new Set<string>(selectedOptions);
		let cursorIndex = Math.min(Math.max(recommended ?? 0, 0), Math.max(questionOptions.length - 1, 0));
		const firstSelected = selectedOptions[0];
		if (firstSelected) {
			const selectedIndex = questionOptions.findIndex(option => option.label === firstSelected);
			if (selectedIndex >= 0) cursorIndex = selectedIndex;
		}
		while (true) {
			const opts: ExtensionUISelectItem[] = questionOptions.map(opt => toSelectOption(opt));

			if (selected.size > 0) {
				opts.push(doneLabel);
			}
			opts.push(OTHER_OPTION);

			const checkedIndices: number[] = [];
			for (let i = 0; i < questionOptions.length; i++) {
				if (selected.has(questionOptions[i]!.label)) checkedIndices.push(i);
			}
			const prefix = selected.size > 0 ? `(${selected.size} selected) ` : "";
			const { choice, navigation: arrowNavigation } = await selectOption(
				`${prefix}${promptWithProgress}`,
				opts,
				cursorIndex,
				{
					selectionMarker: "checkbox",
					checkedIndices,
					markableCount: questionOptions.length,
				},
			);

			if (arrowNavigation) {
				return { selectedOptions: Array.from(selected), customInput, note, navigation: arrowNavigation };
			}
			if (choice === undefined) {
				return { selectedOptions: Array.from(selected), customInput, note, cancelled: true };
			}
			if (choice === doneLabel) break;

			if (choice === OTHER_OPTION) {
				const customResult = await promptForCustomInput(`${prefix}${promptWithProgress}`, opts, {
					selectionMarker: "checkbox",
					checkedIndices,
					markableCount: questionOptions.length,
				});
				if (customResult.input === undefined) {
					continue;
				}
				customInput = customResult.input;
				break;
			}

			const selectedIdx = opts.findIndex(opt => getSelectOptionLabel(opt) === choice);
			if (selectedIdx >= 0) {
				cursorIndex = selectedIdx;
			}

			if (selected.has(choice)) {
				selected.delete(choice);
			} else {
				selected.add(choice);
			}
		}
		selectedOptions = Array.from(selected);
	} else {
		while (true) {
			const displayOptions = addRecommendedSuffix(questionOptions, recommended);
			const optionsWithNavigation: ExtensionUISelectItem[] = [...displayOptions, OTHER_OPTION];

			let initialIndex = recommended;
			const previouslySelected = selectedOptions[0];
			if (previouslySelected) {
				const selectedIndex = questionOptions.findIndex(option => option.label === previouslySelected);
				if (selectedIndex >= 0) initialIndex = selectedIndex;
			} else if (customInput !== undefined) {
				initialIndex = displayOptions.length;
			}
			if (initialIndex !== undefined) {
				const maxIndex = Math.max(optionsWithNavigation.length - 1, 0);
				initialIndex = Math.max(0, Math.min(initialIndex, maxIndex));
			}

			const { choice, navigation: arrowNavigation } = await selectOption(
				promptWithProgress,
				optionsWithNavigation,
				initialIndex,
				{
					selectionMarker: "radio",
					markableCount: displayOptions.length,
				},
			);

			if (arrowNavigation) {
				return { selectedOptions, customInput, note, navigation: arrowNavigation };
			}
			if (choice === undefined) {
				return { selectedOptions, customInput, note, cancelled: true };
			}
			if (choice === OTHER_OPTION) {
				const customResult = await promptForCustomInput(promptWithProgress, optionsWithNavigation, {
					selectionMarker: "radio",
					markableCount: displayOptions.length,
				});
				if (customResult.input === undefined) {
					continue;
				}
				customInput = customResult.input;
				selectedOptions = [];
				break;
			}
			selectedOptions = [stripRecommendedSuffix(choice)];
			customInput = undefined;
			break;
		}
		if (navigation?.allowForward) {
			return { selectedOptions, customInput, note, navigation: "forward" };
		}
	}

	return { selectedOptions, customInput, note };
}
