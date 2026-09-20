export const COMPACTION_METHOD_CHOICES = [
	{
		value: "remote",
		label: "Remote compaction",
		description:
			"Use provider-native OpenAI-compatible server compaction, or the configured compaction.remoteEndpoint, when the active route supports it",
	},
] as const;

export type CompactionMethod = (typeof COMPACTION_METHOD_CHOICES)[number]["value"];

export const DEFAULT_COMPACTION_METHOD_ORDER: CompactionMethod[] = ["remote"];

const COMPACTION_METHODS: Record<CompactionMethod, true> = {
	remote: true,
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
