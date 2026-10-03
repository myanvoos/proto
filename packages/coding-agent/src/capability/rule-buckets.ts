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
	/** Replace the manager's TTSR registrations with this complete rule snapshot instead of adding to them. */
	replaceTtsrRules?: boolean;
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

	const includedRules = rules.filter(
		rule => !disabled.has(rule.name) && (includeBuiltin || rule._source?.provider !== BUILTIN_DEFAULTS_PROVIDER_ID),
	);
	const replacedTtsrNames = options.replaceTtsrRules ? ttsrManager.replaceRules(includedRules) : undefined;
	const rulebookRules: Rule[] = [];
	const alwaysApplyRules: Rule[] = [];

	for (const rule of includedRules) {
		const hasTtsrCondition =
			rule.match !== undefined ||
			(rule.condition && rule.condition.length > 0) ||
			(rule.astCondition && rule.astCondition.length > 0);
		const isTtsrRule = hasTtsrCondition ? (replacedTtsrNames?.has(rule.name) ?? ttsrManager.addRule(rule)) : false;
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
	agentDir?: string;
	ttsrSettings?: TtsrSettings;

	rules?: readonly Rule[];
}): Promise<DiscoveredRules> {
	const { TtsrManager } = await import("../export/ttsr");
	const ttsrManager = new TtsrManager(options.ttsrSettings);
	const allRules = options.rules
		? [...options.rules]
		: (await loadCapability<Rule>(ruleCapability.id, { cwd: options.cwd, agentDir: options.agentDir })).items;
	const buckets = bucketRules(allRules, ttsrManager, {
		builtinRules: options.ttsrSettings?.builtinRules,
		disabledRules: options.ttsrSettings?.disabledRules,
	});
	return { ...buckets, ttsrManager, allRules };
}

/**
 * Re-reads a workspace's rules into an existing session's buckets, replacing its TTSR registrations so edited,
 * renamed, and deleted rules leave nothing stale while injection state survives for rules that remain.
 */
export async function rediscoverRules(
	ttsrManager: TtsrManager,
	options: { cwd: string; agentDir?: string; ttsrSettings?: TtsrSettings; rules?: readonly Rule[] },
): Promise<RuleBuckets & { allRules: Rule[] }> {
	const allRules = options.rules
		? [...options.rules]
		: (await loadCapability<Rule>(ruleCapability.id, { cwd: options.cwd, agentDir: options.agentDir })).items;
	const buckets = bucketRules(allRules, ttsrManager, {
		builtinRules: options.ttsrSettings?.builtinRules,
		disabledRules: options.ttsrSettings?.disabledRules,
		replaceTtsrRules: true,
	});
	return { ...buckets, allRules };
}

/** The rules a `rule://` URL can name: every bucket plus the trigger rules the manager claimed. */
export function collectActiveRules(buckets: RuleBuckets, ttsrManager: TtsrManager): Rule[] {
	return [...buckets.rulebookRules, ...buckets.alwaysApplyRules, ...ttsrManager.getRules()];
}
