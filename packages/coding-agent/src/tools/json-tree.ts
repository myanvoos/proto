import { INTENT_FIELD, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Theme } from "../modes/theme/theme";
import { truncateToWidth, wrapTextWithAnsi } from "./render-utils";

export const JSON_TREE_MAX_DEPTH_COLLAPSED = 2;
export const JSON_TREE_MAX_DEPTH_EXPANDED = Number.POSITIVE_INFINITY;
export const JSON_TREE_MAX_LINES_COLLAPSED = 6;
export const JSON_TREE_MAX_LINES_EXPANDED = Number.POSITIVE_INFINITY;
export const JSON_TREE_SCALAR_LEN_COLLAPSED = 60;
// Per-value width, not a hidden-content cap — keep finite: truncateToWidth
// coerces with `| 0`, so Infinity here would truncate every scalar to nothing.
export const JSON_TREE_SCALAR_LEN_EXPANDED = 2000;

const HIDDEN_ARG_KEYS = { [INTENT_FIELD]: 1, __partialJson: 1 };

const ARGS_INLINE_PAIR_SEP = ", ";
const ARGS_INLINE_PAIR_SEP_WIDTH = Bun.stringWidth(ARGS_INLINE_PAIR_SEP);
const ARGS_INLINE_MORE = "…";
const ARGS_INLINE_MORE_WIDTH = Bun.stringWidth(ARGS_INLINE_MORE);

const ARGS_INLINE_TAIL_VALUE_RESERVE = 4;

function sanitizeTreeKey(key: string): string {
	return sanitizeText(key.replace(/[\r\n\t]+/g, " "));
}

function sanitizeMultilineValue(value: string): string {
	return sanitizeText(value).replace(/\t/g, "\\t");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatScalar(value: unknown, maxLen: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		// Values come from tool arguments (model/network controlled): strip
		// terminal controls, then escape structural whitespace.
		const escaped = sanitizeText(value).replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		const truncated = truncateToWidth(escaped, maxLen);
		return `"${truncated}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return `{${keys.length} keys}`;
	}
	return String(value);
}

export function formatArgsInline(args: Record<string, unknown>, maxWidth: number): string {
	const keys: Array<{ raw: string; display: string }> = [];
	for (const raw of Object.keys(args)) {
		if (raw in HIDDEN_ARG_KEYS) continue;
		keys.push({ raw, display: sanitizeTreeKey(raw) });
	}
	let result = "";
	let width = 0;
	for (let i = 0; i < keys.length; i++) {
		const keyInfo = keys[i]!;
		const key = keyInfo.display;
		const value = args[keyInfo.raw];
		const sep = width > 0 ? ARGS_INLINE_PAIR_SEP : "";
		const sepW = width > 0 ? ARGS_INLINE_PAIR_SEP_WIDTH : 0;
		const current = width + sepW;
		const cap = maxWidth - current - ARGS_INLINE_MORE_WIDTH;
		if (cap <= 0) {
			return `${result}${ARGS_INLINE_MORE}`;
		}

		let tailReserve = 0;
		for (let j = i + 1; j < keys.length; j++) {
			tailReserve +=
				ARGS_INLINE_PAIR_SEP_WIDTH + Bun.stringWidth(keys[j]!.display) + 1 + ARGS_INLINE_TAIL_VALUE_RESERVE;
		}

		const pieceBudget = Math.min(cap, maxWidth - current - tailReserve);
		const valueMaxLen = Math.max(1, pieceBudget - Bun.stringWidth(key) - 3);
		const valueStr = formatScalar(value, valueMaxLen);
		const piece = `${key}=${valueStr}`;
		const pieceW = Bun.stringWidth(piece);
		if (pieceW > pieceBudget) {
			return `${result}${sep}${truncateToWidth(piece, cap)}`;
		}
		result += sep + piece;
		width = current + pieceW;
	}
	return result;
}

function buildTreePrefix(theme: Theme, ancestors: readonly boolean[]): string {
	return ancestors.map(hasNext => (hasNext ? `${theme.tree.vertical}  ` : "   ")).join("");
}

export function renderJsonTreeLines(
	value: unknown,
	theme: Theme,
	maxDepth: number,
	maxLines: number,
	maxScalarLen: number,
	width: number,
): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let truncated = false;

	const iconObject = theme.styledSymbol("icon.folder", "muted");
	const iconArray = theme.styledSymbol("icon.package", "muted");
	const iconScalar = theme.styledSymbol("icon.file", "muted");

	const pushLine = (line: string): boolean => {
		if (lines.length >= maxLines) {
			truncated = true;
			return false;
		}
		const rows = wrapTextWithAnsi(line, Math.max(1, width));
		const available = Math.max(0, maxLines - lines.length);
		lines.push(...rows.slice(0, available));
		if (rows.length > available) {
			truncated = true;
			const last = lines.length - 1;
			lines[last] = `${truncateToWidth(lines[last], Math.max(0, width - 1), "")}${theme.fg("dim", "…")}`;
			return false;
		}
		return true;
	};

	const pushScalar = (lead: string, scalar: string): boolean => {
		const first = truncateToWidth(scalar, Math.max(0, width - Bun.stringWidth(lead)), "");
		if (!pushLine(`${lead}${theme.fg("dim", first)}`)) return false;
		return first.length === scalar.length || pushLine(theme.fg("dim", scalar.slice(first.length)));
	};

	const renderNode = (val: unknown, key: string | undefined, ancestors: boolean[], isLast: boolean, depth: number) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return;
		}

		const connector = isLast ? theme.tree.last : theme.tree.branch;
		const prefix = `${buildTreePrefix(theme, ancestors)}${theme.fg("dim", connector)} `;

		ancestors.push(!isLast);
		try {
			if (val === null || val === undefined || typeof val !== "object") {
				const rawLabel = key ? sanitizeTreeKey(key) : "value";
				const label = theme.fg("muted", rawLabel);
				const fullLead = `${prefix}${iconScalar} ${label}: `;
				// Decoration must not consume the scalar's entire first row. At
				// narrow widths retain the key/index, then wrap the actual value.
				const valueReserve = Math.min(8, Math.max(1, Math.floor(width / 3)));
				const compact = Bun.stringWidth(fullLead) + valueReserve > width;
				const compactLabel = Number.isFinite(maxLines)
					? truncateToWidth(rawLabel, Math.max(1, width - valueReserve - 2))
					: rawLabel;
				const lead = compact ? `${theme.fg("muted", compactLabel)}: ` : fullLead;

				if (typeof val === "string" && val.includes("\n")) {
					// Sanitize each physical line before width truncation; otherwise a
					// prefix of control bytes can consume the entire visible budget.
					const strLines = val.split("\n").map(sanitizeMultilineValue);
					const maxStrLines = Math.min(strLines.length, Math.max(1, maxLines - lines.length - 1));
					const continuePrefix = compact ? "" : `${buildTreePrefix(theme, ancestors)}   `;

					const firstLine = truncateToWidth(strLines[0], maxScalarLen);
					if (!pushScalar(lead, `"${firstLine}`)) return;

					for (let i = 1; i < maxStrLines; i++) {
						if (lines.length >= maxLines) {
							truncated = true;
							break;
						}
						const line = truncateToWidth(strLines[i], maxScalarLen);
						const closingQuote = i === strLines.length - 1 ? '"' : "";
						if (!pushLine(`${continuePrefix}${theme.fg("dim", ` ${line}${closingQuote}`)}`)) return;
					}

					if (strLines.length > maxStrLines) {
						truncated = true;
						pushLine(`${continuePrefix}${theme.fg("dim", ` …(${strLines.length - maxStrLines} more lines)"`)}`);
					}
					return;
				}

				const scalar = formatScalar(val, maxScalarLen);
				pushScalar(lead, scalar);
				return;
			}

			if (Array.isArray(val)) {
				const header = key ? theme.fg("muted", sanitizeTreeKey(key)) : theme.fg("muted", "array");
				pushLine(`${prefix}${iconArray} ${header}`);
				if (val.length === 0) {
					pushLine(
						`${buildTreePrefix(theme, ancestors)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "[]")}`,
					);
					return;
				}
				if (depth >= maxDepth) {
					pushLine(
						`${buildTreePrefix(theme, ancestors)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "…")}`,
					);
					return;
				}
				for (let i = 0; i < val.length; i++) {
					renderNode(val[i], `[${i}]`, ancestors, i === val.length - 1, depth + 1);
					if (lines.length >= maxLines) {
						truncated ||= i < val.length - 1;
						return;
					}
				}
				return;
			}

			if (!isRecord(val)) return;

			const header = key ? theme.fg("muted", sanitizeTreeKey(key)) : theme.fg("muted", "object");
			pushLine(`${prefix}${iconObject} ${header}`);
			if (depth >= maxDepth) {
				pushLine(`${buildTreePrefix(theme, ancestors)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "…")}`);
				return;
			}
			const keys = Object.keys(val);
			if (keys.length === 0) {
				pushLine(
					`${buildTreePrefix(theme, ancestors)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "{}")}`,
				);
				return;
			}
			for (let i = 0; i < keys.length; i++) {
				const childKey = keys[i];
				const child = val[childKey];
				renderNode(child, childKey, ancestors, i === keys.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated ||= i < keys.length - 1;
					return;
				}
			}
		} finally {
			ancestors.pop();
		}
	};

	if (isRecord(value)) {
		const keys = Object.keys(value).filter(key => !(key in HIDDEN_ARG_KEYS));
		for (let i = 0; i < keys.length; i++) {
			renderNode(value[keys[i]!], keys[i], [], i === keys.length - 1, 1);
			if (lines.length >= maxLines) {
				truncated ||= i < keys.length - 1;
				break;
			}
		}
	} else if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			renderNode(value[i], `[${i}]`, [], i === value.length - 1, 1);
			if (lines.length >= maxLines) {
				truncated ||= i < value.length - 1;
				break;
			}
		}
	} else {
		renderNode(value, undefined, [], true, 0);
	}

	return { lines, truncated };
}
