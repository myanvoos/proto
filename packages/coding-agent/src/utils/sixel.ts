import { $env, $flag } from "@oh-my-pi/pi-utils";

const SIXEL_START_REGEX = /\x1bP(?:[0-9;]*)q/u;
const SIXEL_END_SEQUENCE = "\x1b\\";
const SIXEL_END_BELL = "\x07";
const SIXEL_SEQUENCE_REGEX = /\x1bP(?:[0-9;]*)q[\s\S]*?(?:\x1b\\|\x07)/gu;
const SIXEL_PLACEHOLDER_PREFIX = "__PROTO_SIXEL_SEQUENCE_";

export function isSixelPassthroughEnabled(): boolean {
	const forcedProtocol = $env.PI_FORCE_IMAGE_PROTOCOL?.trim().toLowerCase();
	return forcedProtocol === "sixel" && $flag("PI_ALLOW_SIXEL_PASSTHROUGH");
}

function containsSixelSequence(text: string): boolean {
	return SIXEL_START_REGEX.test(text);
}

export function getSixelLineMask(lines: string[]): boolean[] {
	let inSequence = false;
	return lines.map(line => {
		const hasStart = containsSixelSequence(line);
		if (hasStart) {
			inSequence = true;
		}
		const isSixelLine = inSequence;
		if (inSequence && (line.includes(SIXEL_END_SEQUENCE) || line.includes(SIXEL_END_BELL))) {
			inSequence = false;
		}
		return isSixelLine;
	});
}

/**
 * Split a trailing incomplete sixel sequence (a DCS introducer with no
 * terminator yet) off `text` so streaming callers can hold it until the next
 * chunk completes the envelope. Returns the renderable text before the
 * introducer and the held tail (empty when nothing is pending).
 */
export function splitIncompleteSixelTail(text: string): { text: string; heldTail: string } {
	const start = text.lastIndexOf("\x1bP");
	if (start === -1) return { text, heldTail: "" };
	const head = text.slice(start);
	const introducer = /^\x1bP(?:[0-9;]*)q/.exec(head);
	if (introducer) {
		const afterIntroducer = head.slice(introducer[0].length);
		if (afterIntroducer.includes(SIXEL_END_SEQUENCE) || afterIntroducer.includes(SIXEL_END_BELL)) {
			return { text, heldTail: "" };
		}
		return { text: text.slice(0, start), heldTail: head };
	}
	if (/^\x1bP[0-9;]*$/.test(head)) {
		// Introducer still accumulating its parameters across the chunk edge.
		return { text: text.slice(0, start), heldTail: head };
	}
	return { text, heldTail: "" };
}

export function sanitizeWithOptionalSixelPassthrough(text: string, sanitize: (text: string) => string): string {
	if (!isSixelPassthroughEnabled() || !containsSixelSequence(text)) {
		return sanitize(text);
	}

	const preservedSequences: string[] = [];
	const tokenized = text.replace(SIXEL_SEQUENCE_REGEX, match => {
		const token = `${SIXEL_PLACEHOLDER_PREFIX}${preservedSequences.length}__`;
		preservedSequences.push(match);
		return token;
	});

	const sanitized = sanitize(tokenized);
	return sanitized.replace(/__PROTO_SIXEL_SEQUENCE_(\d+)__/gu, (_, indexText: string) => {
		const index = Number.parseInt(indexText, 10);
		return preservedSequences[index] ?? "";
	});
}
