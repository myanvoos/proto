import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { JsDisplayOutput } from "../../eval/js/shared/types";
import { PythonDisplayBudget } from "../../eval/py/display";
import { DEFAULT_MAX_BYTES, OutputSink, TailBuffer } from "../../session/streaming-output";

/** Output admission happens inside the worker, before IPC or retained run results. */
export class RunOutput {
	readonly #budget = new PythonDisplayBudget();
	readonly #sink: OutputSink;
	#textBuffer = new TailBuffer(DEFAULT_MAX_BYTES);

	constructor(artifact?: { path?: string; id?: string }) {
		this.#sink = new OutputSink({
			artifactPath: artifact?.path,
			artifactId: artifact?.id,
			headBytes: DEFAULT_MAX_BYTES / 2,
		});
	}

	pushText(chunk: string): void {
		this.#sink.push(chunk);
		this.#textBuffer.append(chunk);
	}

	pushDisplay(output: JsDisplayOutput): void {
		// Status events (kernel-state, log/phase, file tracking) steer the host; they are never run output.
		if (output.type === "status") return;
		if (output.type === "image") {
			this.push(output);
			return;
		}
		this.push({ type: "text", text: output.type === "json" ? safeJsonStringify(output.data) : output.text });
	}

	push(entry: TextContent | ImageContent): void {
		this.#flush();
		if (entry.type === "text")
			this.#sink.push(`${entry.text}
`);
		this.#budget.add(entry);
	}

	retainedBytes(): number {
		return this.#sink.retainedBytes() + this.#budget.retainedBytes() + this.#textBuffer.bytes();
	}

	/** Screenshot paths and return values share the aggregate rich-output budget. */
	admitMetadata<T>(value: T): T | undefined {
		return this.#budget.admitMetadata(value);
	}

	async finish(value?: unknown): Promise<{ displays: Array<TextContent | ImageContent>; returnValue: unknown }> {
		this.#flush();
		const returnText = typeof value === "string" ? value : safeJsonStringify(value);
		if (value !== undefined) this.#sink.push(`${returnText}\n`);
		const summary = await this.#sink.dump();
		let returnValue = summary.truncated ? undefined : this.#budget.admitMetadata(value);
		if (
			!summary.truncated &&
			value !== undefined &&
			(returnValue === undefined || (typeof value !== "string" && typeof returnValue === "string"))
		) {
			// Preserve the tool's text rendering of non-JSON values without sending
			// a raw clone whose JSON representation could conceal retained payloads.
			returnValue = this.#budget.admitMetadata(returnText);
		}
		const displays: Array<TextContent | ImageContent> = this.#budget.blocks
			.filter(block => !summary.truncated || block.type === "image" || block.type === "notice")
			.map(block => (block.type === "image" ? block : { type: "text", text: block.text }));
		if (summary.truncated) {
			const artifact = summary.artifactId
				? `; raw output: artifact://${summary.artifactId}`
				: "; no output artifact available";
			displays.push({
				type: "text",
				text: `${summary.output}
[Output truncated: showing ${summary.outputBytes} of ${summary.totalBytes} bytes${artifact}]`,
			});
		}
		await this.dispose();
		return { displays, returnValue };
	}

	async dispose(): Promise<void> {
		await this.#sink.dispose();
		this.#sink.release();
		this.#budget.release();
		this.#textBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
	}

	#flush(): void {
		const text = this.#textBuffer.text();
		if (!text) return;
		this.#budget.add({ type: "text", text: text.replace(/\n$/, "") });
		this.#textBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
	}
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
