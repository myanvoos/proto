import { detectTerminalId, getTerminalInfo } from "@oh-my-pi/pi-tui";
import type { ColorMode, ColorValue } from "./schema";

export function detectColorMode(env: NodeJS.ProcessEnv = Bun.env): ColorMode {
	const terminal = getTerminalInfo(detectTerminalId(env));
	return terminal.trueColor ? "truecolor" : "256color";
}

export function colorToAnsi(color: string, mode: ColorMode): string {
	const format = mode === "truecolor" ? "ansi-16m" : "ansi-256";
	const ansi = Bun.color(color, format);
	if (ansi === null) {
		throw new Error(`Invalid color value: ${color}`);
	}
	return ansi;
}

export function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (typeof color === "string") {
		return colorToAnsi(color, mode);
	}
	throw new Error(`Invalid color value: ${color}`);
}

export function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	const ansi = colorToAnsi(color, mode);
	return ansi.replace("\x1b[38;", "\x1b[48;");
}

export function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

export function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

export function resolveToHex(value: string | number, isLight: boolean): string {
	if (typeof value === "number") return ansi256ToHex(value);
	if (value === "") return isLight ? "#000000" : "#e5e5e7";
	return value;
}

function ansi256ToHex(index: number): string {
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}
