import type { ModelSpec, ResolvedDevinCompat } from "../types";

export function buildDevinCompat(spec: ModelSpec<"devin-agent">): ResolvedDevinCompat {
	return {
		trustExplicitThinkingOnly: true,
		modelRouter: spec.compat?.modelRouter ?? false,
		supportsParallelToolCalls: spec.compat?.supportsParallelToolCalls ?? false,
	};
}
