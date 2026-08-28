const TURN_BUDGET = /(?:^|\s)\+(\d+(?:\.\d+)?)([km])?(!)?(?=\s|$)/i;

export interface TurnBudget {
	total: number;

	hard: boolean;
}

export function parseTurnBudget(text: string): TurnBudget | null {
	const match = TURN_BUDGET.exec(text);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	const unit = match[2]?.toLowerCase();
	const multiplier = unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1;
	return { total: Math.round(value * multiplier), hard: match[3] === "!" };
}
