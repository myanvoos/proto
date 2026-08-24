import type { Component } from "@oh-my-pi/pi-tui";
import { ImageProtocol, padding, TERMINAL, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { getSixelLineMask } from "../utils/sixel";
import type { State } from "./types";
import { Hasher, type RenderCache } from "./utils";

export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: readonly string[]; separator?: boolean }>;
	width: number;
	contentPaddingLeft?: number;
	/** Override the state-derived border color. Used for muted "legacy" tool
	 * frames that should not visually compete with framed-output tools. */
	borderColor?: ThemeColor;
}

const FRAMED_BLOCK_COMPONENT = Symbol("framedBlockComponent");

export type FramedBlockComponent = Component & { [FRAMED_BLOCK_COMPONENT]?: true };

export function markFramedBlockComponent<T extends Component>(component: T): T & FramedBlockComponent {
	(component as T & FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] = true;
	return component as T & FramedBlockComponent;
}

export function isFramedBlockComponent(component: Component): boolean {
	return (component as FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] === true;
}

type BlockRow =
	| { kind: "header"; text: string }
	| { kind: "label"; text: string }
	| { kind: "rule" }
	| { kind: "content"; inner: string }
	| { kind: "sixel"; raw: string };

const SEPARATOR_CELLS = 12;

function normalizeContentPaddingLeft(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 1;
	return Math.max(0, Math.floor(value));
}

export function outputBlockContentWidth(width: number, contentPaddingLeft?: number): number {
	return Math.max(1, width - 2 - normalizeContentPaddingLeft(contentPaddingLeft));
}

function channelDistance(a: string, b: string): number {
	let worst = 0;
	for (let i = 0; i < 3; i++) {
		const ca = Number.parseInt(a.slice(1 + i * 2, 3 + i * 2), 16);
		const cb = Number.parseInt(b.slice(1 + i * 2, 3 + i * 2), 16);
		if (Number.isNaN(ca) || Number.isNaN(cb)) return Number.POSITIVE_INFINITY;
		worst = Math.max(worst, Math.abs(ca - cb));
	}
	return worst;
}

const RAIL_GROUND_MIN_DISTANCE = 12;

function declaredGroundHex(theme: Theme): string | undefined {
	const match = /48;2;(\d+);(\d+);(\d+)/.exec(theme.getBgAnsi("statusLineBg"));
	if (!match) return undefined;
	const channels = [match[1] ?? "", match[2] ?? "", match[3] ?? ""].map(channel => Number.parseInt(channel, 10));
	if (channels.some(channel => !Number.isFinite(channel))) return undefined;
	return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

function visibleRailColor(requested: ThemeColor, theme: Theme): ThemeColor {
	const ground = declaredGroundHex(theme);
	if (ground === undefined) return requested;
	const hex = theme.getColorHex(requested);
	if (channelDistance(hex, ground) >= RAIL_GROUND_MIN_DISTANCE) return requested;
	return channelDistance(theme.getColorHex("dim"), ground) >= RAIL_GROUND_MIN_DISTANCE ? "dim" : requested;
}

export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	const { header, headerMeta, state, sections = [], width } = options;
	const h = theme.boxSharp.horizontal;
	const rail = theme.symbol("block.rail");
	const lineWidth = Math.max(0, width);
	// Border colors: running/pending use accent, success uses dim (gray), error/warning keep their colors
	const requestedColor: ThemeColor =
		options.borderColor ??
		(state === "error"
			? "error"
			: state === "warning"
				? "warning"
				: state === "running" || state === "pending"
					? "accent"
					: "dim");
	const borderColor = visibleRailColor(requestedColor, theme);
	const border = (text: string) => theme.fg(borderColor, text);
	const contentPaddingLeft = normalizeContentPaddingLeft(options.contentPaddingLeft);
	const chromeWidth = visibleWidth(rail) + 1 + contentPaddingLeft;
	const contentWidth = Math.max(0, lineWidth - chromeWidth);
	const contentLeftPadding = contentPaddingLeft > 0 ? padding(contentPaddingLeft) : "";

	const rows: BlockRow[] = [];
	const headerText = [header, headerMeta].filter(Boolean).join(theme.sep.dot);
	if (headerText) rows.push({ kind: "header", text: headerText });

	const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
	for (let sectionIndex = 0; sectionIndex < normalizedSections.length; sectionIndex++) {
		const section = normalizedSections[sectionIndex]!;
		if (section.label) {
			rows.push({ kind: "label", text: section.label });
		} else if (section.separator && sectionIndex > 0) {
			rows.push({ kind: "rule" });
		}
		const allLines = section.lines.flatMap(l => l.split("\n"));
		const sixelLineMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const line = allLines[lineIndex]!;
			if (sixelLineMask?.[lineIndex]) {
				rows.push({ kind: "sixel", raw: line });
				continue;
			}
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wrappedLine of wrappedLines) {
				rows.push({ kind: "content", inner: wrappedLine });
			}
		}
	}

	let blockWidth = 0;
	for (const row of rows) {
		if (row.kind === "sixel") continue;
		const ink =
			row.kind === "header"
				? visibleWidth(row.text)
				: row.kind === "content"
					? visibleWidth(row.inner) + chromeWidth
					: row.kind === "label"
						? visibleWidth(row.text) + chromeWidth
						: SEPARATOR_CELLS + chromeWidth;
		blockWidth = Math.max(blockWidth, ink + 1);
	}
	blockWidth = Math.min(lineWidth, blockWidth);
	const innerWidth = Math.max(0, blockWidth - chromeWidth);

	const onRail = (body: string): string => `${border(rail)} ${body}`;

	const lines: string[] = [];
	for (const row of rows) {
		if (row.kind === "sixel") {
			lines.push(row.raw);
			continue;
		}
		const line =
			row.kind === "header"
				? row.text
				: row.kind === "content"
					? onRail(`${contentLeftPadding}${row.inner}`)
					: row.kind === "label"
						? onRail(`${contentLeftPadding}${row.text}`)
						: onRail(border(h.repeat(Math.min(Math.max(innerWidth, 0), SEPARATOR_CELLS))));
		lines.push(line);
	}

	return lines;
}

/**
 * Cached wrapper around `renderOutputBlock`.
 *
 * Since output blocks are re-rendered on every frame (via `render(width)` closures),
 * but their content rarely changes, this cache avoids redundant `visibleWidth()` and
 * `padding()` computations on ~99% of render calls.
 */
export class CachedOutputBlock {
	#cache?: RenderCache;

	/** Render with caching. Returns the cached (shared, caller-immutable) lines if options haven't changed. */
	render(options: OutputBlockOptions, theme: Theme): readonly string[] {
		const key = this.#buildKey(options);
		if (this.#cache?.key === key) return this.#cache.lines;
		const lines = renderOutputBlock(options, theme);
		this.#cache = { key, lines };
		return lines;
	}

	/** Invalidate the cache, forcing a rebuild on next render. */
	invalidate(): void {
		this.#cache = undefined;
	}

	#buildKey(options: OutputBlockOptions): bigint {
		const h = new Hasher();
		h.u32(options.width);
		h.u32(normalizeContentPaddingLeft(options.contentPaddingLeft));
		h.optional(options.header);
		h.optional(options.headerMeta);
		h.optional(options.state);
		h.optional(options.borderColor);
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				h.bool(s.separator ?? false);
				for (const line of s.lines) {
					h.str(line);
				}
			}
		}
		return h.digest();
	}
}

/**
 * Build a self-framing tool component backed by a cached output block. The
 * `build` callback returns the block options for a given width; the cache
 * dedupes re-renders. Pass `borderColor: "borderMuted"` for the dim "legacy"
 * look that does not compete with the state-colored framed tools.
 */
export function framedBlock(theme: Theme, build: (width: number) => OutputBlockOptions): Component {
	const block = new CachedOutputBlock();
	// Marked so the tool-execution container treats it as self-framing (renders
	// flush, no extra padding/background) the same way `markFramedBlockComponent`
	// blocks are treated.
	return markFramedBlockComponent({
		render: (width: number): readonly string[] => block.render(build(width), theme),
		invalidate: () => block.invalidate(),
	});
}
