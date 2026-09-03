import * as path from "node:path";

import { expandTilde } from "../../../tools/path-utils";
import { ToolError } from "../../../tools/tool-errors";
import type { JsStatusEvent } from "./types";

export interface HelperContext {
	cwd(): string;
	env: Map<string, string>;
	localRoots(): Record<string, string>;
	emitStatus(event: JsStatusEvent): void;
}

export interface HelperBundle {
	protoPath(rawPath: string): string;
	env(key?: string, value?: string): string | Record<string, string> | undefined;
}

export function createHelpers(ctx: HelperContext): HelperBundle {
	return {
		protoPath: (rawPath: string) => {
			if (typeof rawPath !== "string" || rawPath.length === 0) {
				throw new ToolError("protoPath() expects a path string");
			}
			return resolveHelperPath(ctx, rawPath);
		},
		env: (key, value) => {
			if (!key) {
				const merged = Object.fromEntries(Object.entries(getMergedEnv(ctx)).sort(([a], [b]) => a.localeCompare(b)));
				ctx.emitStatus({ op: "env", count: Object.keys(merged).length, keys: Object.keys(merged).slice(0, 20) });
				return merged;
			}
			if (value !== undefined) {
				ctx.env.set(key, value);
				ctx.emitStatus({ op: "env", key, value, action: "set" });
				return value;
			}
			const result = ctx.env.get(key) ?? Bun.env[key];
			ctx.emitStatus({ op: "env", key, value: result, action: "get" });
			return result;
		},
	};
}

function getMergedEnv(ctx: HelperContext): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (typeof value === "string") merged[key] = value;
	}
	for (const [key, value] of ctx.env) merged[key] = value;
	return merged;
}

const INTERNAL_URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

function resolvePath(ctx: HelperContext, value: string): string {
	// `~` follows the kernel's own env — an `env("HOME", …)` override wins, as
	// os.environ does for the Python prelude's expanduser.
	const expanded = expandTilde(value, ctx.env.get("HOME") ?? Bun.env.HOME);
	if (path.isAbsolute(expanded)) return path.normalize(expanded);
	return path.resolve(ctx.cwd(), expanded);
}

function resolveHelperPath(ctx: HelperContext, rawPath: string): string {
	const match = INTERNAL_URL_RE.exec(rawPath);
	if (!match) return resolvePath(ctx, rawPath);
	const scheme = match[1].toLowerCase();
	const root = ctx.localRoots()[scheme];
	if (!root) {
		throw new ToolError(`Protocol paths are not supported by this scheme: ${rawPath}`);
	}
	return resolveUnderRoot(scheme, root, match[2], rawPath);
}

function resolveUnderRoot(scheme: string, root: string, rawRelative: string, rawPath: string): string {
	let relative: string;
	try {
		relative = decodeURIComponent(rawRelative.replaceAll("\\", "/"));
	} catch {
		throw new ToolError(`Invalid URL encoding in ${scheme}:// path: ${rawPath}`);
	}
	const rootPath = path.resolve(root);
	if (relative === "") return rootPath;
	if (path.isAbsolute(relative)) {
		throw new ToolError(`Absolute paths are not allowed in ${scheme}:// URLs: ${rawPath}`);
	}
	const normalized = path.normalize(relative);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new ToolError(`Path traversal (..) is not allowed in ${scheme}:// URLs: ${rawPath}`);
	}
	const resolved = path.resolve(rootPath, normalized);
	if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
		throw new ToolError(`${scheme}:// path escapes its root: ${rawPath}`);
	}
	return resolved;
}
