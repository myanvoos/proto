import type { ModelSpec, ResolvedOllamaCompat } from "../types";
import { applyCompatOverrides } from "./apply";

/**
 * Legacy Ollama Cloud deployments reject assistant thinking in history (#1000),
 * while the verified GLM-5.2 wire ids accept it (#9693). Catalog ownership keeps
 * the replay contract in one place so a `compat` override can flip either way.
 */
export function buildOllamaCompat(spec: ModelSpec<"ollama-chat">): ResolvedOllamaCompat {
	const compat: ResolvedOllamaCompat = {
		stripThinkingHistory: spec.provider === "ollama-cloud" && !/^glm-5\.2(?::cloud)?$/.test(spec.id),
	};
	applyCompatOverrides(compat, spec.compat);
	return compat;
}
