import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export const BUILTIN_DEFAULTS_PROVIDER_ID = "builtin-defaults";

export interface RuleFrontmatter {
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;

	condition?: string | string[];

	astCondition?: string | string[];

	scope?: string | string[];

	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
	[key: string]: unknown;
}

export interface Rule {
	name: string;

	path: string;

	content: string;

	globs?: string[];

	alwaysApply?: boolean;

	description?: string;

	condition?: string[];

	astCondition?: string[];

	scope?: string[];

	interruptMode?: "never" | "prose-only" | "tool-only" | "always";

	_source: SourceMeta;
}

function normalizeRuleField(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const token = value.trim();
		return token.length > 0 ? [token] : undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}

	const tokens = value
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(item => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}

	return Array.from(new Set(tokens));
}

function splitScopeTokens(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			current += char;
			if (char === quote && value[i - 1] !== "\\") {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "(") {
			parenDepth++;
			current += char;
			continue;
		}
		if (char === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
			current += char;
			continue;
		}
		if (char === "[") {
			bracketDepth++;
			current += char;
			continue;
		}
		if (char === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
			current += char;
			continue;
		}
		if (char === "{") {
			braceDepth++;
			current += char;
			continue;
		}
		if (char === "}") {
			braceDepth = Math.max(0, braceDepth - 1);
			current += char;
			continue;
		}
		if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			const token = current.trim();
			if (token.length > 0) {
				tokens.push(token);
			}
			current = "";
			continue;
		}
		current += char;
	}

	const tail = current.trim();
	if (tail.length > 0) {
		tokens.push(tail);
	}

	return tokens;
}
function normalizeScopeField(value: unknown): string[] | undefined {
	const normalized = normalizeRuleField(value);
	if (!normalized) {
		return undefined;
	}

	const tokens = normalized
		.flatMap(splitScopeTokens)
		.map(token => {
			const quote = token[0];
			if (token.length >= 2 && (quote === '"' || quote === "'") && token[token.length - 1] === quote) {
				return token.slice(1, -1).trim();
			}
			return token;
		})
		.filter(item => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}
	return Array.from(new Set(tokens));
}

export function parseRuleConditionAndScope(
	frontmatter: RuleFrontmatter,
): Pick<Rule, "condition" | "astCondition" | "scope"> {
	const rawCondition = frontmatter.condition ?? frontmatter.ttsr_trigger ?? frontmatter.ttsrTrigger;
	const parsedCondition = normalizeRuleField(rawCondition);
	const astCondition = normalizeRuleField(frontmatter.astCondition);
	const parsedScope = normalizeScopeField(frontmatter.scope);

	const condition: string[] = [];
	for (const token of parsedCondition ?? []) {
		condition.push(token);
	}

	const scope = [...(parsedScope ?? [])];
	return {
		condition: condition.length > 0 ? Array.from(new Set(condition)) : undefined,
		astCondition,
		scope: scope.length > 0 ? Array.from(new Set(scope)) : undefined,
	};
}

const INLINE_FLAG_PREFIX = /^\(\?([a-z]+)\)/;

const TRANSLATABLE_INLINE_FLAGS = /^[ims]+$/;

export function compileRuleCondition(pattern: string): RegExp {
	const match = INLINE_FLAG_PREFIX.exec(pattern);
	if (match && TRANSLATABLE_INLINE_FLAGS.test(match[1])) {
		const flags = Array.from(new Set(match[1])).join("");
		return new RegExp(pattern.slice(match[0].length), flags);
	}
	return new RegExp(pattern);
}

let activeRules: readonly Rule[] = [];

export function getActiveRules(): readonly Rule[] {
	return activeRules;
}

export function setActiveRules(value: readonly Rule[]): void {
	activeRules = value;
}

export function resetActiveRulesForTests(): void {
	activeRules = [];
}

export const ruleCapability = defineCapability<Rule>({
	id: "rules",
	displayName: "Rules",
	description: "Project-specific rules and constraints (Cursor MDC, Windsurf, Cline formats)",
	key: rule => rule.name,
	toExtensionId: rule => `rule:${rule.name}`,
	validate: rule => {
		if (!rule.name) return "Missing rule name";
		if (!rule.path) return "Missing rule path";
		if (!rule.content || typeof rule.content !== "string") return "Rule must have content";
		return undefined;
	},
});
