import { $env, $flag } from "@oh-my-pi/pi-utils";

const SIXEL_START_REGEX = /\x1bP(?:[0-9;]*)q/u;
const SIXEL_END_SEQUENCE = "\x1b\\";
const SIXEL_END_BELL = "\x07";
// Some terminals terminate DCS with the C1 ST (0x9c).
const SIXEL_END_C1_ST = "\x9c";
const SIXEL_END_REGEX_SOURCE = "(?:\\x1b\\\\|\\x07|\\u009c)";
const SIXEL_SEQUENCE_REGEX = new RegExp(`\\x1bP(?:[0-9;]*)q[\\s\\S]*?${SIXEL_END_REGEX_SOURCE}`, "gu");
const SIXEL_MARKER_CODEPOINTS = /[\uE000\uE001]/gu;
const SIXEL_PLACEHOLDER_SUFFIX = "\uE001";
const SIXEL_PLACEHOLDER_RESIDUE_REGEX = /\uE000[^\uE001]*(?:\uE001|$)|\uE001/gu;

export interface SixelTextPart {
	text: string;
	isSixel: boolean;
}

export function isSixelPassthroughEnabled(): boolean {
	const forcedProtocol = $env.PI_FORCE_IMAGE_PROTOCOL?.trim().toLowerCase();
	return forcedProtocol === "sixel" && $flag("PI_ALLOW_SIXEL_PASSTHROUGH");
}

function containsSixelSequence(text: string): boolean {
	return SIXEL_START_REGEX.test(text);
}

function sixelSequenceEnds(text: string): boolean {
	return text.includes(SIXEL_END_SEQUENCE) || text.includes(SIXEL_END_BELL) || text.includes(SIXEL_END_C1_ST);
}

export function getSixelLineMask(lines: string[]): boolean[] {
	let inSequence = false;
	return lines.map(line => {
		const hasStart = containsSixelSequence(line);
		if (hasStart) {
			inSequence = true;
		}
		const isSixelLine = inSequence;
		if (inSequence && sixelSequenceEnds(line)) {
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
	if (start !== -1) {
		const head = text.slice(start);
		const introducer = /^\x1bP(?:[0-9;]*)q/u.exec(head);
		if (introducer) {
			const afterIntroducer = head.slice(introducer[0].length);
			if (sixelSequenceEnds(afterIntroducer)) {
				if (text.endsWith("\x1b")) return { text: text.slice(0, -1), heldTail: "\x1b" };
				return { text, heldTail: "" };
			}
			return { text: text.slice(0, start), heldTail: head };
		}
		if (/^\x1bP[0-9;]*$/u.test(head)) {
			// Introducer still accumulating its parameters across the chunk edge.
			return { text: text.slice(0, start), heldTail: head };
		}
	}

	// A trailing ESC may be the first byte of the DCS introducer (or the first
	// byte of its ST terminator). Keep it until the next chunk disambiguates it.
	if (text.endsWith("\x1b")) {
		return { text: text.slice(0, -1), heldTail: "\x1b" };
	}

	return { text, heldTail: "" };
}

/** Return complete sixel envelopes as atomic parts for column capping. */
export function splitSixelSequences(text: string): SixelTextPart[] {
	const parts: SixelTextPart[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf("\x1bP", cursor);
		if (start === -1) break;
		const introducer = /^\x1bP(?:[0-9;]*)q/u.exec(text.slice(start));
		if (!introducer) {
			const ordinaryEnd = start + 2;
			if (ordinaryEnd > cursor) parts.push({ text: text.slice(cursor, ordinaryEnd), isSixel: false });
			cursor = ordinaryEnd;
			continue;
		}
		const payloadStart = start + introducer[0].length;
		const escEnd = text.indexOf(SIXEL_END_SEQUENCE, payloadStart);
		const bellEnd = text.indexOf(SIXEL_END_BELL, payloadStart);
		const c1End = text.indexOf(SIXEL_END_C1_ST, payloadStart);
		const endCandidates: Array<{ index: number; length: number }> = [
			{ index: escEnd, length: SIXEL_END_SEQUENCE.length },
			{ index: bellEnd, length: SIXEL_END_BELL.length },
			{ index: c1End, length: SIXEL_END_C1_ST.length },
		].filter(candidate => candidate.index >= 0);
		if (endCandidates.length === 0) {
			if (start > cursor) parts.push({ text: text.slice(cursor, start), isSixel: false });
			parts.push({ text: text.slice(start), isSixel: false });
			return parts;
		}
		const endCandidate = endCandidates.reduce((earliest, candidate) =>
			candidate.index < earliest.index ? candidate : earliest,
		);
		const end = endCandidate.index + endCandidate.length;
		if (start > cursor) parts.push({ text: text.slice(cursor, start), isSixel: false });
		parts.push({ text: text.slice(start, end), isSixel: true });
		cursor = end;
	}
	if (cursor < text.length) parts.push({ text: text.slice(cursor), isSixel: false });
	return parts;
}

export function sanitizeWithOptionalSixelPassthrough(text: string, sanitize: (text: string) => string): string {
	if (!isSixelPassthroughEnabled() || !containsSixelSequence(text)) {
		return sanitize(text);
	}

	const preservedSequences: string[] = [];
	// PUA code points are valid ordinary output. Neutralize them before marker
	// insertion so a user's text cannot impersonate a preserved envelope.
	const markerSafeText = text.replace(SIXEL_MARKER_CODEPOINTS, "");
	const placeholderPrefix = `\uE000PROTO_SIXEL_${crypto.randomUUID().replaceAll("-", "")}_`;
	const placeholderBodyPrefix = placeholderPrefix.slice(1);
	const placeholderResidueRegex = new RegExp(`${placeholderBodyPrefix}\\d*${SIXEL_PLACEHOLDER_SUFFIX}?`, "gu");
	const sequenceRegex = new RegExp(SIXEL_SEQUENCE_REGEX.source, SIXEL_SEQUENCE_REGEX.flags);
	const tokenized = markerSafeText.replace(sequenceRegex, match => {
		const token = `${placeholderPrefix}${preservedSequences.length}${SIXEL_PLACEHOLDER_SUFFIX}`;
		preservedSequences.push(match);
		return token;
	});

	const sanitized = sanitize(tokenized);
	// Sanitization/truncation downstream may have clipped a placeholder:
	// restore complete tokens, then remove any partial-token fragments so no
	// marker text or half a preserved envelope reaches output.
	return sanitized
		.replace(new RegExp(`${placeholderPrefix}(\\d+)${SIXEL_PLACEHOLDER_SUFFIX}`, "gu"), (_, indexText: string) => {
			const index = Number.parseInt(indexText, 10);
			return preservedSequences[index] ?? "";
		})
		.replace(SIXEL_PLACEHOLDER_RESIDUE_REGEX, "")
		.replace(placeholderResidueRegex, "");
}
