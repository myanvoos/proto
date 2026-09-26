import { materializeString } from "@oh-my-pi/pi-utils/materialize-string";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export type PasteResult = { handled: false } | { handled: true; pasteContent?: string; rejected?: true };

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

// Oversized pastes are discarded, never replayed as keys; drain through the terminator.
export const DEFAULT_PASTE_BYTE_LIMIT = 4 * 1024 * 1024;

function stripPasteMarkers(text: string): string {
	return text.replaceAll(PASTE_END, "").replaceAll(PASTE_START, "");
}

export class BracketedPasteHandler {
	#buffer = "";
	#bytes = 0;
	#markerTail = "";
	#overflow = false;
	#active = false;
	readonly #byteLimit: number;

	constructor(options: BracketedPasteHandlerOptions = {}) {
		this.#byteLimit = options.byteLimit ?? DEFAULT_PASTE_BYTE_LIMIT;
		if (!Number.isSafeInteger(this.#byteLimit) || this.#byteLimit < 0) {
			throw new RangeError("Paste byte limit must be a nonnegative safe integer");
		}
	}

	get active(): boolean {
		return this.#active;
	}

	clear(): void {
		this.#buffer = "";
		this.#bytes = 0;
		this.#markerTail = "";
		this.#overflow = false;
		this.#active = false;
	}

	process(data: string): PasteResult {
		if (!this.#active && data.includes(PASTE_START)) {
			this.clear();
			this.#active = true;
			data = data.replace(PASTE_START, "");
		}
		if (!this.#active) return { handled: false };

		const chunk = this.#markerTail + data;
		const ended = chunk.includes(PASTE_END);
		let tailLength = 0;
		if (!ended) {
			for (let length = 1; length < PASTE_END.length; length++) {
				if (chunk.endsWith(PASTE_END.slice(0, length))) tailLength = length;
			}
		}
		this.#markerTail = materializeString(chunk.slice(chunk.length - tailLength));
		let rejected = false;
		if (!this.#overflow) {
			const content = stripPasteMarkers(chunk.slice(0, chunk.length - tailLength));
			const bytes = Buffer.byteLength(content);
			if (bytes > this.#byteLimit - this.#bytes) {
				this.#overflow = true;
				this.#buffer = "";
				this.#bytes = 0;
				rejected = true;
			} else {
				this.#buffer += materializeString(content);
				this.#bytes += bytes;
			}
		}
		if (ended) {
			// Never replay the rest of the terminator's burst as keystrokes.
			const pasteContent = this.#buffer;
			const overflow = this.#overflow;
			this.clear();
			return overflow ? { handled: true, rejected: true } : { handled: true, pasteContent };
		}
		return rejected ? { handled: true, rejected: true } : { handled: true };
	}
}
