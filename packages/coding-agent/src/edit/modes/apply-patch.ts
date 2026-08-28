import { type } from "@oh-my-pi/omptype";
import { parseApplyPatch, parseApplyPatchStreaming } from "../apply-patch/parser";
import { ApplyPatchError } from "../diff";
import type { PatchEditEntry } from "./patch";

export const applyPatchSchema = type({
	input: "string",
});

export type ApplyPatchParams = typeof applyPatchSchema.infer;

export type ApplyPatchEntry = PatchEditEntry & { path: string };

export function expandApplyPatchToEntries(params: ApplyPatchParams): ApplyPatchEntry[] {
	const hunks = parseApplyPatch(params.input);
	if (hunks.length === 0) {
		throw new ApplyPatchError("No files were modified.");
	}
	return hunks.map(
		(h): ApplyPatchEntry => ({
			path: h.path,
			op: h.op,
			rename: h.rename,
			diff: h.diff,
		}),
	);
}

export function expandApplyPatchToPreviewEntries(params: ApplyPatchParams): ApplyPatchEntry[] {
	const hunks = parseApplyPatchStreaming(params.input);
	return hunks.map(
		(h): ApplyPatchEntry => ({
			path: h.path,
			op: h.op,
			rename: h.rename,
			diff: h.diff,
		}),
	);
}
