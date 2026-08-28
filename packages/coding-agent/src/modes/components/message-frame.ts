import type { TextContent } from "@oh-my-pi/pi-ai";
import type { Box, Component } from "@oh-my-pi/pi-tui";
import { Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, type Theme, type ThemeColor, theme } from "../../modes/theme/theme";

interface FramedMessage {
	customType: string;
	content: string | (TextContent | { type: string })[];
}

type FramedRenderer<M extends FramedMessage> = (
	message: M,
	options: { expanded: boolean },
	theme: Theme,
) => Component | undefined;

interface RebuildFrameOptions<M extends FramedMessage> {
	message: M;
	box: Box;
	expanded: boolean;

	icon?: string;

	hideHeader?: boolean;

	borderColor?: ThemeColor;

	collapseAfterLines?: number;
	customRenderer?: FramedRenderer<M>;
}

export function renderFramedMessage<M extends FramedMessage>(opts: RebuildFrameOptions<M>): Component | undefined {
	if (opts.customRenderer) {
		try {
			const component = opts.customRenderer(opts.message, { expanded: opts.expanded }, theme);
			if (component) return component;
		} catch {}
	}

	opts.box.clear();

	opts.box.setBorder({ chars: theme.boxRound, color: t => theme.fg(opts.borderColor ?? "borderMuted", t) });

	if (!opts.hideHeader) {
		const tag = opts.icon ? `${opts.icon} ${opts.message.customType}` : opts.message.customType;
		opts.box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(tag)), 0, 0));
		opts.box.addChild(new Spacer(1));
	}

	let text: string;
	if (typeof opts.message.content === "string") {
		text = opts.message.content;
	} else {
		text = opts.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("\n");
	}

	if (!opts.expanded && opts.collapseAfterLines !== undefined) {
		const lines = text.split("\n");
		if (lines.length > opts.collapseAfterLines) {
			text = `${lines.slice(0, opts.collapseAfterLines).join("\n")}\n…`;
		}
	}

	opts.box.addChild(
		new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		}),
	);

	return undefined;
}
