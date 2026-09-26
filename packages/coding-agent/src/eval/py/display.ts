import { truncateHeadBytes } from "@oh-my-pi/pi-utils/bytes";
import { materializeString } from "@oh-my-pi/pi-utils/materialize-string";
import { htmlToBasicMarkdown } from "../../web/scrapers/types";

export interface PythonStatusEvent {
	op: string;

	[key: string]: unknown;
}

export type KernelDisplayOutput =
	| { type: "text"; text: string }
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "markdown"; text: string }
	| { type: "notice"; text: string }
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
	if (output.type === "notice" || output.type === "text" || output.type === "markdown") return output;
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
	for (const output of outputs ?? []) budget.addKernelOutput(output);
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
	#blockCount = 0;
	#persistedBytes = 2;
	#retainedBytes = 0;
	#metadataCount = 0;
	readonly #metadataSnapshots = new Map<string, number>();
	#lastWasNotice = false;

	/** Only bounded, detached values leave the admission gate. */
	addKernelOutput(output: KernelDisplayOutput): KernelDisplayOutput[] {
		if (output.type === "status") return [];
		const previous = this.blocks.at(-1);
		if (this.#blockCount >= PYTHON_DISPLAY_MAX_BLOCKS) {
			this.#appendNotice(`display truncated at ${PYTHON_DISPLAY_MAX_BLOCKS} blocks`);
		} else {
			const block = normalizeKernelDisplayOutput(output);
			if (block) this.add(block);
		}
		const accepted = this.blocks.at(-1);
		return accepted && accepted !== previous ? [kernelOutputFromBlock(accepted)] : [];
	}

	kernelOutputs(): KernelDisplayOutput[] {
		return this.blocks.map(kernelOutputFromBlock);
	}

	retainedBytes(): number {
		return this.#retainedBytes;
	}

	/** Drop payloads without reopening this run's lifetime admission budget. */
	release(): void {
		this.blocks.length = 0;
		this.#retainedBytes = 0;
		this.#metadataSnapshots.clear();
	}

	/** Metadata shares display bytes; keyed snapshots replace their prior count/charge atomically. */
	admitMetadata<T>(value: T, key?: string): T | undefined {
		if (value === undefined) return undefined;
		const previousBytes = key === undefined ? undefined : this.#metadataSnapshots.get(key);
		if (previousBytes === undefined && this.#metadataCount >= PYTHON_DISPLAY_MAX_BLOCKS) {
			this.#appendNotice(`display metadata truncated at ${PYTHON_DISPLAY_MAX_BLOCKS} entries`);
			return undefined;
		}
		let text: string | undefined;
		try {
			text = JSON.stringify(value);
		} catch {
			this.#appendNotice("display metadata dropped: not serializable");
			return undefined;
		}
		if (text === undefined) return undefined;
		const bytes = Buffer.byteLength(text);
		const notice = "display metadata truncated: 4 MiB persistence budget exceeded";
		const noticeBytes = Buffer.byteLength(JSON.stringify({ type: "notice", text: notice })) + 1;
		if (bytes + noticeBytes > PYTHON_DISPLAY_MAX_PERSISTED_BYTES - this.#persistedBytes + (previousBytes ?? 0)) {
			this.#appendNotice(notice);
			return undefined;
		}
		if (previousBytes === undefined) this.#metadataCount++;
		this.#persistedBytes += bytes - (previousBytes ?? 0);
		this.#retainedBytes += bytes - (previousBytes ?? 0);
		if (key !== undefined) this.#metadataSnapshots.set(key, bytes);
		return JSON.parse(text) as T;
	}

	add(block: PythonDisplayOutput): boolean {
		if (this.#blockCount >= PYTHON_DISPLAY_MAX_BLOCKS) {
			this.#appendNotice(`display truncated at ${PYTHON_DISPLAY_MAX_BLOCKS} blocks`);
			return false;
		}
		if (block.type === "image") {
			if (this.#images >= PYTHON_DISPLAY_MAX_IMAGES) {
				this.#appendNotice(`display truncated at ${PYTHON_DISPLAY_MAX_IMAGES} images`);
				return false;
			}
			if (block.data.length > (PYTHON_DISPLAY_MAX_IMAGE_DECODE_BYTES / 3) * 4) {
				this.#appendNotice("display image rejected: larger than 20 MiB decoded");
				return false;
			}
		}
		let accepted = block;
		if (block.type !== "image") {
			const textBytes = Buffer.byteLength(block.text);
			if (textBytes > PYTHON_DISPLAY_MAX_BLOCK_TEXT) {
				const suffix = `\n… [${textBytes - PYTHON_DISPLAY_MAX_BLOCK_TEXT} bytes omitted]`;
				const prefix = truncateHeadBytes(block.text, PYTHON_DISPLAY_MAX_BLOCK_TEXT - Buffer.byteLength(suffix));
				accepted = { ...block, text: `${prefix.text}${suffix}` };
			}
		}
		const bytes = Buffer.byteLength(JSON.stringify(accepted)) + (this.#blockCount > 0 ? 1 : 0);
		if (bytes > PYTHON_DISPLAY_MAX_PERSISTED_BYTES - this.#persistedBytes) {
			this.#appendNotice("display output truncated: 4 MiB persistence budget exceeded");
			return false;
		}
		if (accepted.type !== "image") {
			const textBytes = Buffer.byteLength(accepted.text);
			if (this.#textBytes + textBytes > PYTHON_DISPLAY_MAX_TOTAL_TEXT) {
				this.#appendNotice("display text truncated: 256 KiB total cap exceeded");
				return false;
			}
			this.#textBytes += textBytes;
		}
		accepted =
			accepted.type === "image"
				? { ...accepted, data: materializeString(accepted.data) }
				: { ...accepted, text: materializeString(accepted.text) };
		this.blocks.push(accepted);
		this.#lastWasNotice = accepted.type === "notice";
		this.#blockCount++;
		this.#persistedBytes += bytes;
		this.#retainedBytes += bytes;
		if (accepted.type === "image") this.#images++;
		return true;
	}

	/** Hydrate persisted blocks through the same admission gate as live output. */
	adopt(existing: readonly PythonDisplayOutput[]): void {
		for (const block of existing) this.add(block);
	}

	#appendNotice(text: string): void {
		if (this.#lastWasNotice) return;
		this.#lastWasNotice = true;
		const notice = { type: "notice", text } as const;
		const size = Buffer.byteLength(JSON.stringify(notice)) + 1;
		// Keep a visible rejection even when the final accepted block filled the
		// budget. Replacing that block never admits another unbounded payload.
		while (
			this.blocks.length > 0 &&
			(this.blocks.length >= PYTHON_DISPLAY_MAX_BLOCKS ||
				size > PYTHON_DISPLAY_MAX_PERSISTED_BYTES - this.#persistedBytes)
		) {
			const removed = this.blocks.pop()!;
			const bytes = Buffer.byteLength(JSON.stringify(removed)) + 1;
			this.#persistedBytes -= bytes;
			this.#retainedBytes -= bytes;
		}
		if (size > PYTHON_DISPLAY_MAX_PERSISTED_BYTES - this.#persistedBytes) return;
		this.#persistedBytes += size;
		this.#retainedBytes += size;
		this.#blockCount++;
		this.blocks.push(notice);
	}
}

function kernelOutputFromBlock(block: PythonDisplayOutput): KernelDisplayOutput {
	if (block.type !== "json") return block;
	try {
		return { type: "json", data: JSON.parse(block.text) };
	} catch {
		// A clipped JSON rendering is text, never a malformed structured value.
		return { type: "notice", text: block.text };
	}
}

function isStatusBundle(data: unknown): boolean {
	return typeof data === "object" && data !== null && PYTHON_STATUS_OUTPUT_MARKER in (data as Record<string, unknown>);
}
