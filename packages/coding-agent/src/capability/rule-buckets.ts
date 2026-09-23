import type { TtsrSettings } from "../config/settings-schema";
import type { TtsrManager } from "../export/ttsr";
import { loadCapability } from "./index";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "./rule";

export interface RuleBuckets {
	rulebookRules: Rule[];
	alwaysApplyRules: Rule[];
}

interface BucketRulesOptions {
	disabledRules?: readonly string[];

	builtinRules?: boolean;
}

export function bucketRules(
	rules: readonly Rule[],
	ttsrManager: TtsrManager,
	options: BucketRulesOptions = {},
): RuleBuckets {
	const includeBuiltin = options.builtinRules !== false;
	const disabled = new Set<string>();
	for (const raw of options.disabledRules ?? []) {
		const name = raw.trim();
		if (name.length > 0) disabled.add(name);
	}

	const rulebookRules: Rule[] = [];
	const alwaysApplyRules: Rule[] = [];

	for (const rule of rules) {
		if (disabled.has(rule.name)) continue;
		if (!includeBuiltin && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) continue;

		const hasTtsrCondition =
			rule.match !== undefined ||
			(rule.condition && rule.condition.length > 0) ||
			(rule.astCondition && rule.astCondition.length > 0);
		const isTtsrRule = hasTtsrCondition ? ttsrManager.addRule(rule) : false;
		if (isTtsrRule) continue;
		if (rule.alwaysApply === true) {
			alwaysApplyRules.push(rule);
			continue;
		}
		if (rule.description) {
			rulebookRules.push(rule);
		}
	}

	return { rulebookRules, alwaysApplyRules };
}

export interface DiscoveredRules extends RuleBuckets {
	ttsrManager: TtsrManager;

	allRules: Rule[];
}

/** Discover the rules of a workspace and sort them into the buckets a session uses. */
export async function discoverRules(options: {
	cwd: string;
	ttsrSettings?: TtsrSettings;

	rules?: readonly Rule[];
}): Promise<DiscoveredRules> {
	const { TtsrManager } = await import("../export/ttsr");
	const ttsrManager = new TtsrManager(options.ttsrSettings);
	const allRules = options.rules
		? [...options.rules]
		: (await loadCapability<Rule>(ruleCapability.id, { cwd: options.cwd })).items;
	const buckets = bucketRules(allRules, ttsrManager, {
		builtinRules: options.ttsrSettings?.builtinRules,
		disabledRules: options.ttsrSettings?.disabledRules,
	});
	return { ...buckets, ttsrManager, allRules };
}

/** The rules a `rule://` URL can name: every bucket plus the trigger rules the manager claimed. */
export function collectActiveRules(buckets: RuleBuckets, ttsrManager: TtsrManager): Rule[] {
	return [...buckets.rulebookRules, ...buckets.alwaysApplyRules, ...ttsrManager.getRules()];
}
