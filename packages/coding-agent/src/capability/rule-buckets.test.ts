import { expect, test } from "bun:test";
import { createSourceMeta } from "../discovery/helpers";
import { TtsrManager, type TtsrMatchContext } from "../export/ttsr";
import type { Rule } from "./rule";
import { bucketRules, rediscoverRules } from "./rule-buckets";

const TEXT: TtsrMatchContext = { source: "text" };

function rule(name: string, fields: Partial<Rule>): Rule {
	return {
		name,
		path: `rules/${name}.md`,
		content: `# ${name}`,
		_source: createSourceMeta("native", `rules/${name}.md`, "project"),
		...fields,
	};
}

function manager(): TtsrManager {
	return new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "after-gap",
		repeatGap: 0,
	});
}

function matchedNames(ttsr: TtsrManager, delta: string): string[] {
	ttsr.resetBuffer();
	return ttsr.checkDelta(delta, TEXT).map(match => match.rule.name);
}

test("a reload replaces an edited trigger rule and keeps its injection state", async () => {
	const ttsr = manager();
	const original = rule("guard", { condition: ["OLD_TOKEN"], content: "old content" });
	bucketRules([original], ttsr);
	ttsr.markInjected([original]);

	const updated = rule("guard", { condition: ["NEW_TOKEN"], content: "new content" });
	await rediscoverRules(ttsr, { cwd: "/", rules: [updated] });

	expect(ttsr.getRules()).toEqual([updated]);
	expect(ttsr.getInjectedRuleNames()).toEqual(["guard"]);
	expect(matchedNames(ttsr, "OLD_TOKEN")).toEqual([]);
	expect(matchedNames(ttsr, "NEW_TOKEN")).toEqual(["guard"]);
});

test("a reload drops renamed or deleted trigger rules and their injection state", async () => {
	const ttsr = manager();
	const original = rule("old-guard", { condition: ["OLD_TOKEN"] });
	bucketRules([original], ttsr);
	ttsr.markInjected([original]);

	const renamed = rule("new-guard", { condition: ["NEW_TOKEN"] });
	await rediscoverRules(ttsr, { cwd: "/", rules: [renamed] });
	expect(ttsr.getRules()).toEqual([renamed]);
	expect(ttsr.getInjectedRuleNames()).toEqual([]);
	expect(matchedNames(ttsr, "OLD_TOKEN")).toEqual([]);

	ttsr.markInjected([renamed]);
	await rediscoverRules(ttsr, { cwd: "/", rules: [] });
	expect(ttsr.hasRules()).toBe(false);
	expect(ttsr.getInjectedRuleNames()).toEqual([]);
	expect(matchedNames(ttsr, "NEW_TOKEN")).toEqual([]);
});

test("a reload re-buckets a rule that stopped being a trigger rule", async () => {
	const ttsr = manager();
	bucketRules([rule("guard", { condition: ["TOKEN"] })], ttsr);

	const sticky = rule("guard", { alwaysApply: true });
	const buckets = await rediscoverRules(ttsr, { cwd: "/", rules: [sticky] });
	expect(buckets.alwaysApplyRules).toEqual([sticky]);
	expect(ttsr.hasRules()).toBe(false);
});
