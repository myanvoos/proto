import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { expandAtImports } from "../discovery/at-imports";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";
import { collectConfigCandidates } from "./watchdog";

export interface AdvisorConfig {
	name: string;
	model?: string;
	tools?: string[];
	instructions?: string;

	enabled?: boolean;
}

export type AdvisorRuntimeStatus = "running" | "paused" | "quota_exhausted" | "error" | "no_model";

interface DiscoveredAdvisors {
	advisors: AdvisorConfig[];
	sharedInstructions: string | undefined;
	/** Unparseable files and dropped entries, surfaced as one aggregated warning so a broken entry never fails silently. */
	warnings: string[];
}

const advisorEntrySchema = type({
	name: "string",
	"model?": "string",
	"tools?": "string[]",
	"instructions?": "string",
	"enabled?": "boolean",
});

type AdvisorYamlEntry = typeof advisorEntrySchema.infer;

/**
 * Validates one parsed `WATCHDOG.yml` document per entry: a malformed advisor drops out with a warning naming it while
 * the healthy entries still load (whole-document validation disabled every advisor in the file and blanked the editor,
 * whose next save then wiped them).
 */
function parseWatchdogDoc(
	doc: Record<string, unknown>,
	filePath: string,
): { instructions: string | undefined; entries: AdvisorYamlEntry[]; warnings: string[] } {
	const warnings: string[] = [];
	const rawInstructions = doc.instructions;
	const instructions = typeof rawInstructions === "string" ? rawInstructions : undefined;
	if (rawInstructions !== undefined && instructions === undefined) {
		warnings.push(`${filePath}: instructions must be a string — ignored`);
	}
	const rawAdvisors = doc.advisors;
	if (rawAdvisors !== undefined && !Array.isArray(rawAdvisors)) {
		warnings.push(`${filePath}: advisors must be a list — ignored`);
	}
	const entries: AdvisorYamlEntry[] = [];
	for (const [index, rawEntry] of (Array.isArray(rawAdvisors) ? rawAdvisors : []).entries()) {
		const result = advisorEntrySchema(rawEntry);
		if (result instanceof type.errors) {
			const rawName =
				rawEntry && typeof rawEntry === "object" ? (rawEntry as Record<string, unknown>).name : undefined;
			const label = typeof rawName === "string" && rawName.trim() ? `"${rawName}"` : `#${index + 1}`;
			warnings.push(`${filePath}: advisor ${label} dropped — ${result.summary}`);
			continue;
		}
		entries.push(result);
	}
	return { instructions, entries, warnings };
}

export function slugifyAdvisorName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "advisor";
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR = "\u0000";

export function getOrCreateAdvisorProviderSessionId(
	ids: Map<string, string>,
	primarySessionId: string | undefined,
	slug: string,
	randomSessionId: () => string = () => Bun.randomUUIDv7(),
): string | undefined {
	if (!primarySessionId) return undefined;
	const key = `${primarySessionId}${ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR}${slug}`;
	const existing = ids.get(key);
	if (existing) return existing;

	const next = randomSessionId();
	if (!UUID_V7_PATTERN.test(next)) {
		throw new Error("Advisor provider session id generator returned a non-UUIDv7 value");
	}
	ids.set(key, next);
	return next;
}

const KNOWN_TOOL_NAMES = new Set<string>(BUILTIN_TOOL_NAMES);

function filterAdvisorTools(tools: string[] | undefined, sourcePath: string): string[] | undefined {
	if (tools === undefined) return undefined;
	if (tools.length === 0) return [];
	const filtered = normalizeToolNames(tools).filter(name => {
		if (KNOWN_TOOL_NAMES.has(name)) return true;
		logger.warn("Advisor config: dropping unknown tool", { path: sourcePath, tool: name });
		return false;
	});
	return filtered.length > 0 ? filtered : undefined;
}

export async function discoverAdvisorConfigs(cwd: string, agentDir?: string): Promise<DiscoveredAdvisors> {
	const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"]);
	const advisors = new Map<string, AdvisorConfig>();
	const sharedParts: string[] = [];
	const warnings: string[] = [];
	const warn = (message: string, filePath: string): void => {
		warnings.push(message);
		logger.warn("Advisor config", { path: filePath, error: message });
	};

	for (const item of items) {
		let parsed: unknown;
		try {
			parsed = YAML.parse(item.content);
		} catch (err) {
			warn(`${item.path}: failed to parse YAML (${String(err)}) — file skipped`, item.path);
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warn(`${item.path}: expected a YAML mapping — file skipped`, item.path);
			continue;
		}
		const doc = parseWatchdogDoc(parsed as Record<string, unknown>, item.path);
		for (const message of doc.warnings) warn(message, item.path);

		if (doc.instructions?.trim()) {
			const expanded = (await expandAtImports(doc.instructions, item.path)).trim();
			if (expanded) sharedParts.push(expanded);
		}

		for (const entry of doc.entries) {
			const slug = slugifyAdvisorName(entry.name);
			const instructions = entry.instructions?.trim()
				? (await expandAtImports(entry.instructions, item.path)).trim() || undefined
				: undefined;
			advisors.set(slug, {
				name: entry.name,
				model: entry.model?.trim() || undefined,
				tools: filterAdvisorTools(entry.tools, item.path),
				instructions,
				enabled: entry.enabled,
			});
		}
	}

	return {
		advisors: [...advisors.values()],
		sharedInstructions: sharedParts.length > 0 ? sharedParts.join("\n\n") : undefined,
		warnings,
	};
}

export type AdvisorConfigScope = "project" | "user";

export interface WatchdogConfigDoc {
	instructions?: string;
	advisors: AdvisorConfig[];
	/** Problems found while loading (unparseable file, dropped entries); shown while the file is active in the editor. */
	warnings?: string[];
}

export function advisorConfigFilePath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): string {
	return path.join(scope === "user" ? dirs.agentDir : dirs.projectDir, "WATCHDOG.yml");
}

export async function resolveAdvisorConfigEditPath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): Promise<string> {
	const dir = scope === "user" ? dirs.agentDir : dirs.projectDir;
	const yml = path.join(dir, "WATCHDOG.yml");
	const yaml = path.join(dir, "WATCHDOG.yaml");
	if (!(await Bun.file(yml).exists()) && (await Bun.file(yaml).exists())) return yaml;
	return yml;
}

export async function loadWatchdogConfigFile(filePath: string): Promise<WatchdogConfigDoc> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err))
			logger.warn("Advisor config: failed to read for edit", { path: filePath, error: String(err) });
		return { advisors: [] };
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(text);
	} catch (err) {
		logger.warn("Advisor config: failed to parse for edit", { path: filePath, error: String(err) });
		return { advisors: [], warnings: [`${filePath}: failed to parse YAML (${String(err)})`] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		const message = `${filePath}: expected a YAML mapping — file skipped`;
		logger.warn("Advisor config", { path: filePath, error: message });
		return { advisors: [], warnings: [message] };
	}
	const { instructions, entries, warnings } = parseWatchdogDoc(parsed as Record<string, unknown>, filePath);
	for (const message of warnings) logger.warn("Advisor config", { path: filePath, error: message });
	const advisors = entries.map(a => {
		const advisor: AdvisorConfig = { name: a.name };
		if (a.model?.trim()) advisor.model = a.model;
		if (a.tools !== undefined) advisor.tools = [...a.tools];
		if (a.instructions?.trim()) advisor.instructions = a.instructions;
		if (a.enabled !== undefined) advisor.enabled = a.enabled;
		return advisor;
	});
	const doc: WatchdogConfigDoc = { advisors };
	if (instructions?.trim()) doc.instructions = instructions;
	if (warnings.length > 0) doc.warnings = warnings;
	return doc;
}

function appendYamlString(lines: string[], indent: string, key: string, value: string): void {
	const hasSignificantLeadingWhitespace = value.split("\n").some(line => /^[ \t]/.test(line));
	if (!value.includes("\n") || hasSignificantLeadingWhitespace) {
		lines.push(`${indent}${key}: ${YAML.stringify(value)}`);
		return;
	}
	const normalized = value.replaceAll("\r\n", "\n");
	let trailingNewlines = 0;
	for (let index = normalized.length - 1; index >= 0 && normalized[index] === "\n"; index--) {
		trailingNewlines++;
	}
	const chomp = trailingNewlines === 0 ? "|2-" : trailingNewlines === 1 ? "|2" : "|2+";
	const body = trailingNewlines === 0 ? normalized : normalized.slice(0, -trailingNewlines);
	lines.push(`${indent}${key}: ${chomp}`);
	for (const line of body.split("\n")) {
		lines.push(`${indent}  ${line}`);
	}
	for (let index = 1; index < trailingNewlines; index++) {
		lines.push(`${indent}  `);
	}
}

export function serializeWatchdogConfig(doc: WatchdogConfigDoc): string {
	const lines: string[] = [];
	if (doc.instructions?.trim()) appendYamlString(lines, "", "instructions", doc.instructions);
	if (doc.advisors.length > 0) {
		lines.push("advisors:");
		for (const advisor of doc.advisors) {
			lines.push(`  - name: ${YAML.stringify(advisor.name)}`);
			if (advisor.model?.trim()) lines.push(`    model: ${YAML.stringify(advisor.model)}`);
			if (advisor.tools !== undefined) {
				if (advisor.tools.length === 0) {
					lines.push("    tools: []");
				} else {
					lines.push("    tools:");
					for (const tool of advisor.tools) {
						lines.push(`      - ${YAML.stringify(tool)}`);
					}
				}
			}
			if (advisor.instructions?.trim()) {
				appendYamlString(lines, "    ", "instructions", advisor.instructions);
			}
			if (advisor.enabled !== undefined) lines.push(`    enabled: ${advisor.enabled}`);
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export async function saveWatchdogConfigFile(filePath: string, doc: WatchdogConfigDoc): Promise<void> {
	const content = serializeWatchdogConfig(doc);
	if (!content.trim()) {
		try {
			await fs.rm(filePath, { force: true });
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		return;
	}
	await Bun.write(filePath, content);
}
