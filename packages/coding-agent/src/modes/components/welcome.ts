import { type Component, padding, TERMINAL, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { BINARY_NAME } from "@oh-my-pi/pi-utils";
import { theme } from "../theme/theme";

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting" | "available";
	fileTypes: string[];
}

const VALUE_LINE = "A coding agent with the IDE wired in.";

const SILVER_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[116, 123, 134],
	[198, 203, 212],
	[230, 233, 238],
];

const SILVER_RAMP_256 = [243, 250, 255];

function silverEscape(intensity: number): string {
	const t = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
	if (TERMINAL.trueColor) {
		const seg = t * (SILVER_STOPS.length - 1);
		const i = Math.min(SILVER_STOPS.length - 2, Math.floor(seg));
		const f = seg - i;
		const a = SILVER_STOPS[i]!;
		const b = SILVER_STOPS[i + 1]!;
		const r = Math.round(a[0] + (b[0] - a[0]) * f);
		const g = Math.round(a[1] + (b[1] - a[1]) * f);
		const bl = Math.round(a[2] + (b[2] - a[2]) * f);
		return `\x1b[38;2;${r};${g};${bl}m`;
	}
	const idx = Math.min(SILVER_RAMP_256.length - 1, Math.max(0, Math.round(t * (SILVER_RAMP_256.length - 1))));
	return `\x1b[38;5;${SILVER_RAMP_256[idx]}m`;
}

function silverWordmark(text: string): string {
	let out = "";
	for (const char of text) {
		if (char === " ") {
			out += char;
			continue;
		}
		out += `${silverEscape(0.55)}${char}\x1b[0m`;
	}
	return out;
}

function centerLine(text: string, width: number): string {
	const visLen = visibleWidth(text);
	if (visLen >= width) return truncateToWidth(text, width);
	return padding(Math.floor((width - visLen) / 2)) + text;
}

/**
 * Hero-card wordmark text: letter-spaced binary name under the silver ramp,
 * bolded. Callers center it against the terminal width.
 */
export function heroWordmark(): string {
	return theme.bold(silverWordmark(BINARY_NAME.split("").join(" ")));
}

/**
 * Hero-card metadata text: `v<version> · <model> · <provider>`, falling back to
 * a `/model` hint when no model is selected yet. Callers center it.
 */
export function heroMeta(version: string, modelName?: string, providerName?: string): string {
	const model = modelName && providerName ? `${modelName} · ${providerName}` : modelName || providerName;
	return model
		? theme.fg("dim", `v${version} · ${model}`)
		: theme.fg("dim", `v${version} · no model yet · `) + theme.fg("accent", "/model");
}

export class WelcomeComponent implements Component {
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;
	#widthEpochRevision = 0;

	constructor(
		private version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		_lspServers: LspServerInfo[] = [],
	) {}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
		this.#widthEpochRevision++;
	}

	getNativeScrollbackWidthEpochRevision(): number {
		return this.#widthEpochRevision;
	}

	setVersion(version: string): void {
		this.version = version;
		this.invalidate();
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
		this.invalidate();
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
		this.invalidate();
	}

	setLspServers(_servers: LspServerInfo[]): void {}

	render(termWidth: number): readonly string[] {
		if (this.#cachedLines && this.#cachedWidth === termWidth) {
			return this.#cachedLines;
		}
		const lines = this.#renderLines(termWidth);
		this.#cachedLines = lines;
		this.#cachedWidth = termWidth;
		return lines;
	}

	#renderLines(termWidth: number): string[] {
		if (termWidth < 30) return [];
		const lines = this.#header(termWidth);
		lines.push("");
		const recent = this.recentSessions[0];
		if (recent) {
			const nameBudget = Math.max(8, Math.min(40, termWidth - 30));
			const name = visibleWidth(recent.name) > nameBudget ? truncateToWidth(recent.name, nameBudget) : recent.name;
			lines.push(
				centerLine(
					theme.fg("muted", name) + theme.fg("dim", ` · ${recent.timeAgo} — `) + theme.fg("accent", "/resume"),
					termWidth,
				),
			);
		}
		const hint = recent
			? theme.fg("dim", "more: ") + theme.fg("accent", "/settings")
			: theme.fg("dim", "more: ") + theme.fg("accent", "/resume") + theme.fg("dim", " · /settings");
		lines.push(centerLine(hint, termWidth));
		return lines;
	}

	#header(termWidth: number): string[] {
		return [
			centerLine(heroWordmark(), termWidth),
			"",
			centerLine(heroMeta(this.version, this.modelName, this.providerName), termWidth),
			centerLine(theme.fg("muted", VALUE_LINE), termWidth),
		];
	}
}
