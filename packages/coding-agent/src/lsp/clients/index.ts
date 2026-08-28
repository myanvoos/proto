import type { LinterClient, ServerConfig } from "../../lsp/types";
import { LspLinterClient } from "./lsp-linter-client";

export { BiomeClient } from "./biome-client";
export { LspLinterClient } from "./lsp-linter-client";
export { SwiftLintClient } from "./swiftlint-client";

const clientCache = new Map<string, LinterClient>();

export function getLinterClient(serverName: string, config: ServerConfig, cwd: string): LinterClient {
	const key = `${serverName}:${cwd}`;

	let client = clientCache.get(key);
	if (client) {
		return client;
	}

	if (config.createClient) {
		client = config.createClient(config, cwd);
	} else {
		client = LspLinterClient.create(config, cwd);
	}

	clientCache.set(key, client);
	return client;
}
