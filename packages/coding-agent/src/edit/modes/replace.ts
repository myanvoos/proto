import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/acp-bridge";
import { writeFileWithFallback } from "../../tools/file-write-fallback";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { outputMeta } from "../../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { generateDiffString, replaceText } from "../diff";
import { EditMatchError, findMatch, formatOccurrenceError } from "../match";
import { detectLineEnding, normalizeToLF, restoreLineEndings } from "../normalize";
import { readEditFileTextWithBom, serializeEditFileText } from "../read-file";
import type { EditToolDetails } from "../renderer";
import { pruneOversizedEditSnapshots } from "../snapshot-details";

export const replaceEditEntrySchema = type({
	old_text: "string",
	new_text: "string",
	"all?": "boolean",
});

export const replaceEditSchema = type({
	path: "string",
	edits: replaceEditEntrySchema.array(),
});

export type ReplaceEditEntry = typeof replaceEditEntrySchema.infer;
export type ReplaceParams = typeof replaceEditSchema.infer;

export interface ExecuteReplaceSingleOptions {
	session: ToolSession;
	path: string;
	params: ReplaceEditEntry;
	signal?: AbortSignal;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
}

export async function executeReplaceSingle(
	options: ExecuteReplaceSingleOptions,
): Promise<AgentToolResult<EditToolDetails, ReplaceEditEntry>> {
	const { session, path, params, signal, allowFuzzy, fuzzyThreshold } = options;
	const { old_text, new_text, all } = params;

	enforcePlanModeWrite(session, path);

	if (old_text.length === 0) {
		throw new Error("old_text must not be empty.");
	}

	const absolutePath = resolvePlanPath(session, path);

	const { bom, content } = await readEditFileTextWithBom(absolutePath, path);
	const originalEnding = detectLineEnding(content);
	const normalizedContent = normalizeToLF(content);
	const normalizedOldText = normalizeToLF(old_text);
	const normalizedNewText = normalizeToLF(new_text);

	const result = replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
		fuzzy: allowFuzzy,
		all: all ?? false,
		threshold: fuzzyThreshold,
	});

	if (result.count === 0) {
		const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
			allowFuzzy,
			threshold: fuzzyThreshold,
		});

		if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
			throw new Error(formatOccurrenceError(path, matchOutcome));
		}

		throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
			allowFuzzy,
			threshold: fuzzyThreshold,
			fuzzyMatches: matchOutcome.fuzzyMatches,
		});
	}

	if (normalizedContent === result.content) {
		throw new Error(`Edits to ${path} resulted in no changes being made.`);
	}

	const finalContent = await serializeEditFileText(
		absolutePath,
		path,
		bom + restoreLineEndings(result.content, originalEnding),
	);

	if (await routeWriteThroughBridge(session, path, absolutePath, finalContent, signal)) {
		// written through the client bridge
	} else {
		await writeFileWithFallback(absolutePath, finalContent, Bun.file(absolutePath));
		invalidateFsScanAfterWrite(absolutePath);
	}

	const diffResult = generateDiffString(normalizedContent, result.content, undefined, { path });
	const resultText =
		result.count > 1
			? `Successfully replaced ${result.count} occurrences in ${path}.`
			: `Successfully replaced text in ${path}.`;

	const meta = outputMeta().get();

	return {
		content: [{ type: "text", text: resultText }],
		details: pruneOversizedEditSnapshots({
			diff: diffResult.diff,
			path: absolutePath,
			firstChangedLine: diffResult.firstChangedLine,
			meta,
			oldText: content,
			newText: finalContent,
		}),
	};
}
