import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { invalidate as invalidateFsCache } from "../capability/fs";

import { validateServerConfig } from "./config";
import { MCP_CONFIG_SCHEMA_URL, type MCPConfigFile, type MCPServerConfig } from "./types";

function withSchema(config: MCPConfigFile): MCPConfigFile {
	return {
		$schema: config.$schema ?? MCP_CONFIG_SCHEMA_URL,
		...config,
	};
}

function withConfigLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	return fs.promises
		.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
		.then(() => withFileLock(filePath, fn));
}

export async function readMCPConfigFile(filePath: string): Promise<MCPConfigFile> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as MCPConfigFile;
		return parsed;
	} catch (error) {
		if (isEnoent(error)) {
			return { mcpServers: {} };
		}
		throw error;
	}
}

export async function writeMCPConfigFile(filePath: string, config: MCPConfigFile): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const content = JSON.stringify(withSchema(config), null, 2);
	try {
		await fs.promises.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });

		await fs.promises.rename(tmpPath, filePath);
	} catch (error) {
		await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}

	invalidateFsCache(filePath);
}

export function validateServerName(name: string): string | undefined {
	if (!name) {
		return "Server name cannot be empty";
	}
	if (name.length > 100) {
		return "Server name is too long (max 100 characters)";
	}

	if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) {
		return "Server name can only contain letters, numbers, dash, underscore, dot, and colon";
	}
	return undefined;
}

export async function addMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Invalid server config: ${errors.join("; ")}`);
	}

	await withConfigLock(filePath, async () => {
		const existing = await readMCPConfigFile(filePath);

		if (existing.mcpServers?.[name]) {
			throw new Error(`Server "${name}" already exists in ${filePath}`);
		}

		const updated: MCPConfigFile = {
			...existing,
			mcpServers: {
				...existing.mcpServers,
				[name]: config,
			},
		};
		await writeMCPConfigFile(filePath, updated);
	});
}

export async function updateMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Invalid server config: ${errors.join("; ")}`);
	}

	await withConfigLock(filePath, async () => {
		const existing = await readMCPConfigFile(filePath);

		const updated: MCPConfigFile = {
			...existing,
			mcpServers: {
				...existing.mcpServers,
				[name]: config,
			},
		};
		await writeMCPConfigFile(filePath, updated);
	});
}

export async function removeMCPServer(filePath: string, name: string): Promise<void> {
	await withConfigLock(filePath, async () => {
		const existing = await readMCPConfigFile(filePath);

		if (!existing.mcpServers?.[name]) {
			throw new Error(`Server "${name}" not found in ${filePath}`);
		}

		const { [name]: _removed, ...remaining } = existing.mcpServers;
		const updated: MCPConfigFile = {
			...existing,
			mcpServers: remaining,
		};
		await writeMCPConfigFile(filePath, updated);
	});
}

export async function readDisabledServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Array.isArray(config.disabledServers) ? config.disabledServers : [];
}

export async function setServerDisabled(filePath: string, name: string, disabled: boolean): Promise<void> {
	await withConfigLock(filePath, async () => {
		const config = await readMCPConfigFile(filePath);
		const current = new Set(config.disabledServers ?? []);

		if (disabled) {
			current.add(name);
		} else {
			current.delete(name);
		}

		const updated: MCPConfigFile = {
			...config,
			disabledServers: current.size > 0 ? Array.from(current).sort() : undefined,
		};

		if (!updated.disabledServers) {
			delete updated.disabledServers;
		}

		await writeMCPConfigFile(filePath, updated);
	});
}

export async function readEnabledServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Array.isArray(config.enabledServers) ? config.enabledServers : [];
}

async function setServerForceEnabled(filePath: string, name: string, force: boolean): Promise<void> {
	await withConfigLock(filePath, async () => {
		const config = await readMCPConfigFile(filePath);
		const current = new Set(config.enabledServers ?? []);

		if (force) {
			current.add(name);
		} else {
			current.delete(name);
		}

		const updated: MCPConfigFile = {
			...config,
			enabledServers: current.size > 0 ? Array.from(current).sort() : undefined,
		};

		if (!updated.enabledServers) {
			delete updated.enabledServers;
		}

		await writeMCPConfigFile(filePath, updated);
	});
}

interface SetMcpServerEnabledOptions {
	userPath: string;
	projectPath: string;

	sourcePath?: string;
	name: string;
	enabled: boolean;
}

export async function setMcpServerEnabled(options: SetMcpServerEnabledOptions): Promise<void> {
	const { userPath, projectPath, sourcePath, name, enabled } = options;
	const candidatePaths = [...new Set([sourcePath, projectPath, userPath].filter(path => path !== undefined))];
	let updatedInConfig = false;

	for (const filePath of candidatePaths) {
		const config = await readMCPConfigFile(filePath);
		const server = config.mcpServers?.[name];
		if (server === undefined) continue;

		await updateMCPServer(filePath, name, { ...server, enabled });
		updatedInConfig = true;
		break;
	}

	if (enabled) {
		const denied = await readDisabledServers(userPath);
		if (denied.includes(name)) {
			await setServerDisabled(userPath, name, false);
		}

		const forced = await readEnabledServers(userPath);
		const isForced = forced.includes(name);
		if (!updatedInConfig && !isForced) {
			await setServerForceEnabled(userPath, name, true);
		} else if (updatedInConfig && isForced) {
			await setServerForceEnabled(userPath, name, false);
		}
		return;
	}

	const forced = await readEnabledServers(userPath);
	if (forced.includes(name)) {
		await setServerForceEnabled(userPath, name, false);
	}
	if (!updatedInConfig) {
		await setServerDisabled(userPath, name, true);
	}
}
