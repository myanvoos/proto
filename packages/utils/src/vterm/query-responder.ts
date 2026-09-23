/**
 * Answers terminal capability queries emitted by programs on a headless PTY.
 *
 * A PTY advertising `TERM=xterm-256color` with no terminal behind it leaves probes unanswered: the program writes a
 * query escape and blocks on stdin until its timeout, seconds later. This scanner watches raw output for the standard
 * queries and returns the bytes an xterm-class terminal would send back. It keeps no screen state (cursor reports
 * answer the home position), so it is cheap enough for every byte of a long-lived process. A query split across
 * chunks completes on the next {@link feed}.
 */
export class TerminalQueryResponder {
	#residual = "";

	/** Feed one raw output chunk; returns the reply bytes to write back into the PTY, or "". */
	feed(chunk: string): string {
		const buffer = this.#residual + chunk;
		let replies = "";
		let lastEnd = 0;
		QUERY.lastIndex = 0;
		for (let match = QUERY.exec(buffer); match !== null; match = QUERY.exec(buffer)) {
			lastEnd = match.index + match[0].length;
			replies += replyFor(match);
		}
		// Carry only a short unmatched trailing escape: a long tail is output that can never become a query.
		const tailEscape = buffer.lastIndexOf("\x1b");
		this.#residual =
			tailEscape >= lastEnd && buffer.length - tailEscape <= MAX_PARTIAL_QUERY ? buffer.slice(tailEscape) : "";
		return replies;
	}
}

const MAX_PARTIAL_QUERY = 32;

// CSI DSR/DA queries (final `n` or `c`) and OSC 10/11 color queries; only forms with canned answers match.
const QUERY = /\x1b\[([?>=]?)([0-9;]*)([nc])|\x1b\](10|11);\?(\x07|\x1b\\)/gu;

function replyFor(match: RegExpExecArray): string {
	const final = match[3];
	if (final !== undefined) {
		const intermediate = match[1];
		const params = match[2] ?? "";
		if (final === "c") {
			if (intermediate === ">") return "\x1b[>0;10;1c"; // secondary DA: VT100-class, firmware 10
			if (intermediate === "" || intermediate === "0") return "\x1b[?1;2c"; // primary DA: VT100 with AVO
			return ""; // tertiary (`=`) DA has no widely expected reply
		}
		if (intermediate !== "") return ""; // private DSR forms (DECXCPR, appearance) stay unanswered
		const selector = params.split(";", 1)[0];
		if (selector === "6") return "\x1b[1;1R"; // cursor position: home, there is no screen
		if (selector === "5") return "\x1b[0n"; // device status: OK
		return "";
	}
	const terminator = match[5] ?? "\x07";
	if (match[4] === "10") return `\x1b]10;rgb:ffff/ffff/ffff${terminator}`; // foreground
	if (match[4] === "11") return `\x1b]11;rgb:0000/0000/0000${terminator}`; // background
	return "";
}
