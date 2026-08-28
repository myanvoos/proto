import * as os from "node:os";
import * as path from "node:path";

interface ClaudePaths {
	configDir: string;
	configFile: string;
}

export function resolveClaudePaths(home: string = os.homedir()): ClaudePaths {
	const override = process.env.CLAUDE_CONFIG_DIR?.trim();
	if (override) {
		const configDir = path.resolve(override);
		return { configDir, configFile: path.join(configDir, ".claude.json") };
	}
	return { configDir: path.join(home, ".claude"), configFile: path.join(home, ".claude.json") };
}
