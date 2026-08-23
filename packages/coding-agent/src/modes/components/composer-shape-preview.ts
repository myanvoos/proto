/**
 * Live preview for the `composer.shape` setting and the setup-wizard composer
 * scene. Chrome is rendered through the same {@link ComposerStyle} objects the
 * real editor uses, and status rows come from the live
 * {@link ComposerPreviewStatusSource} (the session's StatusLineComponent) —
 * nothing about the preview is a re-implementation. Prompt text is a preview
 * stand-in, and the `session_name` segment falls back to a stand-in title
 * (passed via `previewTitle`) when the session is unnamed.
 */
import {
	type Component,
	type ComposerChromeContext,
	getComposerStyle,
	padding,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { ComposerShape } from "../../config/settings-schema";
import { theme } from "../theme/theme";

/**
 * Real status renderer the preview borrows rows from — structurally satisfied
 * by {@link StatusLineComponent}. The composer footline renders below every
 * shape; `previewTitle` stands in for an unnamed session's name chip.
 */
export interface ComposerPreviewStatusSource {
	/** The quiet footline row, or null when nothing renders. */
	renderQuietLine(width: number, extras?: { previewTitle?: string }): string | null;
}

export interface ComposerShapePreviewOptions {
	requestRender?: () => void;
	/** Live status renderer; omitted (tests), the chrome renders without status rows. */
	status?: ComposerPreviewStatusSource;
}
/** Stand-in session title shown while the previewed session is unnamed. */
const PREVIEW_TITLE = "omp";

export function renderComposerShapePreview(
	shape: ComposerShape,
	width: number,
	status?: ComposerPreviewStatusSource,
): readonly string[] {
	const previewWidth = Math.max(24, Math.min(width, 96));
	const style = getComposerStyle(shape);
	const paddingX = style.defaultPaddingX(undefined);
	const chromeWidth = style.sideChromeWidth(paddingX);

	const ctx: ComposerChromeContext = {
		width: previewWidth,
		paddingX,
		borderColor: (str: string) => theme.fg("borderAccent", str),
		accentColor: (str: string) => theme.fg("accent", str),
		surfaceColor: (str: string) => theme.bgFill("userMessageBg", str),
		box: theme.boxRound,
	};

	const gutter = style.defaultPromptGutter ?? "";
	const contentWidth = Math.max(1, previewWidth - chromeWidth * 2 - visibleWidth(gutter));
	const promptText = truncateToWidth("Ask anything, edit files, run tools", Math.max(1, contentWidth - 1));
	const text = `${theme.fg("text", promptText)}${theme.inverse(" ")}`;
	const pad = padding(Math.max(0, contentWidth - visibleWidth(promptText) - 1));
	const styledGutter = gutter ? theme.fg("accent", gutter) : "";

	const lines: string[] = [];
	const top = style.renderTop(ctx);
	if (top !== undefined) lines.push(top);
	lines.push(
		...style.renderRow({
			...ctx,
			text,
			pad,
			gutter: styledGutter,
			isLastRow: true,
			cursorOverflow: 0,
			imeSafeCursorTail: false,
			scrollbarThumb: false,
		}),
	);
	const bottom = style.renderBottom(ctx);
	if (bottom !== undefined) lines.push(bottom);

	if (status) {
		const footline = status.renderQuietLine(previewWidth, { previewTitle: PREVIEW_TITLE });
		if (footline) lines.push(footline);
	}
	return lines;
}

export class ComposerShapePreview implements Component {
	#shape: ComposerShape;
	#options: ComposerShapePreviewOptions;

	constructor(initialValue: ComposerShape = "box", options: ComposerShapePreviewOptions = {}) {
		this.#shape = initialValue;
		this.#options = options;
	}

	setValue(shape: ComposerShape): void {
		if (this.#shape === shape) return;
		this.#shape = shape;
		this.#options.requestRender?.();
	}

	render(width: number): readonly string[] {
		const lines = renderComposerShapePreview(this.#shape, width, this.#options.status);
		return ["", theme.fg("muted", "Preview:"), ...lines];
	}
}
