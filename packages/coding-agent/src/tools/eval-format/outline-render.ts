import type { Theme } from "../../modes/theme/theme";
import { truncateToWidth } from "../render-utils";

export interface OutlineNode {
	kind: string;
	modifier?: string;
	name?: string;
	detail?: string;
	doc?: string;
	notes?: string[];
	questions?: string[];
	rawString?: string;
	line: number;
	children: OutlineNode[];
}

export function outlineNode(kind: string, line: number, name?: string, detail?: string): OutlineNode {
	return { kind, name, detail, line, children: [] };
}

export function countLeaves(children: OutlineNode[]): number {
	let count = 0;
	for (const child of children) {
		count += 1 + countLeaves(child.children);
	}
	return count;
}

export interface OutlineRenderConfig {
	headerKinds: ReadonlySet<string>;
	augKinds: ReadonlySet<string>;
}

export function renderOutlineLines(
	root: OutlineNode,
	theme: Theme,
	width: number,
	config: OutlineRenderConfig,
): string[] {
	const total = countLeaves(root.children);
	const lines: string[] = [`${theme.fg("dim", "Module")} ${theme.fg("dim", `· ${total} nodes`)}`];
	const walk = (children: OutlineNode[], prefix: string) => {
		children.forEach((child, index) => {
			const last = index === children.length - 1;
			const connector = `${prefix}${last ? "└─ " : "├─ "}`;
			for (const note of child.notes ?? []) {
				lines.push(formatNoteLine(note, connector, theme, width, "accent"));
			}
			for (const question of child.questions ?? []) {
				lines.push(formatNoteLine(question, connector, theme, width, "warning"));
			}
			lines.push(formatAstLine(child, connector, theme, width, config));
			if (child.children.length > 0) {
				walk(child.children, `${prefix}${last ? "   " : "│  "}`);
			}
		});
	};
	walk(root.children, "");
	return lines;
}

function formatNoteLine(
	note: string,
	connector: string,
	theme: Theme,
	width: number,
	color: "accent" | "warning",
): string {
	const body = truncateToWidth(note, Math.max(24, width - connector.length - 8));
	return `${connector}${theme.fg(color, `▌ ${body}`)}`;
}

function formatAstLine(
	child: OutlineNode,
	connector: string,
	theme: Theme,
	width: number,
	config: OutlineRenderConfig,
): string {
	const name = child.name && child.name.length > 0 ? child.name : "";
	const detail = child.detail && child.detail.length > 0 ? child.detail : "";
	let core: string;
	if (child.kind === "assign") {
		core = detail
			? `${theme.fg("toolTitle", name)} ${theme.fg("dim", "←")} ${theme.fg("toolOutput", detail)}`
			: theme.fg("toolTitle", name);
	} else if (config.augKinds.has(child.kind)) {
		core = `${theme.fg("toolTitle", name)} ${theme.fg("dim", child.kind)} ${theme.fg("toolOutput", detail)}`;
	} else if (child.kind === "expr") {
		core = theme.fg("toolOutput", detail);
	} else {
		const parts: string[] = [theme.fg("dim", child.kind)];
		if (name.length > 0) parts.push(theme.fg("toolTitle", name));
		if (detail.length > 0) parts.push(theme.fg("toolOutput", detail));
		core = parts.join(" ");
	}
	if (child.modifier && child.modifier.length > 0) {
		core = `${theme.fg("dim", child.modifier)} ${core}`;
	}
	if (child.doc && child.doc.length > 0) {
		core += ` ${theme.fg("dim", `— ${child.doc}`)}`;
	}
	let line = `${connector}${core}`;
	if (config.headerKinds.has(child.kind)) {
		line += theme.fg("dim", ` ·L${child.line}`);
	}
	const bodyWidth = Math.max(24, width - connector.length - 8);
	return truncateToWidth(line, bodyWidth);
}
