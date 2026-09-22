import { getEnumValues, getType, isCredential, SETTINGS_SCHEMA, type SettingPath } from "./settings-schema";

export type ConfigIssueKind = "unknown-setting" | "invalid-value" | "quarantined-config" | "unmigrated-legacy";

export interface ConfigIssue {
	kind: ConfigIssueKind;

	source: string;

	key?: string;

	message: string;
}

export interface NormalizeOptions {
	source: string;

	reportUnknown?: boolean;
}

export interface NormalizeResult {
	settings: Record<string, unknown>;

	issues: ConfigIssue[];
}

const SETTING_PATHS = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

const KNOWN_PATHS: ReadonlySet<string> = new Set<string>(SETTING_PATHS);

const PATH_PREFIXES: ReadonlySet<string> = (() => {
	const prefixes = new Set<string>();
	for (const settingPath of SETTING_PATHS) {
		const segments = settingPath.split(".");
		for (let i = 1; i < segments.length; i++) {
			prefixes.add(segments.slice(0, i).join("."));
		}
	}
	return prefixes;
})();

const BOOLEAN_WORDS = new Map<string, boolean>([
	["true", true],
	["yes", true],
	["on", true],
	["1", true],
	["false", false],
	["no", false],
	["off", false],
	["0", false],
]);

const PREVIEW_LENGTH = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function describeExpectedType(settingPath: SettingPath): string {
	const values = getEnumValues(settingPath);
	if (values && values.length > 0) return `one of ${values.join(", ")}`;
	switch (getType(settingPath)) {
		case "boolean":
			return "a boolean";
		case "number":
			return "a number";
		case "array":
			return "an array";
		case "record":
			return "a mapping";
		default:
			return "a string";
	}
}

function previewValue(settingPath: SettingPath, value: unknown): string {
	if (isCredential(settingPath)) return "********";
	if (isRecord(value)) return "a mapping";
	if (Array.isArray(value)) return "an array";
	const text = typeof value === "string" ? JSON.stringify(value) : String(value);
	return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

function coerceValue(settingPath: SettingPath, value: unknown): { ok: true; value: unknown } | { ok: false } {
	switch (getType(settingPath)) {
		case "boolean": {
			if (typeof value === "boolean") return { ok: true, value };
			const word =
				typeof value === "string"
					? value.trim().toLowerCase()
					: typeof value === "number"
						? String(value)
						: undefined;
			const coerced = word === undefined ? undefined : BOOLEAN_WORDS.get(word);
			return coerced === undefined ? { ok: false } : { ok: true, value: coerced };
		}
		case "number": {
			if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
			if (typeof value !== "string" || value.trim() === "") return { ok: false };
			const parsed = Number(value.trim());
			return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false };
		}
		case "enum": {
			if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") return { ok: false };
			const text = String(value).trim();
			const values = getEnumValues(settingPath);
			return values?.includes(text) ? { ok: true, value: text } : { ok: false };
		}
		case "array":
			return Array.isArray(value) ? { ok: true, value } : { ok: false };
		case "record":
			return isRecord(value) ? { ok: true, value } : { ok: false };
		default:
			if (typeof value === "string") return { ok: true, value };
			if (typeof value === "number" || typeof value === "boolean") return { ok: true, value: String(value) };
			return { ok: false };
	}
}

function setByPath(target: Record<string, unknown>, segments: readonly string[], value: unknown): void {
	let current = target;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		const next = current[segment];
		if (!isRecord(next)) {
			const created: Record<string, unknown> = {};
			current[segment] = created;
			current = created;
			continue;
		}
		current = next;
	}
	current[segments[segments.length - 1]] = value;
}

function walkLayer(
	node: Record<string, unknown>,
	prefix: string,
	target: Record<string, unknown>,
	issues: ConfigIssue[],
	options: NormalizeOptions,
): void {
	for (const [key, value] of Object.entries(node)) {
		const dotted = prefix ? `${prefix}.${key}` : key;

		if (KNOWN_PATHS.has(dotted)) {
			const settingPath = dotted as SettingPath;
			if (value === null || value === undefined) continue;
			const coerced = coerceValue(settingPath, value);
			if (!coerced.ok) {
				issues.push({
					kind: "invalid-value",
					source: options.source,
					key: dotted,
					message: `${options.source}: "${dotted}" expects ${describeExpectedType(settingPath)}; ignoring ${previewValue(settingPath, value)}`,
				});
				continue;
			}
			setByPath(target, dotted.split("."), coerced.value);
			continue;
		}

		if (PATH_PREFIXES.has(dotted)) {
			if (isRecord(value)) {
				walkLayer(value, dotted, target, issues, options);
				continue;
			}
			if (value === null || value === undefined) continue;
			issues.push({
				kind: "invalid-value",
				source: options.source,
				key: dotted,
				message: `${options.source}: "${dotted}" is a group of settings, not a value; ignoring it`,
			});
			continue;
		}

		setByPath(target, dotted.split("."), value);
		if (options.reportUnknown) {
			issues.push({
				kind: "unknown-setting",
				source: options.source,
				key: dotted,
				message: `${options.source}: unknown setting "${dotted}"; it has no effect`,
			});
		}
	}
}

export function normalizeSettingsLayer(raw: Record<string, unknown>, options: NormalizeOptions): NormalizeResult {
	const settings: Record<string, unknown> = {};
	const issues: ConfigIssue[] = [];
	walkLayer(raw, "", settings, issues, options);
	return { settings, issues };
}

export function formatConfigIssue(issue: ConfigIssue): string {
	return `Config: ${issue.message}`;
}
