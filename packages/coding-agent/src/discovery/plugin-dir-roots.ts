import * as path from "node:path";

interface PluginDirRoot {
	id: string;
	marketplace: string;
	plugin: string;
	version: string;
	path: string;
	scope: "user" | "project";
}

export function buildPluginDirRoot(resolvedPath: string, manifestName?: string): PluginDirRoot {
	const pluginName = manifestName || path.basename(resolvedPath);
	return {
		id: `${pluginName}@__local__`,
		marketplace: "__local__",
		plugin: pluginName,
		version: "local",
		path: resolvedPath,
		scope: "user",
	};
}
