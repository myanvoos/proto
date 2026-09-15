import { htmlToBasicMarkdown } from "../../web/scrapers/types";

export interface PythonStatusEvent {
	op: string;

	[key: string]: unknown;
}

export type KernelDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "markdown"; text: string }
	| { type: "status"; event: PythonStatusEvent };

function normalizeDisplayText(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

export async function renderKernelDisplay(content: Record<string, unknown>): Promise<{
	text: string;
	outputs: KernelDisplayOutput[];
}> {
	const data =
		(content.data as Record<string, unknown> | undefined) ?? (content as Record<string, unknown> | undefined);
	if (!data) return { text: "", outputs: [] };

	const outputs: KernelDisplayOutput[] = [];

	if (isStatusBundle(data)) {
		const statusData = data["application/x-proto-status"];
		if (statusData && typeof statusData === "object" && "op" in statusData) {
			outputs.push({ type: "status", event: statusData as PythonStatusEvent });
		}
		return { text: "", outputs };
	}

	// A MIME bundle's image entries are alternatives for the same render, not
	// independent displays; prefer PNG and skip the JPEG duplicate.
	if (typeof data["image/png"] === "string") {
		outputs.push({ type: "image", data: data["image/png"] as string, mimeType: "image/png" });
	} else if (typeof data["image/jpeg"] === "string") {
		outputs.push({ type: "image", data: data["image/jpeg"] as string, mimeType: "image/jpeg" });
	}
	const hasJson = data["application/json"] !== undefined;
	if (hasJson) {
		outputs.push({ type: "json", data: data["application/json"] });
	}

	// JSON is the canonical model-visible representation. Keep text/plain in
	// the bundle for TUI consumers, but do not return it as a second text chunk.
	if (hasJson) return { text: "", outputs };

	if (typeof data["text/markdown"] === "string") {
		// Markdown rides the model-visible text leg only: pushing a block here
		// duplicates it in the card, the session file, and the next prompt.
		const markdown = normalizeDisplayText(String(data["text/markdown"]));
		return { text: markdown, outputs };
	}
	if (typeof data["text/plain"] === "string") {
		return { text: normalizeDisplayText(String(data["text/plain"])), outputs };
	}
	if (data["text/html"] !== undefined) {
		const markdown = (await htmlToBasicMarkdown(String(data["text/html"]))) || "";
		return { text: markdown ? normalizeDisplayText(markdown) : "", outputs };
	}
	return { text: "", outputs };
}

/**
 * Normalized rich-display presentation block persisted with a python
 * execution. Text/markdown/json are pre-serialized strings; images keep raw
 * base64 data so the TUI can render them and the model can see them again on
 * replay. Status events are control-plane and never persisted here.
 */
export type PythonDisplayOutput =
	| { type: "text"; text: string }
	| { type: "markdown"; text: string }
	| { type: "json"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "notice"; text: string };

export const PYTHON_STATUS_OUTPUT_MARKER = "application/x-proto-status";

// Rich-presentation normalization limits. Images above the pre-decode cap are
// rejected with a notice rather than silently dropped; the total persisted
// budget bounds session-file growth.
export const PYTHON_DISPLAY_MAX_BLOCKS = 64;
export const PYTHON_DISPLAY_MAX_IMAGES = 8;
export const PYTHON_DISPLAY_MAX_BLOCK_TEXT = 64 * 1024;
export const PYTHON_DISPLAY_MAX_TOTAL_TEXT = 256 * 1024;
export const PYTHON_DISPLAY_MAX_PERSISTED_BYTES = 4 * 1024 * 1024;
export const PYTHON_DISPLAY_MAX_IMAGE_DECODE_BYTES = 20 * 1024 * 1024;

/**
 * Normalize one live-streamed kernel display output into its persisted
 * presentation block; undefined means the output is control-plane data and
 * should not reach presentation.
 */
export function normalizeKernelDisplayOutput(output: KernelDisplayOutput): PythonDisplayOutput | undefined {
	if (output.type === "status") return undefined;
	if (output.type === "image") {
		if (output.data.length > (PYTHON_DISPLAY_MAX_IMAGE_DECODE_BYTES / 3) * 4) {
			return { type: "notice", text: "display image rejected: larger than 20 MiB decoded" };
		}
		return { type: "image", data: output.data, mimeType: output.mimeType };
	}
	if (output.type === "json") {
		try {
			return { type: "json", text: JSON.stringify(output.data, null, "\t") ?? "null" };
		} catch {
			return { type: "notice", text: "display JSON dropped: not serializable" };
		}
	}
	// Markdown kernel outputs already stream through the model-visible text
	// leg (onChunk); a display block would duplicate them live, persisted,
	// and in the next prompt.
	return undefined;
}

/**
 * Normalize kernel display outputs into persistable presentation blocks:
 * control-plane status events are dropped, JSON is pre-serialized (guarded
 * against cycles), oversized images become notices, and the whole set is
 * bounded so one display() cannot bloat the session file.
 */
export function normalizePythonDisplayOutputs(
	outputs: readonly KernelDisplayOutput[] | undefined,
): PythonDisplayOutput[] {
	const budget = new PythonDisplayBudget();
	for (const output of outputs ?? []) {
		if (output.type === "markdown") {
			// Markdown lives on the model-visible text leg; persisting a block
			// would duplicate it (see normalizeKernelDisplayOutput).
			continue;
		}
		budget.addKernelOutput(output);
	}
	return budget.blocks;
}

/**
 * Single admission gate for rich-display blocks, shared by the live card
 * stream and batch persistence so both paths enforce identical caps with
 * identical accounting. The persistence budget is measured against the
 * actual JSON-serialized size, not pre-encoding character counts.
 */
export class PythonDisplayBudget {
	readonly blocks: PythonDisplayOutput[] = [];
	#images = 0;
	#textBytes = 0;
	// JSON-array serialization overhead: 2 for the enclosing brackets plus one
	// comma per additional block, so the accounting matches the final
	// JSON.stringify(blocks) byte-for-byte.
	#persistedBytes = 2;

	addKernelOutput(output: KernelDisplayOutput): void {
		if (output.type === "status" || output.type === "markdown") return;
		if (output.type === "image") {
			this.add({ type: "image", data: output.data, mimeType: output.mimeType });
			return;
		}
		let text: string;
		try {
			text = JSON.stringify(output.data, null, "\t") ?? "null";
		} catch {
			this.#appendNotice("display JSON dropped: not serializable");
			return;
		}
		this.add({ type: "json", text });
	}

	add(block: PythonDisplayOutput): boolean {
		if (this.blocks.length >= PYTHON_DISPLAY_MAX_BLOCKS) {
			// The block list is full: recording a notice would itself exceed
			// the cap, so the truncation state is left as-is.
			return false;
		}
		if (block.type === "image") {
			if (this.#images >= PYTHON_DISPLAY_MAX_IMAGES) {
				this.#appendNotice(`display truncated at ${PYTHON_DISPLAY_MAX_IMAGES} images`);
				return false;
			}
			// Base64 length is a 4/3 proxy for decoded bytes.
			if (block.data.length > (PYTHON_DISPLAY_MAX_IMAGE_DECODE_BYTES / 3) * 4) {
				this.#appendNotice("display image rejected: larger than 20 MiB decoded");
				return false;
			}
		}
		let accepted = block;
		if (
			(block.type === "text" || block.type === "markdown" || block.type === "json") &&
			Buffer.byteLength(block.text) > PYTHON_DISPLAY_MAX_BLOCK_TEXT
		) {
			// Clip on UTF-8 byte budget: the suffix must fit inside the limit,
			// and the cut may not split a code point.
			const suffix = `\n… [${Buffer.byteLength(block.text) - PYTHON_DISPLAY_MAX_BLOCK_TEXT} bytes omitted]`;
			const bytes = Buffer.from(block.text, "utf8");
			const limit = PYTHON_DISPLAY_MAX_BLOCK_TEXT - Buffer.byteLength(suffix);
			let end = limit;
			while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
			accepted = { ...block, text: `${bytes.subarray(0, end).toString("utf8")}${suffix}` };
		}
		const bytes = Buffer.byteLength(JSON.stringify(accepted)) + (this.blocks.length > 0 ? 1 : 0);
		if (bytes > PYTHON_DISPLAY_MAX_PERSISTED_BYTES - this.#persistedBytes) {
			this.#appendNotice("display output truncated: 4 MiB persistence budget exceeded");
			return false;
		}
		if (accepted.type === "text" || accepted.type === "markdown" || accepted.type === "json") {
			if (this.#textBytes + accepted.text.length > PYTHON_DISPLAY_MAX_TOTAL_TEXT) {
				this.#appendNotice("display text truncated: 256 KiB total cap exceeded");
				return false;
			}
			this.#textBytes += accepted.text.length;
		}
		this.blocks.push(accepted);
		this.#persistedBytes += bytes;
		if (accepted.type === "image") this.#images++;
		return true;
	}

	/** Hydrate already-persisted blocks (they were capped when written). */
	adopt(existing: readonly PythonDisplayOutput[]): void {
		for (const block of existing) {
			this.blocks.push(block);
			if (block.type === "image") this.#images++;
			if (block.type === "text" || block.type === "markdown" || block.type === "json") {
				this.#textBytes += block.text.length;
			}
		}
		// Exact serialized size computed once, including array structure.
		this.#persistedBytes = Buffer.byteLength(JSON.stringify(existing));
	}

	#appendNotice(text: string): void {
		if (this.blocks.length >= PYTHON_DISPLAY_MAX_BLOCKS) return;
		if (this.blocks[this.blocks.length - 1]?.type === "notice") return;
		// Notices are metadata: they bypass add()'s caps but must still fit
		// the persistence budget, or a rejection would push the serialized
		// output past the limit it exists to enforce.
		const notice = { type: "notice", text } as const;
		const size = Buffer.byteLength(JSON.stringify(notice)) + (this.blocks.length > 0 ? 1 : 0);
		if (size > PYTHON_DISPLAY_MAX_PERSISTED_BYTES - this.#persistedBytes) return;
		this.#persistedBytes += size;
		this.blocks.push(notice);
	}
}

function isStatusBundle(data: unknown): boolean {
	return typeof data === "object" && data !== null && PYTHON_STATUS_OUTPUT_MARKER in (data as Record<string, unknown>);
}
