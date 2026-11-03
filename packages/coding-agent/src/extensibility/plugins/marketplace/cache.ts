import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent, logger } from "@oh-my-pi/pi-utils";

import { isValidNameSegment } from "./types";

const VERSION_RE = /^[a-zA-Z0-9._+-]+$/;

export function isValidVersionForCache(version: string): boolean {
	return version.length > 0 && version.length <= 128 && VERSION_RE.test(version) && !version.includes("..");
}

function validateCacheComponents(marketplace: string, pluginName: string, version: string): void {
	if (!isValidNameSegment(marketplace)) {
		throw new Error(`Invalid marketplace name for cache: "${marketplace}"`);
	}
	if (!isValidNameSegment(pluginName)) {
		throw new Error(`Invalid plugin name for cache: "${pluginName}"`);
	}
	if (!isValidVersionForCache(version)) {
		throw new Error(`Invalid version for cache: "${version}"`);
	}
}

export function getCachedPluginPath(
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): string {
	validateCacheComponents(marketplace, pluginName, version);
	return path.join(cacheDir, `${marketplace}___${pluginName}___${version}`);
}

export async function cachePlugin(
	sourcePath: string,
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): Promise<string> {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);

	await fs.mkdir(cacheDir, { recursive: true });

	const stagingPath = await fs.mkdtemp(`${targetPath}.staging-`);
	const previousPath = `${stagingPath}.previous`;
	let movedAside = false;
	try {
		await fs.cp(sourcePath, stagingPath, { recursive: true });
		try {
			await fs.rename(targetPath, previousPath);
			movedAside = true;
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		await fs.rename(stagingPath, targetPath);
	} catch (err) {
		if (movedAside) await fs.rename(previousPath, targetPath).catch(() => {});
		await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
		throw err;
	}
	if (movedAside) {
		await fs.rm(previousPath, { recursive: true, force: true }).catch(error => {
			logger.warn("Could not remove the previous plugin cache copy", { path: previousPath, error });
		});
	}

	return targetPath;
}

export function isCached(cacheDir: string, marketplace: string, pluginName: string, version: string): boolean {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);
	return nodeFs.existsSync(targetPath);
}

export async function removeCachedPlugin(
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): Promise<void> {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);
	await fs.rm(targetPath, { recursive: true, force: true });
}

export async function cleanOrphanedCache(cacheDir: string, installedPaths: Set<string>): Promise<{ removed: number }> {
	let entries: string[];
	try {
		entries = await fs.readdir(cacheDir);
	} catch (err) {
		if (isEnoent(err)) return { removed: 0 };
		throw err;
	}

	let removed = 0;
	for (const entry of entries) {
		const fullPath = path.join(cacheDir, entry);
		if (!installedPaths.has(fullPath)) {
			await fs.rm(fullPath, { recursive: true, force: true });
			removed++;
		}
	}

	return { removed };
}
