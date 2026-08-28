const USAGE = "Usage: /marketplace install [--force] [--scope user|project] <name@marketplace>";

interface MarketplaceInstallArgs {
	force: boolean;
	scope: "user" | "project";
	installSpec: string;
}

export function parseMarketplaceInstallArgs(rest: string): MarketplaceInstallArgs | { error: string } {
	const tokens = rest.split(/\s+/).filter(Boolean);
	let force = false;
	let scope: "user" | "project" = "user";
	let installSpec = "";

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--force") {
			force = true;
		} else if (tokens[i] === "--scope" && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
			const s = tokens[++i];
			if (s === "user" || s === "project") {
				scope = s;
			} else {
				return { error: `Invalid --scope value: "${s}". Must be "user" or "project".` };
			}
		} else if (tokens[i] === "--scope") {
			return { error: '--scope requires a value: "user" or "project".' };
		} else if (tokens[i].startsWith("-")) {
			return { error: `Unknown flag: "${tokens[i]}". ${USAGE}` };
		} else {
			if (installSpec) {
				return { error: `Unexpected argument: "${tokens[i]}". ${USAGE}` };
			}
			installSpec = tokens[i];
		}
	}

	if (!installSpec.includes("@")) {
		return { error: USAGE };
	}

	return { force, scope, installSpec };
}

interface PluginScopeArgs {
	pluginId: string;
	scope?: "user" | "project";
}

export function parsePluginScopeArgs(rest: string, usageHint: string): PluginScopeArgs | { error: string } {
	const tokens = rest.split(/\s+/).filter(Boolean);
	let scope: "user" | "project" | undefined;
	let pluginId = "";

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--scope" && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
			const s = tokens[++i];
			if (s === "user" || s === "project") {
				scope = s;
			} else {
				return { error: `Invalid --scope value: "${s}". Must be "user" or "project".` };
			}
		} else if (tokens[i] === "--scope") {
			return { error: '--scope requires a value: "user" or "project".' };
		} else if (tokens[i].startsWith("-")) {
			return { error: `Unknown flag: "${tokens[i]}". ${usageHint}` };
		} else if (pluginId) {
			return { error: `Unexpected argument: "${tokens[i]}". ${usageHint}` };
		} else {
			pluginId = tokens[i];
		}
	}

	if (!pluginId) {
		return { error: usageHint };
	}

	return { pluginId, scope };
}
