import type { Model, ProviderResponseMetadata, RawSseEvent } from "@oh-my-pi/pi-ai";
import { materializeString } from "@oh-my-pi/pi-utils";

const MAX_RAW_SSE_EVENTS = 1_000;
const MAX_RAW_SSE_CHARS = 512_000;
const MAX_RAW_SSE_EVENT_CHARS = 64_000;

const TRIM_MARKER_RESERVE = 200;

const MAX_TOOL_SCHEMA_CHARS = 200;
const MAX_TOOL_DESCRIPTION_CHARS = 200;

type RawSseDebugRecord =
	| {
			kind: "response";
			sequence: number;
			timestamp: number;
			provider?: string;
			model?: string;
			api?: string;
			status: number;
			requestId?: string | null;
			transport?: string;
	  }
	| {
			kind: "event";
			sequence: number;
			timestamp: number;
			provider?: string;
			model?: string;
			api?: string;
			event: string | null;
			raw: string[];
			truncated: boolean;
			originalChars: number;
	  };

interface RawSseDebugSnapshot {
	records: readonly RawSseDebugRecord[];
	droppedRecords: number;
	droppedChars: number;
	totalEvents: number;
	lastUpdatedAt?: number;
}

type TrimResult = { raw: string[]; truncated: boolean; originalChars: number; chars: number };

function countLines(lines: readonly string[]): number {
	let chars = 0;
	for (let i = 0; i < lines.length; i++) chars += lines[i].length + 1;
	return chars;
}

function elideText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

function compactToolEntry(tool: unknown): boolean {
	if (typeof tool !== "object" || tool === null) return false;
	const obj = tool as Record<string, unknown>;
	let changed = false;
	if (typeof obj.function === "object" && obj.function !== null) {
		changed = compactToolEntry(obj.function);
	}
	for (const key of ["parameters", "input_schema"]) {
		const schema = obj[key];
		if (schema === undefined || schema === null) continue;
		const text = typeof schema === "string" ? schema : JSON.stringify(schema);
		if (text.length <= MAX_TOOL_SCHEMA_CHARS) continue;
		obj[key] = elideText(text, MAX_TOOL_SCHEMA_CHARS);
		changed = true;
	}
	if (typeof obj.description === "string" && obj.description.length > MAX_TOOL_DESCRIPTION_CHARS) {
		obj.description = elideText(obj.description, MAX_TOOL_DESCRIPTION_CHARS);
		changed = true;
	}
	return changed;
}

function compactToolsDeep(node: unknown): boolean {
	if (Array.isArray(node)) {
		let changed = false;
		for (const item of node) changed = compactToolsDeep(item) || changed;
		return changed;
	}
	if (typeof node !== "object" || node === null) return false;
	let changed = false;
	const obj = node as Record<string, unknown>;
	for (const key in obj) {
		const value = obj[key];
		if (key === "tools" && Array.isArray(value)) {
			for (const tool of value) changed = compactToolEntry(tool) || changed;
		} else {
			changed = compactToolsDeep(value) || changed;
		}
	}
	return changed;
}

function compactToolLines(raw: readonly string[]): string[] | null {
	let changed = false;
	const out = raw.map(line => {
		if (!line.startsWith("data:") || line.length <= MAX_TOOL_SCHEMA_CHARS) return line;
		const start = line.charCodeAt(5) === 32 ? 6 : 5;
		try {
			const parsed = JSON.parse(line.slice(start));
			if (!compactToolsDeep(parsed)) return line;
			changed = true;
			return `data: ${JSON.stringify(parsed)}`;
		} catch {
			return line;
		}
	});
	return changed ? out : null;
}

function headTailTrim(lines: string[], budget: number, elidedTotal: number): string[] {
	const headBudget = budget >> 1;
	const tailBudget = budget - headBudget;

	let i = 0;
	let headRemaining = headBudget;
	const out: string[] = [];
	while (i < lines.length && lines[i].length + 1 <= headRemaining) {
		headRemaining -= lines[i].length + 1;
		out.push(lines[i]);
		i++;
	}

	let j = lines.length - 1;
	let tailRemaining = tailBudget;
	const tail: string[] = [];
	while (j >= i && lines[j].length + 1 <= tailRemaining) {
		tailRemaining -= lines[j].length + 1;
		tail.push(lines[j]);
		j--;
	}
	tail.reverse();

	let elided = elidedTotal - countLines(out) - countLines(tail);
	if (i <= j) {
		const headSlice = lines[i].slice(0, Math.max(0, headRemaining - 2));
		const tailStart =
			i === j
				? Math.max(headSlice.length, lines[j].length - tailRemaining + 2)
				: Math.max(0, lines[j].length - tailRemaining + 2);
		const tailSlice = lines[j].slice(tailStart);
		elided -= headSlice.length + tailSlice.length;
		if (headSlice.length > 0) out.push(`${headSlice}…`);
		out.push(`: proto-debug-elided chars=${Math.max(0, elided)}`);
		if (tailSlice.length > 0) out.push(`…${tailSlice}`);
	} else if (elided > 0) {
		out.push(`: proto-debug-elided chars=${elided}`);
	}
	out.push(...tail);
	return out;
}

function trimRawLines(raw: string[]): TrimResult {
	const originalChars = countLines(raw);
	if (originalChars <= MAX_RAW_SSE_EVENT_CHARS) {
		return { raw, truncated: false, originalChars, chars: originalChars + 1 };
	}

	const budget = MAX_RAW_SSE_EVENT_CHARS - TRIM_MARKER_RESERVE;
	let lines = compactToolLines(raw) ?? raw;
	const compactedChars = lines === raw ? originalChars : countLines(lines);
	if (compactedChars > budget) {
		lines = headTailTrim(lines, budget, compactedChars);
	} else if (lines === raw) {
		lines = raw.slice();
	}
	lines = lines.map(materializeString);
	lines.push(`: proto-debug-truncated originalChars=${originalChars}`);
	return { raw: lines, truncated: true, originalChars, chars: countLines(lines) + 1 };
}

function formatRawSseIsoTime(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function formatRawSseResponseComment(record: Extract<RawSseDebugRecord, { kind: "response" }>): string {
	const fields = [
		"proto-response",
		`ts=${formatRawSseIsoTime(record.timestamp)}`,
		`status=${record.status}`,
		record.provider ? `provider=${record.provider}` : undefined,
		record.model ? `model=${record.model}` : undefined,
		record.api ? `api=${record.api}` : undefined,
		record.requestId ? `requestId=${record.requestId}` : undefined,
		record.transport ? `transport=${record.transport}` : undefined,
	].filter((field): field is string => field !== undefined);
	return `: ${fields.join(" ")}`;
}

function rawSseRecordLines(record: RawSseDebugRecord): string[] {
	if (record.kind === "response") return [formatRawSseResponseComment(record)];
	return record.raw;
}

function rawRecordText(record: RawSseDebugRecord): string {
	return `${rawSseRecordLines(record).join("\n")}\n`;
}

function metadataTransport(response: ProviderResponseMetadata): string | undefined {
	const value = response.metadata?.lastTransport;
	return typeof value === "string" ? value : undefined;
}

export class RawSseDebugBuffer {
	#records: RawSseDebugRecord[] = [];

	#recordChars: number[] = [];

	#head = 0;
	#totalChars = 0;
	#droppedRecords = 0;
	#droppedChars = 0;
	#totalEvents = 0;
	#lastUpdatedAt: number | undefined;
	#nextSequence = 1;
	#listeners = new Set<() => void>();
	#emitScheduled = false;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	recordResponse(response: ProviderResponseMetadata, model?: Model): void {
		const record: RawSseDebugRecord = {
			kind: "response",
			sequence: this.#nextSequence++,
			timestamp: Date.now(),
			provider: model?.provider,
			model: model?.id,
			api: model?.api,
			status: response.status,
			requestId: response.requestId,
			transport: metadataTransport(response),
		};
		this.#append(record, formatRawSseResponseComment(record).length + 1);
	}

	recordEvent(event: RawSseEvent, model?: Model): void {
		const trimmed = trimRawLines(event.raw);
		this.#totalEvents += 1;
		this.#append(
			{
				kind: "event",
				sequence: this.#nextSequence++,
				timestamp: Date.now(),
				provider: model?.provider,
				model: model?.id,
				api: model?.api,
				event: event.event,
				raw: trimmed.raw,
				truncated: trimmed.truncated,
				originalChars: trimmed.originalChars,
			},
			trimmed.chars,
		);
	}

	snapshot(): RawSseDebugSnapshot {
		return {
			records: this.#records.slice(this.#head),
			droppedRecords: this.#droppedRecords,
			droppedChars: this.#droppedChars,
			totalEvents: this.#totalEvents,
			lastUpdatedAt: this.#lastUpdatedAt,
		};
	}

	toRawText(): string {
		const live = this.#head === 0 ? this.#records : this.#records.slice(this.#head);
		const body = live.map(rawRecordText).join("\n");
		if (this.#droppedRecords === 0) return body;
		const dropped = `: proto-debug-dropped records=${this.#droppedRecords} chars=${this.#droppedChars}\n\n`;
		return body.length > 0 ? `${dropped}${body}` : dropped;
	}

	clear(): void {
		this.#records = [];
		this.#recordChars = [];
		this.#head = 0;
		this.#totalChars = 0;
		this.#droppedRecords = 0;
		this.#droppedChars = 0;
		this.#totalEvents = 0;
		this.#lastUpdatedAt = undefined;
		this.#emit();
	}

	#append(record: RawSseDebugRecord, chars: number): void {
		this.#records.push(record);
		this.#recordChars.push(chars);
		this.#totalChars += chars;
		this.#lastUpdatedAt = record.timestamp;
		this.#enforceLimits();
		this.#emit();
	}

	#enforceLimits(): void {
		while (this.#records.length - this.#head > MAX_RAW_SSE_EVENTS || this.#totalChars > MAX_RAW_SSE_CHARS) {
			if (this.#records.length - this.#head === 0) break;
			const chars = this.#recordChars[this.#head] ?? 0;
			this.#head += 1;
			this.#totalChars = Math.max(0, this.#totalChars - chars);
			this.#droppedRecords += 1;
			this.#droppedChars += chars;
		}

		const liveCount = this.#records.length - this.#head;
		if (this.#head >= MAX_RAW_SSE_EVENTS || this.#head > liveCount) {
			this.#records = this.#records.slice(this.#head);
			this.#recordChars = this.#recordChars.slice(this.#head);
			this.#head = 0;
		}
	}

	#emit(): void {
		const count = this.#listeners.size;
		if (count === 0) return;

		if (count === 1) {
			this.#fanOut();
			return;
		}
		if (this.#emitScheduled) return;
		this.#emitScheduled = true;
		queueMicrotask(() => {
			this.#emitScheduled = false;
			this.#fanOut();
		});
	}

	#fanOut(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {}
		}
	}
}
