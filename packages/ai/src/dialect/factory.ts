// Static require paths keep every dialect bundleable while materialization stays lazy per id.
import type { Dialect, DialectDefinition, InbandScanner, InbandScannerOptions } from "./types";

export function getDialectDefinition(dialect: Dialect): DialectDefinition {
	switch (dialect) {
		case "glm":
			return require("./glm").default;
		case "hermes":
			return require("./hermes").default;
		case "kimi":
			return require("./kimi").default;
		case "xml":
			return require("./xml").default;
		case "anthropic":
			return require("./anthropic").default;
		case "deepseek":
			return require("./deepseek").default;
		case "minimax":
			return require("./minimax").default;
		case "harmony":
			return require("./harmony").default;
		case "qwen3":
			return require("./qwen3").default;
		case "gemini":
			return require("./gemini").default;
		case "gemma":
			return require("./gemma").default;
	}
}

export function createInbandScanner(dialect: Dialect, options: InbandScannerOptions = {}): InbandScanner {
	return getDialectDefinition(dialect).createScanner(options);
}
