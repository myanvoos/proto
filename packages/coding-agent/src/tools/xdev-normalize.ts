import { ToolError } from "./tool-errors";

/**
 * Agent-supplied device args arrive from many harnesses (Claude Code, Codex, kernel APIs), so
 * intuitive-but-wrong shapes recur: `to` for a send recipient (Claude Code SendMessage), `worker`
 * for an id, snake_case timeouts, "prompt" for the spawn instruction, a result-count `limit`.
 * Canonical names stay as declared by each tool; this layer only repairs recorded confusion
 * shapes before schema validation, and reports every repair as a note.
 */

export interface XdArgNormalization {
	args: Record<string, unknown>;

	notes: string[];
}

type NormalizeRule =
	| { kind: "rename"; from: string; to: string; scale?: number }
	| { kind: "wrapString"; from: string; to: string }
	| { kind: "enumMap"; field: string; map: Record<string, string> }
	| { kind: "coerceNumbers"; field: string }
	| { kind: "forbid"; keys: string[]; message: string }
	| { kind: "inferOp"; when: readonly string[]; op: string };

const DEVICE_RULES: Record<string, readonly NormalizeRule[]> = {
	fleet: [
		{ kind: "inferOp", when: ["message", "to", "target"], op: "send" },
		{ kind: "rename", from: "to", to: "id" },
		{ kind: "rename", from: "target", to: "id" },
		{ kind: "rename", from: "action", to: "op" },
		{ kind: "rename", from: "timeout_seconds", to: "timeoutMs", scale: 1000 },
		{ kind: "rename", from: "timeoutSeconds", to: "timeoutMs", scale: 1000 },
	],
	orchestrate_spawn: [
		{ kind: "rename", from: "prompt", to: "message" },
		{ kind: "rename", from: "name", to: "label" },
	],
	orchestrate_send: [
		{ kind: "rename", from: "worker", to: "id" },
		{ kind: "rename", from: "workerId", to: "id" },
		{ kind: "rename", from: "session", to: "id" },
		{ kind: "rename", from: "to", to: "id" },
	],
	orchestrate_wait: [
		{ kind: "wrapString", from: "worker", to: "ids" },
		{ kind: "wrapString", from: "workerId", to: "ids" },
		{ kind: "wrapString", from: "id", to: "ids" },
		{ kind: "rename", from: "timeout", to: "timeoutMs" },
		{ kind: "rename", from: "timeout_ms", to: "timeoutMs" },
		{ kind: "rename", from: "timeout_seconds", to: "timeoutMs", scale: 1000 },
		{ kind: "rename", from: "timeoutSeconds", to: "timeoutMs", scale: 1000 },
	],
	orchestrate_kill: [
		{ kind: "rename", from: "worker", to: "id" },
		{ kind: "rename", from: "workerId", to: "id" },
		{ kind: "rename", from: "name", to: "id" },
		{ kind: "rename", from: "to", to: "id" },
	],
	monitor: [
		{ kind: "rename", from: "action", to: "op" },
		{ kind: "rename", from: "name", to: "label" },
		{ kind: "wrapString", from: "job", to: "ids" },
		{ kind: "wrapString", from: "id", to: "ids" },
	],
	recall: [
		{ kind: "rename", from: "q", to: "query" },
		{ kind: "enumMap", field: "mode", map: { search: "hybrid" } },
		{ kind: "coerceNumbers", field: "expand" },
		{ kind: "coerceNumbers", field: "page" },
		{
			kind: "forbid",
			keys: ["limit", "max_results"],
			message:
				"recall has no result-count parameter — result volume is budgeted automatically. `page` is the 1-based page NUMBER, not page size. Narrow with a more specific query or regex.",
		},
	],
};

function coerceNumeric(value: unknown): unknown {
	if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
	return value;
}

function applyRule(rule: NormalizeRule, args: Record<string, unknown>, notes: string[]): void {
	switch (rule.kind) {
		case "rename": {
			if (!(rule.from in args)) return;
			const value = args[rule.from];
			delete args[rule.from];
			if (rule.to in args) {
				notes.push(`ignored \`${rule.from}\` — \`${rule.to}\` already set`);
				return;
			}
			args[rule.to] = rule.scale === undefined || typeof value !== "number" ? value : value * rule.scale;
			notes.push(
				rule.scale === undefined
					? `treated \`${rule.from}\` as \`${rule.to}\``
					: `converted \`${rule.from}\` (seconds) → \`${rule.to}\` (ms)`,
			);
			return;
		}
		case "wrapString": {
			if (!(rule.from in args)) return;
			const value = args[rule.from];
			delete args[rule.from];
			if (rule.to in args) {
				notes.push(`ignored \`${rule.from}\` — \`${rule.to}\` already set`);
				return;
			}
			args[rule.to] = typeof value === "string" ? [value] : value;
			notes.push(`treated \`${rule.from}\` as \`${rule.to}\` list`);
			return;
		}
		case "enumMap": {
			const value = args[rule.field];
			if (typeof value !== "string" || !(value in rule.map)) return;
			args[rule.field] = rule.map[value];
			notes.push(`treated \`${rule.field}:"${value}"\` as "${rule.map[value]}"`);
			return;
		}
		case "coerceNumbers": {
			const value = args[rule.field];
			if (typeof value === "string") {
				const coerced = coerceNumeric(value);
				if (coerced !== value) {
					args[rule.field] = coerced;
					notes.push(`coerced \`${rule.field}\` to number`);
				}
				return;
			}
			if (Array.isArray(value)) {
				const coerced = value.map(coerceNumeric);
				if (coerced.some((item, i) => item !== value[i])) {
					args[rule.field] = coerced;
					notes.push(`coerced \`${rule.field}\` entries to numbers`);
				}
			}
			return;
		}
		case "forbid": {
			for (const key of rule.keys) {
				if (key in args) throw new ToolError(rule.message);
			}
			return;
		}
		case "inferOp": {
			if ("op" in args) return;
			if (!rule.when.some(key => key in args)) return;
			args.op = rule.op;
			notes.push(`inferred \`op:"${rule.op}"\` — pass \`op\` explicitly next time`);
			return;
		}
	}
}

/** Repairs recorded confusion shapes for known devices; passes other devices through untouched. */
export function normalizeXdDeviceArgs(deviceName: string, args: Record<string, unknown>): XdArgNormalization {
	const rules = DEVICE_RULES[deviceName];
	if (!rules) return { args, notes: [] };
	const notes: string[] = [];
	for (const rule of rules) applyRule(rule, args, notes);
	return { args, notes };
}

/** Closest accepted key for an unknown key, for "did you mean" hints in validation errors. */
export function suggestKnownKey(unknown: string, accepted: readonly string[]): string | undefined {
	const lower = unknown.toLowerCase();
	const caseless = accepted.find(key => key.toLowerCase() === lower);
	if (caseless) return caseless;
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const key of accepted) {
		if (Math.abs(key.length - unknown.length) > 2) continue;
		const distance = levenshtein(unknown.toLowerCase(), key.toLowerCase(), bestDistance);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = key;
		}
	}
	return bestDistance <= 2 ? best : undefined;
}

function levenshtein(a: string, b: string, cap: number): number {
	if (a === b) return 0;
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
			current.push(value);
			if (value < rowMin) rowMin = value;
		}
		if (rowMin > cap) return cap + 1;
		previous = current;
	}
	return previous[b.length];
}
