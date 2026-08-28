const OPENER_LINE = /^ {0,3}`{3,}(?:thinking|reasoning)[ \t]*\r?$/i;

function couldBeOpenerPrefix(line: string): boolean {
	const s = line.endsWith("\r") ? line.slice(0, -1) : line;
	const m = /^ {0,3}(`*)([\s\S]*)$/.exec(s);
	if (!m) return false;
	const ticks = m[1]!.length;
	const rest = m[2]!;
	if (rest === "") return true;
	if (ticks < 3) return false;
	const word = rest.replace(/[ \t]+$/, "").toLowerCase();
	return "thinking".startsWith(word) || "reasoning".startsWith(word);
}

export class ThinkingFenceStripper {
	#carry = "";

	#passthrough = false;

	push(chunk: string): string {
		let out = "";
		for (const ch of chunk) {
			if (this.#passthrough) {
				out += ch;
				if (ch === "\n") this.#passthrough = false;
				continue;
			}
			if (ch === "\n") {
				if (!OPENER_LINE.test(this.#carry)) out += `${this.#carry}\n`;
				this.#carry = "";
				continue;
			}
			this.#carry += ch;
			if (!couldBeOpenerPrefix(this.#carry)) {
				out += this.#carry;
				this.#carry = "";
				this.#passthrough = true;
			}
		}
		return out;
	}

	flush(): string {
		const carry = this.#carry;
		this.#carry = "";
		this.#passthrough = false;
		return OPENER_LINE.test(carry) ? "" : carry;
	}
}
