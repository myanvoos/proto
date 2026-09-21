/**
 * CLI-to-args mapping for `xd` device dispatches.
 *
 * The Brush `xd` builtin hands us raw shell argv (`xd browser --action run --name main`), so
 * device arguments can be authored as ordinary command lines instead of JSON embedded in shell
 * quotes. This module converts argv + stdin into the device's args object using the tool's JSON
 * wire schema, and renders the inverse (canonical CLI usage lines for docs and TUI previews).
 *
 * Conventions:
 * - `--flag value`, `--flag=value`, bare `--flag` for booleans (`--no-flag` negates).
 * - Repeatable array flags; scalar string arrays also split comma-separated tokens.
 * - Positional values fill remaining scalar properties in usage order (device profiles in
 *   XDEV_POSITIONAL_ORDER pin the friendly order; default is schema declaration order).
 * - A single `{...}` positional stays the legacy full-args JSON form; `--json '<json>'` is the
 *   explicit escape hatch (required for MCP devices, whose schemas are not CLI-mappable).
 * - A flag value of `-` reads that value from stdin; bare `xd <tool>` with piped stdin takes a
 *   JSON object (existing behavior) or, for a single-string device, the plain payload.
 */
import { type Tool as AiTool, toolWireSchema } from "@oh-my-pi/pi-ai";
import { ToolError } from "./tool-errors";

/** Usage-level error (bad flag, missing value): exits 2 so scripts can distinguish it from a tool failure (1). */
export class XdevUsageError extends ToolError {
	constructor(message: string) {
		super(message);
		this.name = "XdevUsageError";
	}
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
	let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
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

export interface XdevFlagSpec {
	name: string;

	type: "string" | "number" | "boolean" | "enum" | "array" | "json";

	enumValues?: readonly string[];

	/** For `type: "array"`: how each entry parses. */
	items?: "string" | "number";

	description?: string;

	required: boolean;
}

type PropKind = "string" | "number" | "boolean" | "enum" | "array" | "json";

function propKind(prop: Record<string, unknown>): PropKind {
	if (Array.isArray(prop.enum)) return "enum";
	if (prop.type === "array") return "array";
	if (prop.type === "boolean") return "boolean";
	if (prop.type === "number" || prop.type === "integer") return "number";
	if (prop.type === "string") return "string";
	return "json";
}

/** Flattened flag specs for a device wire schema, in declaration order. */
export function xdevFlagSpecs(schema: Record<string, unknown>): XdevFlagSpec[] {
	const properties = schema.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
	const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
	const specs: XdevFlagSpec[] = [];
	for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const prop = raw as Record<string, unknown>;
		const kind = propKind(prop);
		let type: XdevFlagSpec["type"] = kind;
		let enumValues: readonly string[] | undefined;
		let items: XdevFlagSpec["items"] | undefined;
		if (kind === "enum") {
			enumValues = (prop.enum as unknown[]).filter(v => typeof v === "string") as string[];
			if (enumValues.length !== (prop.enum as unknown[]).length) type = "json";
		} else if (kind === "array") {
			const itemsSchema = prop.items;
			const itemProp =
				itemsSchema && typeof itemsSchema === "object" && !Array.isArray(itemsSchema)
					? (itemsSchema as Record<string, unknown>)
					: undefined;
			const itemKind = itemProp ? propKind(itemProp) : "json";
			// Scalar arrays map to repeated flags; object/union arrays stay JSON payloads.
			if (itemKind === "string" || itemKind === "number") {
				items = itemKind;
			} else if (itemKind === "enum") {
				items = "string";
			} else {
				type = "json";
			}
		}
		specs.push({
			name,
			type,
			enumValues,
			items,
			description: typeof prop.description === "string" ? prop.description : undefined,
			required: required.has(name),
		});
	}
	return specs;
}

/**
 * Per-device positional property order. Devices absent from this table fall back to schema
 * declaration order (scalar properties only). Override when the natural reading order differs.
 */
const XDEV_POSITIONAL_ORDER: Record<string, readonly string[]> = {
	read: ["path"],
	ask: ["i"],
	web_search: ["query"],
	inspect_media: ["path", "question"],
	orchestrate_spawn: ["message"],
	orchestrate_send: ["to", "message"],
	orchestrate_wait: ["ids"],
	orchestrate_kill: ["id"],
	browser: ["action", "name", "url", "code"],
	monitor: ["op", "command", "match"],
	fleet: ["op", "to", "message"],
	computer: ["code"],
	checkpoint: ["op"],
	rewind: ["op"],
	manage_skill: ["action", "name"],
	checklist: ["op", "task"],
};

function positionalOrder(deviceName: string, schema: Record<string, unknown>): string[] {
	const properties = schema.properties;
	const declared =
		properties && typeof properties === "object" && !Array.isArray(properties)
			? Object.keys(properties as Record<string, unknown>)
			: [];
	const override = XDEV_POSITIONAL_ORDER[deviceName];
	if (override) return override.filter(prop => declared.length === 0 || declared.includes(prop));
	return xdevFlagSpecs(schema)
		.filter(spec => spec.type !== "json" && spec.type !== "array")
		.map(spec => spec.name);
}

function parseScalarToken(spec: XdevFlagSpec, token: string, flag: string): unknown {
	if (spec.type === "boolean") {
		if (token === "true") return true;
		if (token === "false") return false;
		throw new XdevUsageError(`xd: --${flag} expects true or false, got "${token}"`);
	}
	if (spec.type === "number") {
		const value = Number(token);
		if (!Number.isFinite(value)) {
			throw new XdevUsageError(`xd: --${flag} expects a number, got "${token}"`);
		}
		return value;
	}
	if (spec.type === "enum") {
		if (spec.enumValues?.includes(token)) return token;
		const hint = suggestKnownKey(token, spec.enumValues ?? []);
		throw new XdevUsageError(
			`xd: --${flag} expects one of ${spec.enumValues?.map(v => `'${v}'`).join(" | ")}${hint ? ` (did you mean '${hint}'?)` : ""}, got "${token}"`,
		);
	}
	if (spec.type === "json") {
		return parseJsonObjectPayload(token, `--${flag}`);
	}
	return token;
}

function splitArrayToken(token: string): string[] {
	return token
		.split(",")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
}

function looksLikeJson(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export interface XdevCliParse {
	args: Record<string, unknown>;

	/** Args came from a single JSON payload (legacy positional, `--json`, or JSON stdin). */
	viaJson: boolean;
}

export interface XdevCliParseOptions {
	deviceName: string;

	/** Stdin captured by the shell bridge; feeds `-` flag values and the bare-stdin JSON form. */
	stdin?: string;

	/** Stdin hit the bridge's 1 MiB cap; payload forms that consume whole stdin are rejected. */
	stdinTruncated?: boolean;

	/** Skip CLI mapping entirely (MCP devices): only the JSON forms are accepted. */
	jsonOnly?: boolean;
}

/**
 * Convert shell argv (+ optional stdin) into device args according to the tool's wire schema.
 * Accepts the legacy forms too: one positional `{...}` JSON object, or JSON on stdin with no argv.
 */
export function parseXdevCliArgs(
	schema: Record<string, unknown>,
	argv: readonly string[],
	options: XdevCliParseOptions,
): XdevCliParse {
	const specs = xdevFlagSpecs(schema);
	const specByName = new Map(specs.map(spec => [spec.name, spec]));
	const args: Record<string, unknown> = {};
	const positionals: string[] = [];
	let explicitJson: Record<string, unknown> | undefined;
	let endOfFlags = false;
	const needValue = (flag: string): string => {
		throw new XdevUsageError(`xd ${options.deviceName}: --${flag} needs a value`);
	};

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!endOfFlags && token === "--") {
			endOfFlags = true;
			continue;
		}
		if (!endOfFlags && token.startsWith("--") && token.length > 2 && token !== "--") {
			const body = token.slice(2);
			const eq = body.indexOf("=");
			const rawFlag = eq === -1 ? body : body.slice(0, eq);
			const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
			const negated = rawFlag.startsWith("no-");
			const flagName = negated ? rawFlag.slice(3) : rawFlag;

			if (flagName === "json" && !negated) {
				if (explicitJson !== undefined) {
					throw new XdevUsageError(`xd ${options.deviceName}: --json given twice`);
				}
				let payload = inlineValue;
				if (payload === undefined) {
					const next = argv[i + 1];
					if (next === "-") {
						payload = next;
						i++;
					} else if (next !== undefined) {
						// Object payloads may span several shell tokens; consume until it parses.
						const consumed = consumeJsonTokens(argv, i + 1);
						payload = consumed.text;
						i = consumed.nextIndex - 1;
					}
				}
				if (payload === "-") {
					if (options.stdin === undefined) throw needValue("json");
					if (options.stdinTruncated) {
						throw new XdevUsageError("xd: stdin exceeds the 1 MiB bridge limit; pass smaller JSON args");
					}
					payload = options.stdin;
				} else if (payload === undefined) {
					throw needValue("json");
				}
				explicitJson = parseJsonObjectPayload(payload, `${options.deviceName} --json`);
				continue;
			}

			const spec = specByName.get(flagName);
			if (!spec) {
				const hint = suggestKnownKey(
					flagName,
					specs.map(s => s.name),
				);
				throw new XdevUsageError(
					`xd ${options.deviceName}: unknown flag --${rawFlag}${hint ? ` (did you mean --${hint}?)` : ""}. Run \`xd ${options.deviceName} ?\` for docs.`,
				);
			}
			if (negated && spec.type !== "boolean") {
				throw new XdevUsageError(`xd ${options.deviceName}: --no-${flagName} only applies to boolean flags`);
			}
			if (spec.type === "boolean") {
				let value = inlineValue;
				if (value === "-") {
					if (options.stdin === undefined) value = undefined;
					else value = options.stdin.trim();
				}
				if (negated && value === undefined) {
					args[spec.name] = false;
					continue;
				}
				if (value === undefined) {
					args[spec.name] = true;
					continue;
				}
				args[spec.name] = parseScalarToken(spec, value, flagName);
				continue;
			}

			let valueToken = inlineValue;
			if (valueToken === undefined) {
				if (spec.type === "json") {
					const consumed = consumeJsonTokens(argv, i + 1);
					if (consumed.nextIndex === i + 1) throw needValue(flagName);
					valueToken = consumed.text;
					i = consumed.nextIndex - 1;
				} else {
					const next = argv[i + 1];
					if (next === undefined) throw needValue(flagName);
					valueToken = next;
					i++;
				}
			}
			if (valueToken === "-" && options.stdin !== undefined) {
				if (options.stdinTruncated) {
					throw new XdevUsageError("xd: stdin exceeds the 1 MiB bridge limit; pass smaller args");
				}
				valueToken = options.stdin;
			}
			if (spec.type === "array") {
				const entries =
					spec.items === "number"
						? splitArrayToken(valueToken).map(entry => Number(entry))
						: splitArrayToken(valueToken);
				const existing = args[spec.name];
				args[spec.name] = Array.isArray(existing) ? [...existing, ...entries] : entries;
			} else {
				args[spec.name] = parseScalarToken(spec, valueToken, flagName);
			}
			continue;
		}
		positionals.push(token);
	}

	if (explicitJson !== undefined) {
		if (positionals.length > 0) {
			throw new XdevUsageError(`xd ${options.deviceName}: --json cannot be combined with positional args`);
		}
		return { args: explicitJson, viaJson: true };
	}

	// Legacy form: a single positional that is itself a JSON object.
	if (positionals.length === 1 && Object.keys(args).length === 0 && looksLikeJson(positionals[0])) {
		const parsed = tryParseJsonObject(positionals[0]);
		if (parsed) return { args: parsed, viaJson: true };
	}
	if (positionals.some(token => tryParseJsonObject(token) !== undefined)) {
		throw new XdevUsageError(
			`xd ${options.deviceName}: a JSON object payload must be the only positional argument (or use --json '<json>')`,
		);
	}

	if (options.jsonOnly) {
		if (positionals.length === 1) {
			const parsed = tryParseJsonObject(positionals[0]);
			if (!parsed) {
				throw new XdevUsageError(
					`xd ${options.deviceName}: MCP devices take a single JSON args object: xd ${options.deviceName} '{"...":"..."}'`,
				);
			}
			return { args: parsed, viaJson: true };
		}
		throw new XdevUsageError(
			`xd ${options.deviceName}: MCP devices take a single JSON args object: xd ${options.deviceName} '{"...":"..."}'`,
		);
	}

	const order = positionalOrder(options.deviceName, schema).filter(prop => !(prop in args));
	for (const token of positionals) {
		const prop = order.shift();
		if (!prop) {
			throw new XdevUsageError(
				`xd ${options.deviceName}: unexpected positional argument "${token}" — use --flag form; run \`xd ${options.deviceName} ?\` for docs`,
			);
		}
		const spec = specByName.get(prop);
		if (!spec) {
			throw new XdevUsageError(`xd ${options.deviceName}: no schema property for positional "${token}"`);
		}
		if (spec.type === "array") {
			const entries = token
				.split(/\s+/)
				.flatMap(entry => (entry.includes(",") ? splitArrayToken(entry) : [entry.trim()]))
				.filter(entry => entry.length > 0)
				.map(entry => (spec.items === "number" ? Number(entry) : entry));
			const existing = args[spec.name];
			args[spec.name] = Array.isArray(existing) ? [...existing, ...entries] : entries;
		} else if (spec.type === "boolean") {
			args[prop] = token === "true" || token === "yes";
		} else {
			args[prop] = parseScalarToken(spec, token, prop);
		}
	}

	// Bare stdin with no argv keeps the existing JSON-payload behavior; plain-text stdin maps to
	// the first remaining positional property when it is a plain string field.
	if (
		positionals.length === 0 &&
		Object.keys(args).length === 0 &&
		explicitJson === undefined &&
		options.stdin &&
		options.stdin.trim().length > 0
	) {
		if (options.stdinTruncated) {
			throw new XdevUsageError("xd: stdin exceeds the 1 MiB bridge limit; pass smaller JSON args");
		}
		const trimmed = options.stdin.trim();
		const parsedJson = looksLikeJson(trimmed) ? tryParseJsonObject(trimmed) : undefined;
		if (parsedJson) return { args: parsedJson, viaJson: true };
		const prop = order[0];
		const spec = prop ? specByName.get(prop) : undefined;
		if (spec && spec.type === "string") {
			return { args: { [prop]: options.stdin }, viaJson: false };
		}
	}

	return { args, viaJson: false };
}

function parseJsonObjectPayload(token: string, context: string): Record<string, unknown> {
	const parsed = tryParseJsonObject(token);
	if (!parsed) {
		throw new XdevUsageError(`xd: ${context} is not a valid JSON object`);
	}
	return parsed;
}

/** Consume consecutive argv tokens that complete a JSON document starting at startIndex. */
function consumeJsonTokens(argv: readonly string[], startIndex: number): { text: string; nextIndex: number } {
	if (startIndex >= argv.length) return { text: "", nextIndex: startIndex };
	let text = "";
	for (let i = startIndex; i < argv.length; i++) {
		text = text.length === 0 ? argv[i] : `${text} ${argv[i]}`;
		if (tryParseJsonObject(text) !== undefined) return { text, nextIndex: i + 1 };
	}
	// No token boundary completes a JSON object; hand back the first token so the
	// value parser reports the invalid JSON instead of a generic missing-value error.
	return { text: argv[startIndex], nextIndex: startIndex + 1 };
}

function quoteShellValue(value: string): string {
	if (value.length === 0) return "''";
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const CLI_DISPLAY_VALUE_MAX = 96;

function displayValue(value: string): string {
	if (value.length <= CLI_DISPLAY_VALUE_MAX) return value;
	return `${value.slice(0, CLI_DISPLAY_VALUE_MAX - 1).trimEnd()}…`;
}

/** Render device args back into the canonical CLI command line (for TUI previews and hints). */
export function formatXdevCliCommand(name: string, args: Record<string, unknown>): string {
	const parts = [`xd ${name}`];
	for (const [key, raw] of Object.entries(args)) {
		if (raw === undefined) continue;
		if (typeof raw === "boolean") {
			parts.push(raw ? `--${key}` : `--no-${key}`);
			continue;
		}
		if (Array.isArray(raw)) {
			for (const entry of raw) {
				parts.push(`--${key} ${quoteShellValue(displayValue(String(entry)))}`);
			}
			continue;
		}
		if (raw !== null && typeof raw === "object") {
			parts.push(`--${key} ${quoteShellValue(displayValue(JSON.stringify(raw)))}`);
			continue;
		}
		parts.push(`--${key} ${quoteShellValue(displayValue(String(raw)))}`);
	}
	return parts.join(" ");
}

/** One-line usage synopsis generated from the schema, e.g. `xd browser --action <action> [--url <url>] …`. */
export function formatCliUsageSynopsis(name: string, schema: Record<string, unknown>): string {
	const specs = xdevFlagSpecs(schema);
	if (specs.length === 0) return `xd ${name}`;
	const order = positionalOrder(name, schema);
	const parts = [`xd ${name}`];
	const seen = new Set<string>();
	for (const prop of order) {
		const spec = specs.find(s => s.name === prop);
		if (!spec || seen.has(prop)) continue;
		seen.add(prop);
		parts.push(formatCliToken(spec, true));
	}
	for (const spec of specs) {
		if (seen.has(spec.name)) continue;
		seen.add(spec.name);
		parts.push(formatCliToken(spec, false));
	}
	return parts.join(" ");
}

function formatCliToken(spec: XdevFlagSpec, positional: boolean): string {
	const placeholder =
		spec.type === "enum"
			? (spec.enumValues?.join("|") ?? "value")
			: spec.type === "array"
				? `${spec.name}…`
				: spec.name;
	const token = positional
		? `<${placeholder}>`
		: `--${spec.name}${spec.type === "boolean" ? "" : ` <${placeholder}>`}`;
	return spec.required ? token : `[${token}]`;
}

/** Flag reference block for `xd <tool> ?` docs. */
export function formatCliFlagReference(name: string, tool: AiTool): string {
	const schema = toolWireSchema(tool);
	const specs = xdevFlagSpecs(schema);
	const lines = [`Usage: ${formatCliUsageSynopsis(name, schema)}`];
	if (specs.length > 0) {
		lines.push("", "Flags:");
		for (const spec of specs) {
			const typeLabel =
				spec.type === "enum"
					? (spec.enumValues?.join("|") ?? "value")
					: spec.type === "array"
						? spec.items === "number"
							? "number[] (repeatable; comma-splits)"
							: "string[] (repeatable; comma-splits)"
						: spec.type === "json"
							? "JSON"
							: spec.type;
			const flag = spec.type === "boolean" ? `--${spec.name}` : `--${spec.name} <${typeLabel}>`;
			const requiredMark = spec.required ? " (required)" : "";
			const description = spec.description ? ` — ${spec.description}` : "";
			lines.push(`  ${flag}${requiredMark}${description}`);
		}
	}
	lines.push(
		"",
		"Positional values fill the unflagged scalar properties in usage order. `--json '<json>'` passes a raw args object (MCP devices only accept this form). A `-` value reads that flag from stdin; bare `xd " +
			name +
			"` with piped stdin takes a JSON object (or the plain payload for single-string devices).",
	);
	return lines.join("\n");
}
