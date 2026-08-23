import { describe, expect, it } from "bun:test";
import {
	adaptSchemaForStrict,
	normalizeSchemaForCCA,
	normalizeSchemaForGoogle,
	type SchemaCompatibilityProvider,
	type SchemaCompatibilityResult,
	toolWireSchema,
	validateSchemaCompatibility,
	validateStrictSchemaEnforcement,
} from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

interface ToolSchemaEntry {
	name: string;
	schema: Record<string, unknown>;
}

const testSettings = Settings.isolated({ "tools.xdev": false });

function createTestSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: testSettings,
	};
}

function asSchemaObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}
const builtinToolsPromise = createTools(createTestSession());
const toolSchemasPromise: Promise<ToolSchemaEntry[]> = (async () => {
	const session = createTestSession();
	const byToolName = new Map<string, Record<string, unknown>>();

	for (const tool of await builtinToolsPromise) {
		const schema = toolWireSchema(tool);
		if (asSchemaObject(schema)) {
			byToolName.set(tool.name, schema);
		}
	}

	for (const name in HIDDEN_TOOLS) {
		const tool = await HIDDEN_TOOLS[name as keyof typeof HIDDEN_TOOLS](session);
		if (!tool) {
			continue;
		}
		const schema = toolWireSchema(tool);
		if (asSchemaObject(schema)) {
			byToolName.set(name, schema);
		}
	}

	return [...byToolName.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, schema]) => ({ name, schema }));
})();

function formatCompatibilityIssues(
	toolName: string,
	provider: SchemaCompatibilityProvider,
	result: SchemaCompatibilityResult,
): string {
	if (result.compatible) {
		return "";
	}
	const details = result.violations
		.map(violation => `  - ${violation.rule} at ${violation.path}: ${violation.message}`)
		.join("\n");
	return `${toolName} (${provider}):\n${details}`;
}

describe("builtin tool schemas provider compatibility", () => {
	it("exposes the five strict orchestration schemas alongside ordinary tools", async () => {
		const tools = await builtinToolsPromise;
		const names = tools.map(tool => tool.name);
		expect(names).toContain("read");
		expect(names.filter(name => name.startsWith("orchestrate_"))).toEqual([
			"orchestrate_spawn",
			"orchestrate_send",
			"orchestrate_wait",
			"orchestrate_kill",
			"orchestrate_list",
		]);
		for (const tool of tools.filter(tool => tool.name.startsWith("orchestrate_"))) {
			expect(tool.strict).toBe(true);
		}
		const spawn = tools.find(tool => tool.name === "orchestrate_spawn");
		if (!spawn) throw new Error("Expected orchestrate_spawn");
		const schema = toolWireSchema(spawn) as { properties?: Record<string, unknown> };
		expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
			"agent",
			"effort",
			"isolated",
			"name",
			"outputSchema",
			"prompt",
			"schemaMode",
		]);
	});

	it("keeps top-level orchestration available when recursive spawning is disabled", async () => {
		const topSession: ToolSession = {
			...createTestSession(),
			getSessionSpawns: () => "",
			settings: Settings.isolated({ "orchestrator.maxRecursionDepth": 0 }),
		};
		const names = (await createTools(topSession)).map(tool => tool.name);
		expect(names.filter(name => name.startsWith("orchestrate_"))).toHaveLength(5);
	});

	it("allows one recursive worker level when configured", async () => {
		const recursiveSession: ToolSession = {
			...createTestSession(),
			taskDepth: 1,
			settings: Settings.isolated({ "orchestrator.maxRecursionDepth": 1 }),
		};
		const names = (await createTools(recursiveSession)).map(tool => tool.name);
		expect(names.filter(name => name.startsWith("orchestrate_"))).toHaveLength(5);
	});

	it("removes recursive orchestration tools at the configured depth cap", async () => {
		const cappedSession: ToolSession = {
			...createTestSession(),
			taskDepth: 1,
			settings: Settings.isolated({ "orchestrator.maxRecursionDepth": 0 }),
		};
		const names = (await createTools(cappedSession)).map(tool => tool.name);
		expect(names.some(name => name.startsWith("orchestrate_"))).toBe(false);
		expect(names).toContain("read");
	});

	it("keeps all builtin and hidden tool schemas valid after provider enforcement", async () => {
		const toolSchemas = await toolSchemasPromise;
		const failures: string[] = [];

		for (const { name, schema } of toolSchemas) {
			const strictResult = adaptSchemaForStrict(schema, true);
			const strictCompatibility = validateStrictSchemaEnforcement(schema, strictResult);
			if (!strictCompatibility.compatible) {
				failures.push(formatCompatibilityIssues(name, "openai-strict", strictCompatibility));
			}

			try {
				const googleSchema = normalizeSchemaForGoogle(schema);
				const googleCompatibility = validateSchemaCompatibility(googleSchema, "google");
				if (!googleCompatibility.compatible) {
					failures.push(formatCompatibilityIssues(name, "google", googleCompatibility));
				}
			} catch (error) {
				failures.push(`${name} (google): normalizeSchemaForGoogle threw: ${String(error)}`);
			}

			const cloudCodeAssistSchema = normalizeSchemaForCCA(schema);
			const cloudCodeAssistCompatibility = validateSchemaCompatibility(
				cloudCodeAssistSchema,
				"cloud-code-assist-claude",
			);
			if (!cloudCodeAssistCompatibility.compatible) {
				failures.push(formatCompatibilityIssues(name, "cloud-code-assist-claude", cloudCodeAssistCompatibility));
			}
		}

		if (failures.length > 0) {
			throw new Error(`Provider compatibility failures:\n\n${failures.join("\n\n")}`);
		}

		expect(failures).toEqual([]);
	});

	it("preserves the yield result schema for Cloud Code Assist", async () => {
		const toolSchemas = await toolSchemasPromise;
		const yieldEntry = toolSchemas.find(tool => tool.name === "yield");
		expect(yieldEntry).toBeDefined();
		if (!yieldEntry) return;

		const normalized = asSchemaObject(normalizeSchemaForCCA(yieldEntry.schema));
		const properties = asSchemaObject(normalized?.properties);
		const typeSchema = asSchemaObject(properties?.type);

		expect(normalized?.type).toBe("object");
		expect(properties?.result).toBeDefined();
		expect(typeSchema?.type).toBe("string");
		expect(typeSchema?.anyOf).toBeUndefined();
	});

	it('asserts that browser tool schema root stays `type: "object"` when discoverable tools are mounted', async () => {
		const toolSchemas = await toolSchemasPromise;
		const browserEntry = toolSchemas.find(tool => tool.name === "browser");
		expect(browserEntry).toBeDefined();
		expect(asSchemaObject(browserEntry?.schema)?.type).toBe("object");
	});
});
