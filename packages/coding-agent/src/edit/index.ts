import { MismatchError as HashlineMismatchError, HL_MOVE_KEYWORD } from "@oh-my-pi/hashline";
import hashlineGrammar from "@oh-my-pi/hashline/grammar.lark" with { type: "text" };
import hashlineDescription from "@oh-my-pi/hashline/prompt.md" with { type: "text" };
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { errorMessage, isCancellation, prompt } from "@oh-my-pi/pi-utils";
import applyPatchDescription from "../prompts/tools/apply-patch.md" with { type: "text" };
import patchDescription from "../prompts/tools/patch.md" with { type: "text" };
import replaceDescription from "../prompts/tools/replace.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { abortedPartway } from "../tools/aborted-partway";
import { isInternalUrlPath } from "../tools/path-utils";
import { type EditMode, normalizeEditMode, resolveEditMode } from "../utils/edit-mode";
import { executeHashlineSingle, hashlineEditParamsSchema } from "./hashline";
import { type ApplyPatchParams, applyPatchSchema, expandApplyPatchToEntries } from "./modes/apply-patch";
import applyPatchGrammar from "./modes/apply-patch.lark" with { type: "text" };
import { executePatchSingle, type PatchEditEntry, type PatchParams, patchEditSchema } from "./modes/patch";
import { executeReplaceSingle, type ReplaceEditEntry, type ReplaceParams, replaceEditSchema } from "./modes/replace";
import type { EditToolDetails, EditToolPerFileResult } from "./renderer";
import { pruneOversizedEditSnapshots } from "./snapshot-details";
import { EDIT_MODE_STRATEGIES } from "./streaming";

export * from "@oh-my-pi/hashline";
export { DEFAULT_EDIT_MODE, type EditMode, normalizeEditMode } from "../utils/edit-mode";
export * from "./apply-patch";
export * from "./diff";
export * from "./file-snapshot-store";
export * from "./hashline";

export * from "./match";
export * from "./modes/apply-patch";
export * from "./modes/patch";
export * from "./modes/replace";
export * from "./normalize";
export * from "./renderer";
export * from "./snapshot-details";
export * from "./streaming";

type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof applyPatchSchema;

type HashlineParams = typeof hashlineEditParamsSchema.infer;

type EditParams = ReplaceParams | PatchParams | HashlineParams | ApplyPatchParams;

type EditModeDefinition = {
	description: (session: ToolSession) => string;
	parameters: TInput;
	examples?: readonly ToolExample[];
	execute: (
		tool: EditTool,
		params: EditParams,
		signal: AbortSignal | undefined,
		onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
	) => Promise<AgentToolResult<EditToolDetails, TInput>>;
};

function resolveConfiguredEditMode(rawEditMode: string): EditMode | undefined {
	if (!rawEditMode || rawEditMode === "auto") {
		return undefined;
	}

	const editMode = normalizeEditMode(rawEditMode);
	if (!editMode) {
		throw new Error(`Invalid VEYYON_EDIT_VARIANT: ${rawEditMode}`);
	}

	return editMode;
}

function resolveAllowFuzzy(session: ToolSession, rawValue: string): boolean {
	switch (rawValue) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		case "auto":
			return session.settings.get("edit.fuzzyMatch");
		default:
			throw new Error(`Invalid VEYYON_EDIT_FUZZY: ${rawValue}`);
	}
}

function resolveFuzzyThreshold(session: ToolSession, rawValue: string): number {
	if (rawValue === "auto") {
		return session.settings.get("edit.fuzzyThreshold");
	}

	const threshold = Number.parseFloat(rawValue);
	if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
		throw new Error(`Invalid VEYYON_EDIT_FUZZY_THRESHOLD: ${rawValue}`);
	}

	return threshold;
}

function editAbortedPartway(
	unit: "file" | "entry",
	applied: readonly string[],
	pending: readonly string[],
	cause: unknown,
) {
	return abortedPartway(
		{
			operation: "Edit",
			unit: unit === "file" ? { one: "file", many: "files" } : { one: "entry", many: "entries" },
			done: applied,
			pending,
			doneLabel: "already applied",
			pendingLabel: "NOT applied",
			advice: "re-read the affected files before re-issuing",
		},
		cause,
	);
}

async function executeApplyPatchPerFile(
	fileEntries: {
		path: string;
		run: () => Promise<AgentToolResult<EditToolDetails>>;
	}[],
	signal: AbortSignal | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (fileEntries.length === 1) {
		return fileEntries[0].run();
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];
	let hasError = false;

	const filePaths = fileEntries.map(entry => entry.path);
	for (let i = 0; i < fileEntries.length; i++) {
		const { path, run } = fileEntries[i];

		if (signal?.aborted) {
			throw editAbortedPartway("file", filePaths.slice(0, i), filePaths.slice(i), signal.reason);
		}
		const isLast = i === fileEntries.length - 1;
		try {
			const result = await run();
			const details = result.details;
			perFileResults.push({
				path: details?.path ?? path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				op: details?.op,
				move: details?.move,
				sourcePath: details?.sourcePath,
				meta: details?.meta,
				oldText: details?.oldText,
				newText: details?.newText,
				snapshotsPruned: details?.snapshotsPruned,
			});
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			if (isCancellation(err)) {
				throw editAbortedPartway("file", filePaths.slice(0, i), filePaths.slice(i), err);
			}
			const errorText = errorMessage(err);
			const displayErrorText = err instanceof HashlineMismatchError ? err.displayMessage : undefined;
			perFileResults.push({ path, diff: "", isError: true, errorText, displayErrorText });
			contentTexts.push(`Error editing ${path}: ${errorText}`);
			hasError = true;

			if (i > 0) {
				const appliedPaths = fileEntries
					.slice(0, i)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(`Files already applied: ${appliedPaths}.`);
			}
			if (i + 1 < fileEntries.length) {
				const skippedPaths = fileEntries
					.slice(i + 1)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(
					`Files NOT applied: ${skippedPaths}; re-read the affected files and re-issue only the failed and unapplied files.`,
				);
			}

			break;
		}

		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: perFileResults
						.map(r => r.diff)
						.filter(Boolean)
						.join("\n"),
					firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
					perFileResults: [...perFileResults],
				},
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
			perFileResults,
		}),

		...(hasError ? { isError: true } : {}),
	};
}

async function executeSinglePathEntries(
	path: string,
	runs: (() => Promise<AgentToolResult<EditToolDetails>>)[],
	onUpdate: ((partialResult: AgentToolResult<EditToolDetails, TInput>) => void) | undefined,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (runs.length === 1) {
		return runs[0]();
	}

	const contentTexts: string[] = [];
	const diffTexts: string[] = [];
	let firstChangedLine: number | undefined;
	let hasError = false;
	let metadataPath: string | undefined;
	let hasFirstOldText = false;
	let firstOldText: string | undefined;
	let hasLastNewText = false;
	let lastNewText: string | undefined;

	let snapshotsPruned = false;

	const entryLabels = runs.map((_, index) => `entry ${index + 1}`);
	for (let i = 0; i < runs.length; i++) {
		if (signal?.aborted) {
			throw editAbortedPartway("entry", entryLabels.slice(0, i), entryLabels.slice(i), signal.reason);
		}
		const isLast = i === runs.length - 1;

		try {
			const result = await runs[i]();
			const details = result.details;
			if (details?.diff) diffTexts.push(details.diff);
			firstChangedLine ??= details?.firstChangedLine;
			if (details?.path) {
				metadataPath ??= details.path;
			}
			if (details && "oldText" in details && !hasFirstOldText) {
				firstOldText = details.oldText;
				hasFirstOldText = true;
			}
			if (details && "newText" in details) {
				lastNewText = details.newText;
				hasLastNewText = true;
			}
			if (details?.snapshotsPruned) snapshotsPruned = true;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			if (isCancellation(err)) {
				throw editAbortedPartway("entry", entryLabels.slice(0, i), entryLabels.slice(i), err);
			}
			const errorText = errorMessage(err);
			contentTexts.push(`Error editing ${path} (entry ${i + 1} of ${runs.length}): ${errorText}`);
			if (i > 0) {
				contentTexts.push(i === 1 ? `Entry 1 was already applied.` : `Entries 1-${i} were already applied.`);
			}
			if (i + 1 < runs.length) {
				contentTexts.push(
					(i + 2 === runs.length
						? `Entry ${runs.length} was NOT applied`
						: `Entries ${i + 2}-${runs.length} were NOT applied`) +
						`; re-read the file and re-issue only the failed and unapplied entries.`,
				);
			}
			hasError = true;

			break;
		}

		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: diffTexts.join("\n"),
					firstChangedLine,
				},
				...(hasError ? { isError: true } : {}),
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: diffTexts.join("\n"),
			firstChangedLine,
			path: metadataPath ?? path,
			...(snapshotsPruned
				? { snapshotsPruned: true as const }
				: {
						...(hasFirstOldText ? { oldText: firstOldText } : {}),
						...(hasLastNewText ? { newText: lastNewText } : {}),
					}),
		}),

		...(hasError ? { isError: true } : {}),
	};
}

function extractApprovalPath(args: unknown): string {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input) {
		const hashlineMatch = /^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/m.exec(input);
		if (hashlineMatch?.[1]) return hashlineMatch[1];

		const applyPatchMatch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(input);
		if (applyPatchMatch?.[1]) return applyPatchMatch[1].trim();
	}

	const targetPath = record.path;
	return typeof targetPath === "string" && targetPath.length > 0 ? targetPath : "(unknown)";
}

const DEFAULT_PROMPT_TRUNCATE_CHARS = 2000;

export function truncateForPrompt(value: string, maxChars = DEFAULT_PROMPT_TRUNCATE_CHARS): string {
	if (value.length <= maxChars) return value;
	const omitted = value.length - maxChars;
	return `${value.slice(0, maxChars)}[…${omitted}ch elided…]`;
}

export function editFilesystemTargets(args: unknown): string[] {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const targets: string[] = [];
	if (typeof record.path === "string" && record.path.length > 0) targets.push(record.path);
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input) {
		for (const match of input.matchAll(/^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/gm)) {
			if (match[1]) targets.push(match[1]);
		}
		for (const match of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
			if (match[1]) targets.push(match[1].trim());
		}

		for (const match of input.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) {
			if (match[1]) targets.push(match[1].trim());
		}
		for (const match of input.matchAll(new RegExp(String.raw`^\s*${HL_MOVE_KEYWORD}\s+(.+)$`, "gm"))) {
			if (match[1]) targets.push(match[1].trim());
		}
	}
	return targets;
}

export class EditTool implements AgentTool<TInput> {
	readonly approval = (args: unknown) => {
		const targetPath = extractApprovalPath(args);
		return targetPath !== "(unknown)" && isInternalUrlPath(targetPath) ? "read" : "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => [
		`File: ${truncateForPrompt(extractApprovalPath(args))}`,
	];

	readonly filesystemTargets = (args: unknown): string[] => editFilesystemTargets(args);
	readonly name = "edit";
	readonly label = "Edit";
	readonly loadMode = "essential";
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #editMode?: EditMode;

	constructor(private readonly session: ToolSession) {
		const {
			VEYYON_EDIT_FUZZY: editFuzzy = "auto",
			VEYYON_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			VEYYON_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;

		this.#editMode = resolveConfiguredEditMode(envEditVariant);
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
	}

	get mode(): EditMode {
		if (this.#editMode) return this.#editMode;
		return resolveEditMode(this.session);
	}

	get description(): string {
		return this.#getModeDefinition().description(this.session);
	}

	get parameters(): TInput {
		return this.#getModeDefinition().parameters;
	}

	get examples(): readonly ToolExample[] | undefined {
		return this.#getModeDefinition().examples;
	}

	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		if (this.mode === "apply_patch") return { syntax: "lark", definition: applyPatchGrammar };
		if (this.mode === "hashline") return { syntax: "lark", definition: hashlineGrammar };
		return undefined;
	}

	get customWireName(): string | undefined {
		if (this.mode !== "apply_patch") return undefined;
		return "apply_patch";
	}

	matcherDigest(args: unknown): string | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherDigest(args);
	}

	matcherPaths(args: unknown): readonly string[] | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherPaths(args);
	}

	matcherEntries(args: unknown): readonly { path: string; digest: string }[] | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherEntries(args);
	}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolDetails, TInput>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolDetails, TInput>> {
		const modeDefinition = this.#getModeDefinition();
		return modeDefinition.execute(this, params, signal, onUpdate);
	}

	#getModeDefinition(): EditModeDefinition {
		return {
			patch: {
				description: () => prompt.render(patchDescription),
				parameters: patchEditSchema,
				examples: [
					{
						caption: "Create",
						call: { path: "hello.txt", edits: [{ op: "create", diff: "Hello\n" }] },
					},
					{
						caption: "Update",
						call: {
							path: "src/app.py",
							edits: [
								{
									op: "update",
									diff: "@@ def greet():\n def greet():\n-print('Hi')\n+print('Hello')\n",
								},
							],
						},
					},
					{
						caption: "Rename",
						call: {
							path: "src/app.py",
							edits: [{ op: "update", rename: "src/main.py", diff: "@@\n …\n" }],
						},
					},
					{
						caption: "Delete",
						call: { path: "obsolete.txt", edits: [{ op: "delete" }] },
					},
					{
						caption: "Multiple entries",
						note: "All entries in one call apply to the top-level `path`; use separate calls for different files.",
					},
				] satisfies readonly ToolExample<PatchParams>[],
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as PatchParams;
					const runs = (edits as PatchEditEntry[]).map(
						entry => () =>
							executePatchSingle({
								session: tool.session,
								path,
								params: entry,
								signal,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,

								allowCreateOverwrite: true,
							}),
					);
					return executeSinglePathEntries(path, runs, onUpdate, signal);
				},
			},
			apply_patch: {
				description: () => prompt.render(applyPatchDescription),
				parameters: applyPatchSchema,
				examples: [
					{
						caption: "Apply a combined patch file",
						call: {
							input: '*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n',
						},
					},
				] satisfies readonly ToolExample<ApplyPatchParams>[],
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const entries = expandApplyPatchToEntries(params as ApplyPatchParams);
					const perFile = entries.map(entry => {
						const { path, ...patchParams } = entry;
						return {
							path,
							run: () =>
								executePatchSingle({
									session: tool.session,
									path,
									params: patchParams,
									signal,
									allowFuzzy: tool.#allowFuzzy,
									fuzzyThreshold: tool.#fuzzyThreshold,
								}),
						};
					});
					return executeApplyPatchPerFile(perFile, signal, onUpdate);
				},
			},
			hashline: {
				description: () => prompt.render(hashlineDescription),
				parameters: hashlineEditParamsSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					_onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { input } = params as HashlineParams;
					return executeHashlineSingle({
						session: tool.session,
						input,
						signal,
					});
				},
			},
			replace: {
				description: () => prompt.render(replaceDescription),
				parameters: replaceEditSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as ReplaceParams;
					const runs = (edits as ReplaceEditEntry[]).map(
						entry => () =>
							executeReplaceSingle({
								session: tool.session,
								path,
								params: entry,
								signal,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
							}),
					);
					return executeSinglePathEntries(path, runs, onUpdate, signal);
				},
			},
		}[this.mode];
	}
}
