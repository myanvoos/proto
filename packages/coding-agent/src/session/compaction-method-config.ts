export const COMPACTION_METHOD_CHOICES = [
	{
		value: "remote",
		label: "OpenAI server compaction",
		description: "Use provider-native OpenAI-compatible server compaction when the active route supports it",
	},
	{
		value: "soft",
		label: "Soft compaction",
		description: "Summarize in place with a compaction model without using server compaction",
	},
] as const;

export type CompactionMethod = (typeof COMPACTION_METHOD_CHOICES)[number]["value"];

export const DEFAULT_COMPACTION_METHOD_ORDER: CompactionMethod[] = ["remote", "soft"];

const COMPACTION_METHODS: Record<CompactionMethod, true> = {
	remote: true,
	soft: true,
};

function isCompactionMethod(value: unknown): value is CompactionMethod {
	return typeof value === "string" && Object.hasOwn(COMPACTION_METHODS, value);
}

export function resolveCompactionMethodOrder(value: unknown): CompactionMethod[] {
	if (!Array.isArray(value)) return [];

	const methods: CompactionMethod[] = [];
	for (const method of value) {
		if (isCompactionMethod(method) && !methods.includes(method)) methods.push(method);
	}
	return methods;
}
