import type { ConventionalAnalysis } from "../../commit/types";

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

const PAST_TENSE_SUMMARY_VERBS = new Set([
	"added",
	"addressed",
	"accelerated",
	"cleaned",
	"configured",
	"corrected",
	"documented",
	"eliminated",
	"enabled",
	"expanded",
	"extracted",
	"implemented",
	"introduced",
	"migrated",
	"moved",
	"optimized",
	"organized",
	"patched",
	"pinned",
	"reduced",
	"removed",
	"renamed",
	"reorganized",
	"restructured",
	"resolved",
	"simplified",
	"updated",
	"upgraded",
]);

export function validateSummary(summary: string, maxChars: number): ValidationResult {
	const errors: string[] = [];
	const trimmed = summary.trim();
	if (!trimmed) {
		errors.push("Summary is empty");
	} else {
		const firstWord = trimmed.split(/\s+/, 1)[0];
		if (!/^[a-z][a-z-]*$/.test(firstWord)) {
			errors.push("Summary must start with a lowercase past-tense verb");
		} else if (!PAST_TENSE_SUMMARY_VERBS.has(firstWord)) {
			errors.push(`Summary must start with a recognized past-tense verb, got "${firstWord}"`);
		}
	}
	if (summary.length > maxChars) {
		errors.push(`Summary exceeds ${maxChars} characters`);
	}
	if (summary.trimEnd().endsWith(".")) {
		errors.push("Summary must not end with a period");
	}
	if (summary.includes("\n")) {
		errors.push("Summary must be a single line");
	}
	return { valid: errors.length === 0, errors };
}

const FORBIDDEN_SCOPES = new Set([
	"src",
	"lib",
	"include",
	"tests",
	"benches",
	"examples",
	"docs",
	"project",
	"app",
	"main",
	"entire",
	"all",
	"misc",
]);

export function validateScope(scope: string | null): ValidationResult {
	if (!scope) return { valid: true, errors: [] };
	const errors: string[] = [];
	const segments = scope.split("/");
	if (segments.length > 2) {
		errors.push("Scope may contain at most two segments");
	}
	for (const segment of segments) {
		if (!segment) {
			errors.push("Scope segments cannot be empty");
			continue;
		}
		if (segment !== segment.toLowerCase()) {
			errors.push("Scope must be lowercase");
		}
		if (FORBIDDEN_SCOPES.has(segment)) {
			errors.push(`Scope is too broad or generic: ${segment}`);
		}
		if (!/^[a-z0-9][a-z0-9-_]*$/.test(segment)) {
			errors.push(`Scope segment has invalid characters: ${segment}`);
		}
	}
	return { valid: errors.length === 0, errors };
}

export function validateAnalysis(analysis: ConventionalAnalysis): ValidationResult {
	const errors: string[] = [];
	const scopeResult = validateScope(analysis.scope);
	if (!scopeResult.valid) {
		errors.push(...scopeResult.errors);
	}
	if (analysis.details.length > 6) {
		errors.push("Analysis may contain at most 6 detail items");
	}
	for (const detail of analysis.details) {
		if (!detail.text.trim()) {
			errors.push("Detail text is empty");
			continue;
		}
		if (!detail.text.trim().endsWith(".")) {
			errors.push(`Detail must end with a period: ${detail.text}`);
		}
		if (detail.text.length > 120) {
			errors.push(`Detail exceeds 120 characters: ${detail.text}`);
		}
	}
	return { valid: errors.length === 0, errors };
}
