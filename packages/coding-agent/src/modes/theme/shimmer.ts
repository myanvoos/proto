import { isSettingsInitialized, settings } from "../../config/settings";
import type { Theme, ThemeColor } from "./theme";

const SHIMMER_SPEED_CELLS_PER_S = 30;

const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;

const KITT_HEAD_HALF = 0.6;
const KITT_TRAIL_LEN = 7;

const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

type ShimmerTheme = Pick<Theme, "bold" | "fg" | "getFgAnsi">;
type ShimmerMode = "classic" | "kitt" | "disabled";

type ShimmerPaletteTier = ThemeColor | { ansi: string };

function resolveTierAnsi(theme: ShimmerTheme, tier: ShimmerPaletteTier): string {
	return typeof tier === "string" ? theme.getFgAnsi(tier) : tier.ansi;
}

interface ShimmerPalette {
	low: ShimmerPaletteTier;

	mid: ShimmerPaletteTier;

	high: ShimmerPaletteTier;

	bold?: boolean;
}

interface ShimmerSegment {
	text: string;
	palette?: ShimmerPalette;
}

const DEFAULT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "accent",
	bold: true,
};

interface TierSeq {
	open: string;
	close: string;
}
interface CompiledPalette {
	low: TierSeq;
	mid: TierSeq;
	high: TierSeq;
}

const kCompiledFor = Symbol("shimmer.compiledFor");
const kCompiled = Symbol("shimmer.compiled");
interface PaletteCache {
	[kCompiledFor]?: ShimmerTheme;
	[kCompiled]?: CompiledPalette;
}

function compile(theme: ShimmerTheme, palette: ShimmerPalette): CompiledPalette {
	const p = palette as ShimmerPalette & PaletteCache;
	const cached = p[kCompiled];
	if (cached && p[kCompiledFor] === theme) return cached;
	const lowOpen = resolveTierAnsi(theme, palette.low);
	const midOpen = resolveTierAnsi(theme, palette.mid);
	const highColorOpen = resolveTierAnsi(theme, palette.high);
	const highOpen = palette.bold ? `${BOLD_OPEN}${highColorOpen}` : highColorOpen;
	const highClose = palette.bold ? `${BOLD_CLOSE}${FG_RESET}` : FG_RESET;
	const out: CompiledPalette = {
		low: { open: lowOpen, close: FG_RESET },
		mid: { open: midOpen, close: FG_RESET },
		high: { open: highOpen, close: highClose },
	};
	p[kCompiledFor] = theme;
	p[kCompiled] = out;
	return out;
}

function classicIntensity(time: number, index: number, length: number): number {
	const period = length + CLASSIC_PADDING * 2;

	const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
	const dist = Math.abs(index + CLASSIC_PADDING - pos);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

function kittIntensity(time: number, index: number, length: number): number {
	const range = length - 1;
	if (range <= 0) return 1;

	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	const delta = index - head;
	const abs = delta < 0 ? -delta : delta;
	if (abs <= KITT_HEAD_HALF) return 1;

	const behind = goingRight ? -delta : delta;
	if (behind <= KITT_HEAD_HALF) return 0;
	const t = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
	if (t >= 1) return 0;
	const f = 1 - t;
	return f * f;
}

type Tier = "low" | "mid" | "high";

function tierFor(intensity: number): Tier {
	if (intensity >= TIER_HIGH) return "high";
	if (intensity >= TIER_MID) return "mid";
	return "low";
}

function resolveMode(): ShimmerMode {
	if (!isSettingsInitialized()) return "classic";
	return settings.get("display.shimmer");
}

export function shimmerEnabled(): boolean {
	return resolveMode() !== "disabled";
}

function shimmerSegments(segments: readonly ShimmerSegment[], theme: ShimmerTheme): string {
	const mode = resolveMode();

	let total = 0;
	const perSeg: { text: string; palette: ShimmerPalette }[] = [];
	for (const seg of segments) {
		total += countCodePoints(seg.text);
		perSeg.push({ text: seg.text, palette: seg.palette ?? DEFAULT_SHIMMER_PALETTE });
	}
	if (total === 0) return "";

	if (mode === "disabled") {
		let out = "";
		for (const { text, palette } of perSeg) {
			const seq = compile(theme, palette).mid;
			out += `${seq.open}${text}${seq.close}`;
		}
		return out;
	}

	const time = Date.now();
	const intensityFn = mode === "kitt" ? kittIntensity : classicIntensity;

	const { lo: bandLo, hi: bandHi } = activeBand(mode, time, total);

	let out = "";
	let index = 0;
	for (const { text, palette } of perSeg) {
		const compiled = compile(theme, palette);
		let runTier: Tier | null = null;
		let runStart = 0;
		let runEnd = 0;
		let i = 0;
		while (i < text.length) {
			const c = text.charCodeAt(i);
			let step = 1;
			if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
				const c2 = text.charCodeAt(i + 1);
				if (c2 >= 0xdc00 && c2 <= 0xdfff) step = 2;
			}
			const tier: Tier = index < bandLo || index > bandHi ? "low" : tierFor(intensityFn(time, index, total));
			if (tier !== runTier) {
				if (runTier !== null && runEnd > runStart) {
					const seq = compiled[runTier];
					out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
				}
				runTier = tier;
				runStart = i;
			}
			runEnd = i + step;
			index++;
			i += step;
		}
		if (runTier !== null && runEnd > runStart) {
			const seq = compiled[runTier];
			out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
		}
	}
	return out;
}

function activeBand(mode: "classic" | "kitt", time: number, total: number): { lo: number; hi: number } {
	if (mode === "classic") {
		const period = total + CLASSIC_PADDING * 2;
		const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
		return {
			lo: pos - CLASSIC_PADDING - CLASSIC_BAND_HALF_WIDTH,
			hi: pos - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH,
		};
	}
	const range = total - 1;
	if (range <= 0) return { lo: 0, hi: total };
	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;

	return goingRight
		? { lo: head - KITT_HEAD_HALF - KITT_TRAIL_LEN, hi: head + KITT_HEAD_HALF }
		: { lo: head - KITT_HEAD_HALF, hi: head + KITT_HEAD_HALF + KITT_TRAIL_LEN };
}

function countCodePoints(text: string): number {
	let n = 0;
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const c2 = text.charCodeAt(i + 1);
			if (c2 >= 0xdc00 && c2 <= 0xdfff) {
				i += 2;
				n++;
				continue;
			}
		}
		i++;
		n++;
	}
	return n;
}

export function shimmerText(text: string, theme: ShimmerTheme, palette?: ShimmerPalette): string {
	return shimmerSegments([{ text, palette }], theme);
}
