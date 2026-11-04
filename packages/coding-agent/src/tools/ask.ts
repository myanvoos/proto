import { type as arkType } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import {
	type Component,
	Markdown,
	type MarkdownTheme,
	renderInlineMarkdown,
	replaceTabs,
	TERMINAL,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { pluralize, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";
import askDescription from "../prompts/tools/ask.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { framedBlock, outputBlockContentWidth, renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { AskDeadline } from "./ask-deadline";
import { type AskSelectionUI, askSingleQuestion, OTHER_OPTION } from "./ask-selection";

export { OTHER_OPTION } from "./ask-selection";

import {
	type AskToolDetails,
	formatQuestionResult,
	formatSingleQuestionResponse,
	type QuestionResult,
} from "./ask-result";
import { formatErrorMessage, formatMeta, formatTitle, sanitizeCarriageReturns, wrapPrefixedLine } from "./render-utils";
import { ToolAbortError } from "./tool-errors";

export type { AskToolDetails } from "./ask-result";

const CHAT_ABOUT_THIS_OPTION = "Chat about this";
const NEXT_OPTION = "Next →";
const RESERVED_OPTION_LABELS: Record<string, true> = {
	[OTHER_OPTION]: true,
	[CHAT_ABOUT_THIS_OPTION]: true,
	[NEXT_OPTION]: true,
};

const OptionItem = arkType({
	label: arkType("string").describe("display label"),
	"description?": arkType("string").describe("optional explanatory text displayed below the label"),
	"preview?": arkType("string").describe("optional rich preview content for interactive ask dialogs"),
});

const QuestionItem = arkType({
	id: arkType("string").describe("question id"),
	question: arkType("string").describe("question text"),
	"header?": arkType("string").describe("optional short display chip for rich ask dialogs"),
	options: OptionItem.array().describe("available options"),
	"multi?": arkType("boolean").describe("allow multiple selections"),
	"recommended?": arkType("number").describe("recommended option index"),
}).narrow((question, ctx) => {
	const reserved = question.options.find(option => RESERVED_OPTION_LABELS[option.label] === true);
	return (
		reserved === undefined ||
		ctx.mustBe(`defined with option labels that do not collide with reserved runtime labels: ${reserved.label}`)
	);
});

const askSchema = arkType({
	questions: QuestionItem.array().atLeastLength(1).describe("questions to ask"),
	"timeout?": arkType("number >= 0").describe("whole-form timeout in seconds; overrides ask.timeout; 0 disables"),
});

export type AskToolInput = typeof askSchema.infer;

export function recoverAskInput(toolCallArguments: unknown): AskToolInput | undefined {
	const parsed = askSchema(toolCallArguments);
	if (parsed instanceof arkType.errors) return undefined;
	return parsed;
}

type AskParams = AskToolInput;

export class AskTool implements AgentTool<typeof askSchema, AskToolDetails> {
	readonly name = "ask";
	readonly label = "Ask";
	readonly summary = "Ask the user a clarifying question";
	readonly description: string;
	readonly parameters = askSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof askSchema.infer>[] = [
		{
			caption: "Single question",
			call: {
				questions: [
					{
						id: "auth_method",
						question: "Which authentication method should this API use?",
						options: [
							{ label: "JWT", description: "Bearer tokens for stateless API clients." },
							{ label: "OAuth2", description: "Delegated authorization with external identity providers." },
							{
								label: "Session cookies",
								description: "Browser-first authentication backed by server-side sessions.",
							},
						],
						recommended: 0,
					},
				],
			},
		},
		{
			caption: "Multiple questions",
			call: {
				questions: [
					{
						id: "storage_type",
						question: "Which storage backend?",
						options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
					},
					{
						id: "auth_method",
						question: "Which auth method?",
						options: [{ label: "JWT" }, { label: "Session cookies" }],
					},
				],
			},
		},
	];

	readonly concurrency = "exclusive";
	readonly interruptible = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(askDescription);
	}

	static createIf(session: ToolSession): AskTool | null {
		return (session.canPromptUser ?? session.hasUI) ? new AskTool(session) : null;
	}

	#sendAskNotification(): void {
		if (!this.session.hasUI) return;
		const method = this.session.settings.get("ask.notify");
		if (method === "off") return;
		TERMINAL.sendNotification({
			title: "Proto",
			body: "Waiting for input",
			type: "ask",
			urgency: "normal",
			actions: "focus",
		});
	}

	async execute(
		_toolCallId: string,
		params: AskParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AskToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<AskToolDetails>> {
		if (!context?.hasUI || !context.ui) {
			context?.abort();
			throw new ToolAbortError("Ask tool requires interactive mode");
		}

		if (params.questions.length === 0) {
			return { content: [{ type: "text", text: "Error: questions must not be empty" }], details: {} };
		}

		params = sanitizeAskDisplayText(params);

		const extensionUi = context.ui;
		const ui: AskSelectionUI = {
			select: (prompt, options, dialogOptions) => extensionUi.select(prompt, options, dialogOptions),
			editor: (title, prefill, dialogOptions, editorOptions) =>
				extensionUi.editor(title, prefill, dialogOptions, editorOptions),
		};

		const timeoutSeconds = params.timeout ?? this.session.settings.get("ask.timeout");
		const deadline = new AskDeadline(timeoutSeconds * 1000, signal);
		const confirmed = new Map<number, QuestionResult>();
		const cancelAsk = (): never => {
			if (signal?.reason === TOOL_INTERRUPT_ABORT_REASON) throw new ToolAbortError("Ask interrupted by message");
			context.abort();
			throw new ToolAbortError("Ask tool was cancelled by the user");
		};
		const unanswered = (q: AskParams["questions"][number]): QuestionResult => ({
			id: q.id,
			question: q.question,
			options: q.options.map(option => option.label),
			multi: q.multi ?? false,
			selectedOptions: [],
			timedOut: true,
		});
		const finish = (results: QuestionResult[], timedOut = false): AgentToolResult<AskToolDetails> => {
			if (params.questions.length === 1) {
				const { id: _id, ...details } = results[0]!;
				return {
					content: [
						{
							type: "text",
							text: `${timedOut && !details.timedOut ? "Ask form timed out; confirmed answer retained.\n" : ""}${formatSingleQuestionResponse(details)}`,
						},
					],
					details: { ...details, ...(timedOut ? { timedOut: true } : {}) },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `${timedOut ? "Ask timed out; confirmed answers only:" : "User answers:"}\n${results.map(formatQuestionResult).join("\n")}`,
					},
				],
				details: { results, ...(timedOut ? { timedOut: true } : {}) },
			};
		};
		this.#sendAskNotification();
		const askingAgentId = this.session.getAgentId?.();
		const fallbackHeader = askingAgentId && askingAgentId !== MAIN_AGENT_ID ? askingAgentId : undefined;
		try {
			const response = await deadline.run(async () => {
				const richAskDialog = extensionUi.askDialog;
				if (richAskDialog) {
					const richResult = await richAskDialog(
						params.questions.map(q => ({
							...q,
							...(q.header?.trim() ? { header: q.header } : fallbackHeader ? { header: fallbackHeader } : {}),
						})),
						{ timeout: deadline.timeoutMs > 0 ? deadline.timeoutMs : undefined, signal: deadline.signal },
					);
					if (deadline.signal.aborted) return undefined;
					if (!richResult) return cancelAsk();
					if (richResult.kind === "chat") {
						return {
							content: [
								{
									type: "text" as const,
									text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${params.questions.map(q => q.question).join("\n")}`,
								},
							],
							details: { chatRedirect: true, questions: params.questions.map(q => q.question) },
						};
					}
					if (richResult.results.length !== params.questions.length)
						throw new Error("Ask dialog returned a result count that does not match the requested questions");
					const results = params.questions.map((q, index) => {
						const result = richResult.results[index];
						if (!result || result.id !== q.id)
							throw new Error("Ask dialog returned results that do not match the requested question order");
						// A timeout marker never conveys an answer or approval, even from an older host.
						if (result.timedOut) return unanswered(q);
						return {
							...unanswered(q),
							selectedOptions: result.selectedOptions,
							customInput: result.customInput,
							note: result.note,
							noteOption: result.noteOption,
							timedOut: undefined,
						};
					});
					if (
						richResult.kind === "submit" &&
						results.length === 1 &&
						!results[0]!.multi &&
						!results[0]!.timedOut &&
						results[0]!.selectedOptions.length === 0 &&
						results[0]!.customInput === undefined
					)
						return cancelAsk();
					return finish(results, richResult.kind === "timeout" || results.some(result => result.timedOut));
				}
				let index = 0;
				while (index < params.questions.length) {
					const q = params.questions[index]!;
					const previous = confirmed.get(index);
					const selection = await askSingleQuestion(ui, q.question, q.options, q.multi ?? false, {
						recommended: q.recommended,
						signal: deadline.signal,
						initialSelection: previous,
						navigation:
							params.questions.length > 1
								? {
										allowBack: index > 0,
										allowForward: true,
										progressText: `${index + 1}/${params.questions.length}`,
									}
								: undefined,
					});
					if (deadline.signal.aborted) return undefined;
					if (selection.cancelled) return cancelAsk();
					// Arrow navigation does not confirm an unfinished multi-select draft.
					if (
						!selection.navigation ||
						(!q.multi && (selection.selectedOptions.length > 0 || selection.customInput !== undefined))
					) {
						confirmed.set(index, { ...unanswered(q), ...selection, timedOut: undefined });
					}
					index = selection.navigation === "back" ? Math.max(0, index - 1) : index + 1;
				}
				return finish(
					params.questions.map((q, index) => confirmed.get(index) ?? { ...unanswered(q), timedOut: undefined }),
				);
			});
			return (
				response ??
				finish(
					params.questions.map((q, index) => confirmed.get(index) ?? unanswered(q)),
					true,
				)
			);
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new ToolAbortError(
					signal?.reason === TOOL_INTERRUPT_ABORT_REASON
						? "Ask interrupted by message"
						: "Ask input was cancelled",
				);
			}
			throw error;
		}
	}
}

interface AskRenderOption {
	label: string;
	description?: string;
}

interface AskRenderArgs {
	question?: string;
	options?: AskRenderOption[];
	multi?: boolean;
	questions?: Array<{
		id: string;
		question: string;
		options: AskRenderOption[];
		multi?: boolean;
	}>;
}

function normalizeRenderOptions(raw: unknown): AskRenderOption[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: AskRenderOption[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			out.push({ label: sanitizeCarriageReturns(entry) });
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const { label, description } = entry as Partial<AskRenderOption>;
		if (typeof label !== "string") continue;
		out.push(
			typeof description === "string"
				? { label: sanitizeCarriageReturns(label), description: sanitizeCarriageReturns(description) }
				: { label: sanitizeCarriageReturns(label) },
		);
	}
	return out;
}

/**
 * Strip injected `\r` runs from the prose the dialog renders. Option labels and ids stay raw: they
 * are the answer's identity, and the select path maps the chosen row back by label.
 */
function sanitizeAskDisplayText(params: AskParams): AskParams {
	return {
		...params,
		questions: params.questions.map(question => ({
			...question,
			question: sanitizeCarriageReturns(question.question),
			...(question.header !== undefined ? { header: sanitizeCarriageReturns(question.header) } : {}),
			options: question.options.map(option => ({
				...option,
				...(option.description !== undefined ? { description: sanitizeCarriageReturns(option.description) } : {}),
				...(option.preview !== undefined ? { preview: sanitizeCarriageReturns(option.preview) } : {}),
			})),
		})),
	};
}

function normalizeRenderQuestions(raw: unknown): NonNullable<AskRenderArgs["questions"]> | undefined {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}
	if (!Array.isArray(raw)) return undefined;
	const out: NonNullable<AskRenderArgs["questions"]> = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as Partial<NonNullable<AskRenderArgs["questions"]>[number]>;
		out.push({
			id: typeof q.id === "string" ? q.id : "?",
			question: typeof q.question === "string" ? sanitizeCarriageReturns(q.question) : "",
			options: normalizeRenderOptions(q.options) ?? [],
			multi: q.multi === true,
		});
	}
	return out;
}

function renderCustomInputLines(uiTheme: Theme, customInput: string): string[] {
	const lines = sanitizeText(customInput).split("\n");
	const out: string[] = [
		` ${uiTheme.styledSymbol("status.success", "success")} ${uiTheme.fg("toolOutput", lines[0] ?? "")}`,
	];
	for (let i = 1; i < lines.length; i++) out.push(`   ${uiTheme.fg("toolOutput", lines[i])}`);
	return out;
}

function renderNoteLines(uiTheme: Theme, note: string, width: number): string[] {
	const prefix = " Note: ";
	const continuationPrefix = "       ";
	const firstLineWidth = Math.max(1, width - visibleWidth(prefix));
	const continuationWidth = Math.max(1, width - visibleWidth(continuationPrefix));
	return replaceTabs(sanitizeText(note))
		.split("\n")
		.map((line, index) => {
			const linePrefix = index === 0 ? `${uiTheme.fg("dim", " Note:")} ` : continuationPrefix;
			const maxWidth = index === 0 ? firstLineWidth : continuationWidth;
			return `${linePrefix}${uiTheme.fg("toolOutput", truncateToWidth(line, maxWidth))}`;
		});
}

function renderPendingQuestionLine(uiTheme: Theme, mdTheme: MarkdownTheme, question: string, width: number): string {
	const flattened = replaceTabs(sanitizeText(question)).replace(/\s+/g, " ").trim();
	const rendered = renderInlineMarkdown(flattened, mdTheme, t => uiTheme.fg("accent", t));
	return truncateToWidth(rendered, outputBlockContentWidth(width));
}

function optionMarker(uiTheme: Theme, multi: boolean | undefined, selected: boolean): string {
	if (multi) return selected ? uiTheme.checkbox.checked : uiTheme.checkbox.unchecked;
	return selected ? uiTheme.radio.selected : uiTheme.radio.unselected;
}

function renderAnswerOptionLines(
	uiTheme: Theme,
	mdTheme: MarkdownTheme,
	options: string[] | undefined,
	selectedOptions: string[] | undefined,
	multi: boolean | undefined,
	customInput: string | undefined,
	note: string | undefined,
	width: number,
): string[] {
	const selected = new Set(selectedOptions ?? []);

	const list = options && options.length > 0 ? options : (selectedOptions ?? []);

	if (selected.size === 0 && customInput === undefined && note === undefined) {
		return [` ${uiTheme.styledSymbol("status.warning", "warning")} ${uiTheme.fg("warning", "Cancelled")}`];
	}

	const out: string[] = [];
	for (const label of list) {
		const isSelected = selected.has(label);
		const marker = optionMarker(uiTheme, multi, isSelected);
		const markerStyled = isSelected ? uiTheme.fg("success", marker) : uiTheme.fg("dim", marker);
		const labelStyled = renderInlineMarkdown(label, mdTheme, t =>
			isSelected ? uiTheme.fg("toolOutput", t) : uiTheme.fg("muted", t),
		);
		const prefix = ` ${markerStyled} `;
		out.push(
			...wrapPrefixedLine(prefix, " ".repeat(visibleWidth(prefix)), labelStyled, outputBlockContentWidth(width)),
		);
	}
	if (customInput !== undefined) out.push(...renderCustomInputLines(uiTheme, customInput));
	if (note !== undefined) out.push(...renderNoteLines(uiTheme, note, width));
	return out;
}

export const askToolRenderer = {
	mergeCallAndResult: true,
	renderCall(args: AskRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const label = formatTitle("Ask", uiTheme);
		const mdTheme = getMarkdownTheme();

		const questions = normalizeRenderQuestions(args.questions);
		if (questions && questions.length > 0) {
			const header = `${label} ${uiTheme.fg("muted", `${questions.length} ${pluralize("question", questions.length)}`)}`;
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: questions.map(q => renderPendingQuestionLine(uiTheme, mdTheme, q.question, width)) }],
				state: "pending",
				borderColor: "borderMuted",
				width,
			}));
		}

		if (typeof args.question !== "string" || !args.question) {
			const errorLine = formatErrorMessage("No question provided", uiTheme);
			return framedBlock(uiTheme, width => ({
				header: errorLine,
				sections: [],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const question = args.question;
		const meta: string[] = [];
		if (args.multi) meta.push("multi");
		const questionOptions = normalizeRenderOptions(args.options);
		if (questionOptions?.length) meta.push(`options:${questionOptions.length}`);
		const header = `${label}${formatMeta(meta, uiTheme)}`;
		return framedBlock(uiTheme, width => ({
			header,
			sections: [{ lines: [renderPendingQuestionLine(uiTheme, mdTheme, question, width)] }],
			state: "pending",
			borderColor: "borderMuted",
			width,
		}));
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AskToolDetails },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const { details } = result;
		const mdTheme = getMarkdownTheme();
		const accentStyle = { color: (t: string) => uiTheme.fg("accent", t) };
		const md = (text: string, width: number) =>
			new Markdown(text, 1, 0, mdTheme, accentStyle).render(Math.max(1, outputBlockContentWidth(width) + 1));

		if (!details) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? txt.text : "";
			const header = renderStatusLine({ icon: "warning", title: "Ask" }, uiTheme);
			const body = fallback ? `\n${uiTheme.fg("dim", sanitizeText(fallback))}` : "";
			return new Text(`${header}${body}`, 0, 0);
		}

		if (details.chatRedirect) {
			const header = renderStatusLine({ icon: "info", title: "Ask", meta: ["chat redirect"] }, uiTheme);
			const questions = details.questions ?? [];
			return framedBlock(uiTheme, width => ({
				header,
				sections: questions.length > 0 ? [{ lines: questions.flatMap(q => md(q, width)) }] : [],
				state: "warning",
				borderColor: "borderMuted",
				width,
			}));
		}

		if (details.results && details.results.length > 0) {
			const results = details.results;
			const hasAnySelection = results.some(
				r =>
					r.customInput !== undefined ||
					r.note !== undefined ||
					(r.selectedOptions && r.selectedOptions.length > 0),
			);
			const header = renderStatusLine(
				{
					icon: hasAnySelection ? "success" : "warning",
					title: "Ask",
					meta: [`${results.length} ${pluralize("question", results.length)}`],
				},
				uiTheme,
			);
			return framedBlock(uiTheme, width => {
				const sections = results.map(r => {
					const lines = [
						...md(r.question, width),
						...renderAnswerOptionLines(
							uiTheme,
							mdTheme,
							r.options,
							r.selectedOptions,
							r.multi,
							r.customInput,
							r.note,
							width,
						),
					];
					if (r.timedOut) lines.push(uiTheme.fg("dim", "timed out — no response; not approval"));
					return { label: uiTheme.fg("dim", `[${r.id}]`), lines };
				});
				return {
					header,
					sections,
					state: hasAnySelection ? "success" : "warning",
					borderColor: "borderMuted",
					width,
				};
			});
		}

		if (!details.question) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? txt.text : "";
			return new Text(fallback, 0, 0);
		}

		const question = details.question;
		const hasSelection =
			details.customInput !== undefined ||
			details.note !== undefined ||
			(details.selectedOptions && details.selectedOptions.length > 0);
		const header = renderStatusLine(
			hasSelection
				? { iconOverride: uiTheme.styledSymbol("tool.ask", "accent"), title: "Ask" }
				: { icon: "warning", title: "Ask" },
			uiTheme,
		);
		const dOptions = details.options;
		const dSelected = details.selectedOptions;
		const dMulti = details.multi;
		const dCustom = details.customInput;
		const dNote = details.note;
		const dTimedOut = details.timedOut;
		return framedBlock(uiTheme, width => {
			const bodyLines = [
				...md(question, width),
				...renderAnswerOptionLines(uiTheme, mdTheme, dOptions, dSelected, dMulti, dCustom, dNote, width),
			];
			if (dTimedOut) {
				bodyLines.push(
					uiTheme.fg(
						"dim",
						hasSelection ? "form timed out — confirmed answer retained" : "timed out — no response; not approval",
					),
				);
			}
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: hasSelection ? "success" : "warning",
				borderColor: "borderMuted",
				width,
			};
		});
	},
};
