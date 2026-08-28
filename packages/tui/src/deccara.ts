import { visibleWidth } from "./utils";

const SEGMENT_RESET = "\x1b[0m";

export const DECSACE_RECT = "\x1b[2*x";

export const DECSACE_DEFAULT = "\x1b[*x";

const DECSACE_WRAPPER_BYTES = DECSACE_RECT.length + DECSACE_DEFAULT.length;

export function encodeDeccara(top: number, left: number, bottom: number, right: number, sgr: string): string {
	return `\x1b[${top};${left};${bottom};${right};${sgr}$r`;
}

const BAIL = Symbol("deccara-bail");
type BgState = string | null;

function nextBackground(bg: BgState, params: string): BgState | typeof BAIL {
	if (params.length === 0) return null;
	const tokens = params.split(";");
	let result: BgState = bg;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		const n = token.length === 0 ? 0 : Number(token);
		if (!Number.isInteger(n)) return BAIL;
		if (n === 0 || n === 49) {
			result = null;
			continue;
		}
		if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
			result = token;
			continue;
		}
		if (n === 48) {
			const mode = tokens[i + 1];
			if (mode === "5") {
				const idx = tokens[i + 2];
				if (idx === undefined) return BAIL;
				result = `48;5;${idx}`;
				i += 2;
				continue;
			}
			if (mode === "2") {
				const r = tokens[i + 2];
				const g = tokens[i + 3];
				const b = tokens[i + 4];
				if (r === undefined || g === undefined || b === undefined) return BAIL;
				result = `48;2;${r};${g};${b}`;
				i += 4;
				continue;
			}

			return BAIL;
		}
		if (n === 38) {
			const mode = tokens[i + 1];
			if (mode === "5") {
				i += 2;
				continue;
			}
			if (mode === "2") {
				i += 4;
				continue;
			}
			return BAIL;
		}
	}
	return result;
}

export interface BgFillAnalysis {
	cut: number;

	leftCol: number;

	bg: string;
}

export function analyzeBgFillLine(line: string, width: number): BgFillAnalysis | null {
	if (width <= 0 || line.length === 0) return null;
	let i = 0;
	let col = 0;
	let bg: BgState = null;

	let nonSpaceEndByte = 0;
	let nonSpaceEndCol = 0;

	let trailBg: BgState = null;
	let trailStarted = false;
	let trailConsistent = true;

	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			if (line.charCodeAt(i + 1) !== 0x5b) return null;
			let j = i + 2;
			while (j < line.length) {
				const c = line.charCodeAt(j);
				if (c >= 0x40 && c <= 0x7e) break;
				j++;
			}
			if (j >= line.length) return null;
			if (line.charCodeAt(j) !== 0x6d) return null;
			const next = nextBackground(bg, line.slice(i + 2, j));
			if (next === BAIL) return null;
			bg = next;
			i = j + 1;
			continue;
		}

		let j = i;
		while (j < line.length && line.charCodeAt(j) !== 0x1b) j++;
		const text = line.slice(i, j);
		let nonSpaceLen = text.length;
		while (nonSpaceLen > 0 && text.charCodeAt(nonSpaceLen - 1) === 0x20) nonSpaceLen--;

		if (nonSpaceLen > 0) {
			const nonSpaceWidth = visibleWidth(text.slice(0, nonSpaceLen));
			nonSpaceEndByte = i + nonSpaceLen;
			nonSpaceEndCol = col + nonSpaceWidth;

			if (nonSpaceLen < text.length) {
				trailBg = bg;
				trailStarted = true;
			} else {
				trailBg = null;
				trailStarted = false;
			}
			trailConsistent = true;
		} else if (text.length > 0) {
			if (!trailStarted) {
				trailBg = bg;
				trailStarted = true;
			} else if (bg !== trailBg) {
				trailConsistent = false;
			}
		}
		col += visibleWidth(text);
		i = j;
	}

	if (col !== width) return null;
	if (nonSpaceEndCol >= width) return null;
	if (!trailStarted || trailBg === null || !trailConsistent) return null;
	return { cut: nonSpaceEndByte, leftCol: nonSpaceEndCol, bg: trailBg };
}

interface FillCandidate {
	left: number;
	right: number;
	bg: string;
	short: string;
	origLen: number;
}

export interface DeccaraPlan {
	texts: string[];

	sequence: string;
}

export function planDeccaraFills(lines: string[], width: number, firstScreenRow = 0): DeccaraPlan {
	const n = lines.length;
	const texts: string[] = new Array(n);
	const candidates: (FillCandidate | null)[] = new Array(n);

	for (let k = 0; k < n; k++) {
		const line = lines[k];
		texts[k] = line;
		const analysis = analyzeBgFillLine(line, width);
		if (!analysis) {
			candidates[k] = null;
			continue;
		}

		const short = analysis.cut === 0 ? "" : line.slice(0, analysis.cut) + SEGMENT_RESET;
		candidates[k] = { left: analysis.leftCol + 1, right: width, bg: analysis.bg, short, origLen: line.length };
	}

	interface Group {
		start: number;
		end: number;
		rect: string;
	}
	const groups: Group[] = [];
	let removedTotal = 0;
	let rectBytesTotal = 0;
	let k = 0;
	while (k < n) {
		const head = candidates[k];
		if (!head) {
			k++;
			continue;
		}

		let end = k;
		while (end + 1 < n) {
			const next = candidates[end + 1];
			if (!next || next.left !== head.left || next.right !== head.right || next.bg !== head.bg) break;
			end++;
		}
		const rect = encodeDeccara(firstScreenRow + k + 1, head.left, firstScreenRow + end + 1, head.right, head.bg);
		let removed = 0;
		for (let r = k; r <= end; r++) {
			const c = candidates[r];
			if (c) removed += c.origLen - c.short.length;
		}
		if (removed > rect.length) {
			groups.push({ start: k, end, rect });
			removedTotal += removed;
			rectBytesTotal += rect.length;
		}
		k = end + 1;
	}

	if (groups.length === 0 || removedTotal - rectBytesTotal <= DECSACE_WRAPPER_BYTES) {
		return { texts, sequence: "" };
	}
	let sequence = DECSACE_RECT;
	for (const group of groups) {
		for (let r = group.start; r <= group.end; r++) {
			const c = candidates[r];
			if (c) texts[r] = c.short;
		}
		sequence += group.rect;
	}
	sequence += DECSACE_DEFAULT;
	return { texts, sequence };
}
