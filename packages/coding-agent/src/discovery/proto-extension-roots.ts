import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger, tryParseJson } from "@oh-my-pi/pi-utils";
import { readDirEntries, readFile } from "../capability/fs";
import type { LoadContext } from "../capability/types";
import { getEnabledPlugins } from "../extensibility/plugins/loader";
import { expandTilde } from "../tools/path-utils";
import { listClaudePluginRoots } from "./helpers";

export interface OmpExtensionRoot {
	path: string;

	name: string;

	level: "user" | "project";
}

interface InjectedRoot {
	path: string;

	relativePath?: string;
	level: "user" | "project";
}

type OmpExtensionRootMode = "merge" | "explicit-only";

interface InvocationRootScope {
	paths: readonly string[];
	mode: OmpExtensionRootMode;
}

const invocationRootScope = new AsyncLocalStorage<InvocationRootScope>();

let injectedCliRoots: InjectedRoot[] = [];
let injectedCliRootMode: OmpExtensionRootMode = "merge";

interface InjectOmpExtensionCliRootOptions {
	mode?: OmpExtensionRootMode;

	replace?: boolean;
}

export function withOmpExtensionRootScope<T>(
	paths: readonly string[],
	mode: OmpExtensionRootMode,
	callback: () => T,
): T {
	return invocationRootScope.run({ paths: [...paths], mode }, callback);
}

export function injectOmpExtensionCliRoots(
	paths: readonly string[],
	home: string,
	cwd: string,
	options: InjectOmpExtensionCliRootOptions = {},
): void {
	if (options.mode) injectedCliRootMode = options.mode;
	if (options.replace) injectedCliRoots = [];
	if (paths.length === 0) return;
	const expanded = paths.map(raw => {
		const tilde = expandTilde(raw, home);
		return {
			path: path.isAbsolute(tilde) ? tilde : path.resolve(cwd, tilde),
			relativePath: path.isAbsolute(tilde) ? undefined : tilde,
		};
	});
	const merged = new Map<string, InjectedRoot>();
	for (const root of injectedCliRoots) merged.set(root.path, root);
	for (const { path: resolved, relativePath } of expanded) {
		if (!merged.has(resolved)) merged.set(resolved, { path: resolved, relativePath, level: "user" });
	}
	injectedCliRoots = [...merged.values()];
}

export function clearOmpExtensionCliRoots(): void {
	injectedCliRoots = [];
	injectedCliRootMode = "merge";
}

interface ScopeDirs {
	project: string;
	user: string;
}

function scopeDirs(ctx: LoadContext): ScopeDirs {
	return {
		project: path.join(ctx.cwd, ".proto"),
		user: getAgentDir(),
	};
}

async function readSettingsExtensions(settingsPath: string): Promise<string[]> {
	const content = await readFile(settingsPath);
	if (!content) return [];
	const parsed = tryParseJson<{ extensions?: unknown }>(content);
	const raw = parsed?.extensions;
	if (!Array.isArray(raw)) return [];
	return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function resolveAgainst(raw: string, ctx: LoadContext): string {
	const tilde = expandTilde(raw, ctx.home);
	return path.isAbsolute(tilde) ? tilde : path.resolve(ctx.cwd, tilde);
}

async function isDirectory(p: string): Promise<boolean> {
	const entries = await readDirEntries(p);
	if (entries.length > 0) return true;

	try {
		const stat = await fs.stat(p);
		return stat.isDirectory();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

export async function listOmpExtensionRoots(ctx: LoadContext): Promise<OmpExtensionRoot[]> {
	const scopedRoots = invocationRootScope.getStore();
	const rootMode = scopedRoots?.mode ?? injectedCliRootMode;
	let candidates: InjectedRoot[] = scopedRoots
		? scopedRoots.paths.map(raw => ({ path: resolveAgainst(raw, ctx), level: "user" }))
		: injectedCliRoots.map(root =>
				root.relativePath ? { ...root, path: path.resolve(ctx.cwd, root.relativePath) } : root,
			);
	if (rootMode === "merge") {
		const { project, user } = scopeDirs(ctx);
		const [projectExtensions, userExtensions, installedPlugins] = await Promise.all([
			readSettingsExtensions(path.join(project, "settings.json")),
			readSettingsExtensions(path.join(user, "settings.json")),
			listInstalledPluginRoots(ctx),
		]);
		candidates = [
			...candidates,
			...projectExtensions.map((raw): InjectedRoot => ({ path: resolveAgainst(raw, ctx), level: "project" })),
			...userExtensions.map((raw): InjectedRoot => ({ path: resolveAgainst(raw, ctx), level: "user" })),
			...installedPlugins,
		];
	}

	const seen = new Set<string>();
	const unique: InjectedRoot[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.path)) continue;
		seen.add(candidate.path);
		unique.push(candidate);
	}

	const directoryFlags = await Promise.all(unique.map(c => isDirectory(c.path)));
	const roots: OmpExtensionRoot[] = [];
	for (let i = 0; i < unique.length; i++) {
		if (!directoryFlags[i]) continue;
		const { path: p, level } = unique[i];
		roots.push({ path: p, level, name: path.basename(p) });
	}
	return roots;
}

async function realpathOrResolved(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch (err) {
		if (isEnoent(err)) return path.resolve(p);
		throw err;
	}
}

async function listInstalledPluginRoots(ctx: LoadContext): Promise<InjectedRoot[]> {
	try {
		const [plugins, marketplaceRoots] = await Promise.all([
			getEnabledPlugins(ctx.cwd, { home: ctx.home }),
			listClaudePluginRoots(ctx.home, ctx.cwd),
		]);
		const marketplaceRealpaths = new Set(
			await Promise.all(marketplaceRoots.roots.map(root => realpathOrResolved(root.path))),
		);
		const installedRoots = await Promise.all(
			plugins.map(async plugin => ({
				path: plugin.path,
				scope: plugin.scope,
				realpath: await realpathOrResolved(plugin.path),
			})),
		);
		return installedRoots
			.filter(root => !marketplaceRealpaths.has(root.realpath))
			.map(({ path: p, scope }) => ({ path: p, level: scope }));
	} catch (err) {
		logger.debug("listInstalledPluginRoots: enumeration failed", { error: String(err) });
		return [];
	}
}
