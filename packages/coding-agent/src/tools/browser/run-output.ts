import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { JsDisplayOutput } from "../../eval/js/shared/types";

export class RunOutput {
	readonly #displays: Array<TextContent | ImageContent> = [];
	#textBuffer = "";

	pushText(chunk: string): void {
		this.#textBuffer += chunk;
	}

	pushDisplay(output: JsDisplayOutput): void {
		if (output.type === "image") {
			this.push({ type: "image", data: output.data, mimeType: output.mimeType });
			return;
		}
		if (output.type === "json") {
			this.push({ type: "text", text: safeJsonStringify(output.data) });
			return;
		}

		this.push({ type: "text", text: safeJsonStringify(output.event) });
	}

	push(entry: TextContent | ImageContent): void {
		this.#flush();
		this.#displays.push(entry);
	}

	finish(): Array<TextContent | ImageContent> {
		this.#flush();
		return this.#displays;
	}

	#flush(): void {
		if (!this.#textBuffer) return;

		this.#displays.push({ type: "text", text: this.#textBuffer.replace(/\n$/, "") });
		this.#textBuffer = "";
	}
}

export function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function cloneSafe(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		structuredClone(value);
		return value;
	} catch {}
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {}
	return String(value);
}
