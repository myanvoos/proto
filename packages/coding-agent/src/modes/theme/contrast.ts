import { hexToHsv, hsvToHex, relativeLuminance } from "@oh-my-pi/pi-utils";
import type { ThemeColor } from "./schema";

/**
 * Readability floors for theme colors, as WCAG contrast ratios against the
 * background the role is drawn on.
 *
 * Terminals own their background, so a theme cannot know the exact pixel behind
 * its text. The floors are measured against the canonical background for the
 * theme's mode — pure black for dark themes, pure white for light ones — which
 * is the most generous assumption available: a colour that misses the floor
 * there misses it on every real terminal of that mode.
 *
 * The tiers are deliberately coarse:
 * - `CONTENT` (4.5) is WCAG AA for body text and covers everything the user
 *   reads for meaning: prose, tool output, code and its comments.
 * - `CHROME` (3.0) is AA for large text and covers de-emphasised affordances
 *   that must stay legible without competing with content.
 * - `RULE` (1.5) and `FAINT_RULE` (1.4) cover non-text structure. Frames and
 *   separators may be quiet, but a rule nobody can see is not a rule.
 */
export const CONTENT_CONTRAST = 4.5;
export const CHROME_CONTRAST = 3;
export const RULE_CONTRAST = 1.5;
export const FAINT_RULE_CONTRAST = 1.4;

export const READABILITY_FLOORS: Partial<Record<ThemeColor, number>> = {
	text: CONTENT_CONTRAST,
	muted: CONTENT_CONTRAST,
	toolTitle: CONTENT_CONTRAST,
	toolOutput: CONTENT_CONTRAST,
	toolDiffContext: CONTENT_CONTRAST,
	mdHeading: CONTENT_CONTRAST,
	mdQuote: CONTENT_CONTRAST,
	mdCode: CONTENT_CONTRAST,
	mdLink: CONTENT_CONTRAST,
	syntaxComment: CONTENT_CONTRAST,
	syntaxKeyword: CONTENT_CONTRAST,
	syntaxFunction: CONTENT_CONTRAST,
	syntaxVariable: CONTENT_CONTRAST,
	syntaxString: CONTENT_CONTRAST,
	syntaxNumber: CONTENT_CONTRAST,
	syntaxType: CONTENT_CONTRAST,

	dim: CHROME_CONTRAST,
	thinkingText: CHROME_CONTRAST,
	mdLinkUrl: CHROME_CONTRAST,
	mdListBullet: CHROME_CONTRAST,
	syntaxOperator: CHROME_CONTRAST,
	syntaxPunctuation: CHROME_CONTRAST,

	border: RULE_CONTRAST,
	borderAccent: RULE_CONTRAST,
	mdHr: RULE_CONTRAST,
	mdCodeBlockBorder: RULE_CONTRAST,
	mdQuoteBorder: RULE_CONTRAST,
	borderMuted: FAINT_RULE_CONTRAST,
};

/** Canonical background a mode's floors are measured against. */
export const CANONICAL_BACKGROUND = { dark: "#000000", light: "#ffffff" } as const;

/**
 * WCAG 2.x contrast ratio, 1 (identical) to 21 (black on white). Accepts the
 * same values a theme may hold: `#rrggbb`, `#rgb` or an ANSI-256 index.
 */
export function contrastRatio(foreground: string | number, background: string | number): number {
	const fg = relativeLuminance(foreground);
	const bg = relativeLuminance(background);
	if (fg === undefined || bg === undefined) return Number.POSITIVE_INFINITY;
	return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

/**
 * Move a colour away from the background until it clears `minRatio`, keeping
 * hue — and saturation wherever possible — so a theme's identity survives the
 * correction. Value moves first; saturation is only given up when a fully bright
 * colour still cannot clear the floor against a dark background. A colour that
 * cannot reach the floor at all returns the closest extreme.
 */
export function liftToContrast(color: string, background: string, minRatio: number): string {
	if (contrastRatio(color, background) >= minRatio) return color;
	const backgroundLuminance = relativeLuminance(background);
	if (backgroundLuminance === undefined) return color;

	const hsv = hexToHsv(color);
	if (Number.isNaN(hsv.h) || Number.isNaN(hsv.s) || Number.isNaN(hsv.v)) return color;
	const towardLight = backgroundLuminance <= 0.5;
	const target = towardLight ? 1 : 0;

	// Value alone, as far as it goes: this is what keeps a lifted colour
	// recognisable as the one the theme picked.
	const extreme = hsvToHex({ ...hsv, v: target });
	if (contrastRatio(extreme, background) >= minRatio) {
		return searchChannel(minRatio, background, ratio => hsvToHex({ ...hsv, v: ratio }), hsv.v, target);
	}
	if (!towardLight) return extreme;

	// A saturated colour on a dark background can be bright and still dim; the
	// only remaining room is saturation, which bottoms out at white.
	return searchChannel(minRatio, background, saturation => hsvToHex({ ...hsv, s: saturation, v: 1 }), hsv.s, 0);
}

/**
 * Smallest change along one HSV channel that clears the floor: `from` misses it
 * and `to` clears it, so bisection converges on the least-altered colour. Twelve
 * halvings resolve far below one 8-bit step.
 */
function searchChannel(
	minRatio: number,
	background: string,
	build: (value: number) => string,
	from: number,
	to: number,
): string {
	let miss = from;
	let hit = to;
	let best = build(to);
	for (let step = 0; step < 12; step++) {
		const mid = (miss + hit) / 2;
		const candidate = build(mid);
		if (contrastRatio(candidate, background) >= minRatio) {
			best = candidate;
			hit = mid;
		} else {
			miss = mid;
		}
	}
	return best;
}
