import { type ThemeColor, theme } from "../theme/theme";

export interface TrackSegment {
	label: string;
}

const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

const SEGMENT_COLOR_CANDIDATES: ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"mdCode",
	"mdLink",
	"syntaxString",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxOperator",
	"syntaxVariable",
];

export function resolveSegmentPalette(count: number): ThemeColor[] {
	const palette: ThemeColor[] = [];
	const seen = new Set<string>();
	for (const color of SEGMENT_COLOR_CANDIDATES) {
		const ansi = theme.getFgAnsi(color);
		if (seen.has(ansi)) continue;
		seen.add(ansi);
		palette.push(color);
		if (palette.length >= count) break;
	}
	return palette;
}

export function renderSegmentTrack(segments: TrackSegment[], activeIndex: number): string {
	const capLeft = theme.sep.powerlineRight;
	const capRight = theme.sep.powerlineLeft;
	const thinSep = theme.fg("statusLineSep", theme.sep.powerlineThin);
	const palette = resolveSegmentPalette(segments.length);

	let track = "";
	segments.forEach((segment, i) => {
		if (i > 0) {
			track += i === activeIndex || i - 1 === activeIndex ? "  " : ` ${thinSep} `;
		}
		const color = palette[i % palette.length];
		const fg = theme.getFgAnsi(color);
		if (i !== activeIndex) {
			track += `${fg}${segment.label}${FG_RESET}`;
			return;
		}
		const bg = fg.replace("\x1b[38;", "\x1b[48;");
		const label = `${bg}${theme.getContrastFgAnsi(color)}\x1b[1m ${segment.label} \x1b[22m${BG_RESET}`;
		track += `${fg}${capLeft}${label}${fg}${capRight}${FG_RESET}`;
	});
	return track;
}
