import { expect, test } from "bun:test";
import type { Rule } from "../capability/rule";
import type { TtsrSettings } from "../config/settings";
import { createSourceMeta } from "../discovery/helpers";
import { TtsrManager, type TtsrMatchContext } from "./ttsr";

function rule(name: string, fields: Partial<Rule>): Rule {
	return {
		name,
		path: `rules/${name}.md`,
		content: `# ${name}`,
		_source: createSourceMeta("native", `rules/${name}.md`, "project"),
		...fields,
	};
}

function settings(overrides: Partial<TtsrSettings> = {}): TtsrSettings {
	return {
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
		...overrides,
	};
}

const TOOL: TtsrMatchContext = { source: "tool", toolName: "bash", filePaths: ["src/a.ts"], streamKey: "toolcall:1" };

test("a match expression registers, matches, and reports the line that tripped it", () => {
	const manager = new TtsrManager(settings());
	expect(manager.addRule(rule("no-any", { match: { regex: "\\bas any\\b", in: "code" } }))).toBe(true);
	const matches = manager.checkSnapshot(["// as any", "const v = x as any;"].join("\n"), TOOL);
	expect(matches.map(match => match.rule.name)).toEqual(["no-any"]);
	expect(matches[0]!.evidence.snippets).toEqual([{ line: 2, text: "const v = x as any;" }]);
});

test("an uncompilable match expression keeps the rule out of the TTSR bucket", () => {
	const manager = new TtsrManager(settings());
	expect(manager.addRule(rule("broken", { match: { regex: "(unclosed" } }))).toBe(false);
	expect(manager.addRule(rule("unknown-key", { match: { regex: "x", nope: true } }))).toBe(false);
	expect(manager.hasRules()).toBe(false);
});

test("match supersedes the legacy condition fields on the same rule", () => {
	const manager = new TtsrManager(settings());
	manager.addRule(rule("either", { condition: ["legacy-token"], match: { regex: "expression-token" } }));
	expect(manager.checkSnapshot("legacy-token", TOOL)).toEqual([]);
	expect(manager.checkSnapshot("expression-token", TOOL).map(match => match.rule.name)).toEqual(["either"]);
});

test("repeat policy gates re-triggering by completed turns", () => {
	const once = new TtsrManager(settings());
	once.addRule(rule("once", { condition: ["boom"] }));
	expect(once.checkSnapshot("boom", TOOL)).toHaveLength(1);
	once.markInjectedByNames(["once"]);
	expect(once.checkSnapshot("boom", TOOL)).toEqual([]);

	const gap = new TtsrManager(settings({ repeatMode: "after-gap", repeatGap: 2 }));
	gap.addRule(rule("gap", { condition: ["boom"] }));
	expect(gap.checkSnapshot("boom", TOOL)).toHaveLength(1);
	gap.markInjectedByNames(["gap"]);
	gap.incrementMessageCount();
	expect(gap.checkSnapshot("boom", TOOL)).toEqual([]);
	gap.incrementMessageCount();
	expect(gap.checkSnapshot("boom", TOOL)).toHaveLength(1);
});

test("scope decides which streams a rule watches", () => {
	const manager = new TtsrManager(settings());
	manager.addRule(rule("prose", { condition: ["boom"], scope: ["text", "thinking"] }));
	manager.addRule(rule("typescript-writes", { condition: ["boom"], scope: ["tool:bash(*.ts)"] }));

	expect(manager.checkSnapshot("boom", { source: "text" }).map(match => match.rule.name)).toEqual(["prose"]);
	expect(manager.checkSnapshot("boom", { source: "thinking" }).map(match => match.rule.name)).toEqual(["prose"]);
	expect(manager.checkSnapshot("boom", TOOL).map(match => match.rule.name)).toEqual(["typescript-writes"]);
	expect(manager.checkSnapshot("boom", { ...TOOL, filePaths: ["src/a.rs"] })).toEqual([]);
});

test("the synchronous path never decides a match that depends on an unresolved ast condition", async () => {
	const manager = new TtsrManager(settings());
	manager.addRule(rule("ast-only", { match: { ast: "$X as any" } }));
	manager.addRule(rule("mixed", { match: { any: [{ regex: "marker" }, { ast: "$X as any" }] } }));
	const text = "const v = x as any; // marker";

	expect(manager.checkSnapshot(text, TOOL).map(match => match.rule.name)).toEqual(["mixed"]);
	expect(manager.hasAsyncRules()).toBe(true);
	const resolved = await manager.checkAsyncSnapshot(text, TOOL);
	expect(resolved.map(match => match.rule.name).sort()).toEqual(["ast-only", "mixed"]);
	// The same snapshot is not re-reported for the same stream.
	expect(await manager.checkAsyncSnapshot(text, TOOL)).toEqual([]);
});

test("ast conditions need a language, which comes from the candidate path", async () => {
	const manager = new TtsrManager(settings());
	manager.addRule(rule("ast-only", { match: { ast: "$X as any" } }));
	const text = "const v = x as any;";
	expect(
		await manager.checkAsyncSnapshot(text, { source: "tool", toolName: "bash", streamKey: "toolcall:1" }),
	).toEqual([]);
	expect(await manager.checkAsyncSnapshot(text, TOOL)).toHaveLength(1);
});

test("a judge only runs against a settled buffer", async () => {
	const manager = new TtsrManager(settings());
	manager.addRule(rule("judged", { match: { all: [{ regex: "new Set" }, { llm: "Is this a literal table?" }] } }));
	const text = "const seen = new Set<string>();";
	let asked = 0;
	const judge = async () => {
		asked++;
		return true;
	};

	// Mid-stream the buffer can still change, so the judge is never consulted.
	expect(await manager.checkAsyncSnapshot(text, { ...TOOL, judge })).toEqual([]);
	expect(asked).toBe(0);

	const settled = await manager.checkAsyncSnapshot(text, { ...TOOL, judge, settled: true, streamKey: "toolcall:2" });
	expect(settled.map(match => match.rule.name)).toEqual(["judged"]);
	expect(asked).toBe(1);
});

test("the streaming ast pass does not consume the settled judge pass for the same buffer", async () => {
	const manager = new TtsrManager(settings());
	manager.addRule(rule("ast-only", { match: { ast: "$X as any" } }));
	manager.addRule(rule("judged", { match: { all: [{ regex: "as any" }, { llm: "Is this a real cast?" }] } }));
	const text = "const v = x as any;";
	let asked = 0;
	const judge = async () => {
		asked++;
		return true;
	};

	expect((await manager.checkAsyncSnapshot(text, { ...TOOL, judge })).map(match => match.rule.name)).toEqual([
		"ast-only",
	]);
	expect(asked).toBe(0);
	const settled = await manager.checkAsyncSnapshot(text, { ...TOOL, judge, settled: true });
	expect(settled.map(match => match.rule.name).sort()).toEqual(["ast-only", "judged"]);
	expect(asked).toBe(1);
});

test("judge rules reach settled prose, where no language is available for an ast pass", async () => {
	const manager = new TtsrManager(settings());
	manager.addRule(rule("prose-judge", { match: { llm: "Does this claim a test run that never happened?" } }));
	manager.addRule(rule("ast-only", { match: { ast: "$X as any" } }));
	const matches = await manager.checkAsyncSnapshot("I ran the tests and they pass.", {
		source: "text",
		settled: true,
		judge: async () => true,
	});
	expect(matches.map(match => match.rule.name)).toEqual(["prose-judge"]);
});

test("disabling TTSR stops registration and matching entirely", async () => {
	const manager = new TtsrManager(settings({ enabled: false }));
	expect(manager.addRule(rule("off", { condition: ["boom"] }))).toBe(false);
	expect(manager.hasRules()).toBe(false);
	expect(manager.hasAsyncRules()).toBe(false);
	expect(manager.checkSnapshot("boom", TOOL)).toEqual([]);
	expect(await manager.checkAsyncSnapshot("boom", TOOL)).toEqual([]);
});
