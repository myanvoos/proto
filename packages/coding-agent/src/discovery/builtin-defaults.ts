import { registerProvider } from "../capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult } from "../capability/types";
import { BUILTIN_RULE_SOURCES } from "./builtin-rules";
import { buildRuleFromMarkdown, createSourceMeta } from "./helpers";

const DISPLAY_NAME = "Builtin Defaults";

const PRIORITY = 1;

async function loadRules(_ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items = BUILTIN_RULE_SOURCES.map(({ name, content }) => {
		const virtualPath = `${BUILTIN_DEFAULTS_PROVIDER_ID}:${name}.md`;
		const source = createSourceMeta(BUILTIN_DEFAULTS_PROVIDER_ID, virtualPath, "user");
		return buildRuleFromMarkdown(name, content, virtualPath, source, { ruleName: name });
	});
	return { items };
}

registerProvider<Rule>(ruleCapability.id, {
	id: BUILTIN_DEFAULTS_PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Default rules shipped with the agent (disable via ttsr.builtinRules / ttsr.disabledRules)",
	priority: PRIORITY,
	load: loadRules,
});
