const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export type PasteResult = { handled: false } | { handled: true; pasteContent?: string; remaining: string };

const REENCODED_CTRL_CSI_U = /\x1b\[(\d+);5u/g;
const REENCODED_CTRL_XTERM = /\x1b\[27;5;(\d+)~/g;

function decodeReencodedCtrlByte(match: string, code: string): string {
	const cp = Number(code);
	if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
	if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
	return match;
}

export function decodeReencodedPasteControls(text: string): string {
	return text
		.replace(REENCODED_CTRL_CSI_U, decodeReencodedCtrlByte)
		.replace(REENCODED_CTRL_XTERM, decodeReencodedCtrlByte);
}

export type BracketedPasteHandlerOptions = {
	byteLimit?: number;
};

const DEFAULT_BYTE_LIMIT = 64 * 1024 * 1024;

export class BracketedPasteHandler {
	#buffer = "";
	#active = false;
	readonly #byteLimit: number;

	constructor(options: BracketedPasteHandlerOptions = {}) {
		this.#byteLimit = options.byteLimit ?? DEFAULT_BYTE_LIMIT;
	}

	clear(): void {
		this.#buffer = "";
		this.#active = false;
	}

	process(data: string): PasteResult {
		if (data.includes(PASTE_START)) {
			this.#active = true;
			this.#buffer = "";
			data = data.replace(PASTE_START, "");
		}

		if (!this.#active) return { handled: false };

		this.#buffer += data;

		const endIndex = this.#buffer.indexOf(PASTE_END);
		if (endIndex !== -1) {
			const pasteContent = this.#buffer.substring(0, endIndex);
			const remaining = this.#buffer.substring(endIndex + PASTE_END.length);

			this.#buffer = "";
			this.#active = false;

			return { handled: true, pasteContent, remaining };
		}

		if (this.#buffer.length > this.#byteLimit) {
			const pasteContent = this.#buffer;
			this.#buffer = "";
			this.#active = false;
			return { handled: true, pasteContent, remaining: "" };
		}

		return { handled: true, remaining: "" };
	}
}
