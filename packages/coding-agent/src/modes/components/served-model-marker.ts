import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { parseKnownModel, semverEqual } from "@oh-my-pi/pi-catalog/identity";
import { type Component, truncateToWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";

export interface ServedModelMismatch {
	requested: string;
	served: string;
	provider: string;
	upstreamProvider?: string;
}

// Compares parsed identities, not text: a snapshot suffix (`claude-haiku-4-5-20251001`) or a
// gateway prefix (`anthropic/claude-opus-5`) is the same model, while another family or version
// is a substitution. Ids that do not parse — Anthropic's internal codenames (`numbat-v6-…`) show
// up as served ids on first-party traffic — are unverifiable, not mismatches.
export function detectServedModelMismatch(message: AssistantMessage): ServedModelMismatch | undefined {
	const served = message.upstreamModel;
	if (!served || served === message.model) return undefined;
	const requested = parseKnownModel(message.model);
	const actual = parseKnownModel(served);
	if (requested.family === "unknown" || actual.family === "unknown") return undefined;
	const requestedLine = requested.family === "openai" ? requested.variant : requested.kind;
	const actualLine = actual.family === "openai" ? actual.variant : actual.kind;
	if (
		requested.family === actual.family &&
		requestedLine === actualLine &&
		semverEqual(requested.version, actual.version)
	) {
		return undefined;
	}
	return {
		requested: message.model,
		served,
		provider: message.provider,
		...(message.upstreamProvider ? { upstreamProvider: message.upstreamProvider } : {}),
	};
}

// A substituting gateway swaps every turn, so each (requested → served) pair is flagged once per
// transcript; rebuilds replace the tracker so replaying history re-flags the same first turn.
export class ServedModelTracker {
	readonly #announced = new Set<string>();

	check(message: AssistantMessage): ServedModelMismatch | undefined {
		const mismatch = detectServedModelMismatch(message);
		if (!mismatch) return undefined;
		const key = `${mismatch.provider}\0${mismatch.requested}\0${mismatch.served}`;
		if (this.#announced.has(key)) return undefined;
		this.#announced.add(key);
		return mismatch;
	}
}

const SERVED_MODEL_RULE_WIDTH = 10;

export class ServedModelMarkerComponent implements Component {
	#cache?: { width: number; lines: string[] };

	constructor(private readonly info: ServedModelMismatch) {}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) {
			return this.#cache.lines;
		}
		const lines = ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const dot = theme.sep.dot.trim();
		const via = this.info.upstreamProvider
			? `${this.info.provider}/${this.info.upstreamProvider}`
			: this.info.provider;
		const label = `${theme.status.warning} served ${this.info.served} ${dot} requested ${this.info.requested} ${dot} via ${via}`;
		const labelWidth = Bun.stringWidth(label, { countAnsiEscapeCodes: false });
		const ruleWidth = Math.min(SERVED_MODEL_RULE_WIDTH, width - labelWidth - 1);
		if (ruleWidth < 1) {
			return truncateToWidth(theme.fg("warning", label), width);
		}
		return `${theme.fg("dim", theme.tree.horizontal.repeat(ruleWidth))} ${theme.fg("warning", label)}`;
	}
}
