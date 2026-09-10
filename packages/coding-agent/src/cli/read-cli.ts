import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import { extractUriScheme } from "../internal-urls/parse";
import { InternalUrlRouter } from "../internal-urls/router";
import { closeDaemonClients } from "../launch/client";
import { discoverAndLoadMCPTools } from "../mcp/loader";
import { MCPManager } from "../mcp/manager";
import { discoverAuthStorage } from "../session/auth-broker-config";
import type { AuthStorage } from "../session/auth-storage";
import type { ToolSession } from "../tools";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { ReadTool } from "../tools/read";
import { renderError } from "../tools/tool-errors";

export interface ReadCommandArgs {
	path: string;
}

function shouldDiscoverMcp(path: string): boolean {
	const scheme = extractUriScheme(path);
	if (!scheme) return false;
	if (scheme === "mcp") return true;
	if (["conflict", "file", "http", "https"].includes(scheme)) return false;
	return InternalUrlRouter.instance().getHandler(scheme) === undefined;
}

export async function runReadCommand(cmd: ReadCommandArgs): Promise<void> {
	if (!cmd.path) {
		process.stderr.write(chalk.red("error: path is required\n"));
		process.exit(1);
	}

	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });

	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};

	let authStorage: AuthStorage | undefined;
	let mcpManager: MCPManager | undefined;
	let failed = false;

	try {
		if (shouldDiscoverMcp(cmd.path)) {
			authStorage = await discoverAuthStorage();
			const result = await discoverAndLoadMCPTools(cwd, {
				enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
				filterExa: true,
				filterBrowser: settings.get("browser.enabled") ?? false,
				cacheStorage: settings.getStorage(),
				authStorage,
			});
			mcpManager = result.manager;
			session.mcpManager = mcpManager;
			MCPManager.setInstance(mcpManager);
		}

		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		const result = await tool.execute("proto-read", { path: cmd.path });

		for (const block of result.content) {
			if (block.type === "text") {
				process.stdout.write(block.text);
				if (!block.text.endsWith("\n")) process.stdout.write("\n");
			} else if (block.type === "image") {
				const decodedBytes = Buffer.from(block.data, "base64").byteLength;
				process.stdout.write(
					chalk.dim(`[image content: ${block.mimeType}, ${decodedBytes} bytes base64-decoded]\n`),
				);
			}
		}
	} catch (err) {
		process.stderr.write(`${chalk.red(renderError(err))}\n`);
		failed = true;
	} finally {
		if (mcpManager) {
			await mcpManager.dispose();
		}
		authStorage?.close();
		await closeDaemonClients();
	}

	if (failed) process.exit(1);
}
