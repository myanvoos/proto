import { Box, type Component, Markdown } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { BranchSummaryMessage, CompactionSummaryMessage } from "../../session/messages";

const COMPACTION_METHOD_LABELS: Record<string, string> = {
	remote: "remote-compacted",
	soft: "soft-compacted",
};

function compactionAmount(message: CompactionSummaryMessage): string | undefined {
	if (message.tokensAfter === undefined || message.tokensBefore <= 0) return undefined;
	return `${formatNumber(message.tokensBefore)}→${formatNumber(message.tokensAfter)}`;
}

interface SummaryDividerOptions {
	label: () => string;
	detailMarkdown: () => string;
}

class SummaryDividerComponent implements Component {
	#expanded = false;
	#cache?: { width: number; lines: string[] };
	#detail?: Box;

	constructor(private readonly options: SummaryDividerOptions) {}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;

		this.#detail = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) {
			return this.#cache.lines;
		}
		const lines = this.#expanded
			? ["", this.#divider(width), "", ...this.#detailBox().render(width)]
			: ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const rule = theme.tree.horizontal;
		const label = this.options.label();

		const hint = `${theme.sep.dot.trim()} ctrl+o`;
		const plainWidth = Bun.stringWidth(`${label} ${hint}`, { countAnsiEscapeCodes: false });

		const remaining = width - plainWidth - 2;
		if (remaining < 4) {
			return theme.fg("muted", label);
		}
		const left = Math.floor(remaining / 2);
		const right = remaining - left;
		return (
			theme.fg("dim", rule.repeat(left)) +
			` ${theme.fg("muted", label)} ${theme.fg("dim", hint)} ` +
			theme.fg("dim", rule.repeat(right))
		);
	}

	#detailBox(): Box {
		if (this.#detail) return this.#detail;
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		box.setIgnoreTight(true);
		box.addChild(
			new Markdown(this.options.detailMarkdown(), 0, 0, getMarkdownTheme(), {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
		this.#detail = box;
		return box;
	}
}

export class CompactionSummaryMessageComponent implements Component {
	#divider: SummaryDividerComponent;

	constructor(private readonly message: CompactionSummaryMessage) {
		this.#divider = new SummaryDividerComponent({
			label: () => this.#label(),
			detailMarkdown: () => this.#detailMarkdown(),
		});
	}

	#label(): string {
		const name = (this.message.method && COMPACTION_METHOD_LABELS[this.message.method]) || "compacted";
		let label = `${theme.icon.camera} ${name}`;
		const amount = compactionAmount(this.message);
		if (amount) label += `${theme.sep.dot}${amount}`;
		if (this.message.warning) label += ` ${theme.fg("warning", theme.icon.warning)}`;
		return label;
	}

	setExpanded(expanded: boolean): void {
		this.#divider.setExpanded(expanded);
	}

	invalidate(): void {
		this.#divider.invalidate();
	}

	render(width: number): readonly string[] {
		return this.#divider.render(width);
	}

	#detailMarkdown(): string {
		const tokenLine =
			this.message.tokensBefore > 0
				? this.message.tokensAfter !== undefined
					? `Compacted from ${this.message.tokensBefore.toLocaleString()} to ${this.message.tokensAfter.toLocaleString()} tokens`
					: `Compacted from ${this.message.tokensBefore.toLocaleString()} tokens`
				: this.message.tokensAfter !== undefined
					? `Compacted to ${this.message.tokensAfter.toLocaleString()} tokens`
					: "Compacted context";
		const warningNote = this.message.warning ? `\n\n${theme.icon.warning} **Warning:** ${this.message.warning}` : "";
		return `**${tokenLine}**${warningNote}\n\n${this.message.summary}`;
	}
}

export class BranchSummaryMessageComponent implements Component {
	#divider: SummaryDividerComponent;

	constructor(private readonly message: BranchSummaryMessage) {
		this.#divider = new SummaryDividerComponent({
			label: () => `${theme.icon.branch} branch`,
			detailMarkdown: () => `**Branch summary**\n\n${this.message.summary}`,
		});
	}

	setExpanded(expanded: boolean): void {
		this.#divider.setExpanded(expanded);
	}

	invalidate(): void {
		this.#divider.invalidate();
	}

	render(width: number): readonly string[] {
		return this.#divider.render(width);
	}
}
