import * as path from "node:path";

import { expandTilde } from "../../../tools/path-utils";
import { ToolError } from "../../../tools/tool-errors";
import type { JsStatusEvent } from "./types";

export interface HelperContext {
	cwd(): string;
	env: Map<string, string>;
	emitStatus(event: JsStatusEvent): void;
}

export interface HelperBundle {
	resolvePath(rawPath: string): string;
	env(key?: string, value?: string): string | Record<string, string> | undefined;
}

export function createHelpers(ctx: HelperContext): HelperBundle {
	return {
		resolvePath: (rawPath: string) => {
			if (typeof rawPath !== "string" || rawPath.length === 0) {
				throw new ToolError("Expected a filesystem path string");
			}
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)) {
				throw new ToolError(
					"Expected a filesystem path; use tool.read for internal resources or pass a bash-resolved path through env.",
				);
			}
			return resolvePath(ctx, rawPath);
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
			const result = ctx.env.get(key) ?? process.env[key];
			ctx.emitStatus({ op: "env", key, value: result, action: "get" });
			return result;
		},
	};
}

function getMergedEnv(ctx: HelperContext): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") merged[key] = value;
	}
	for (const [key, value] of ctx.env) merged[key] = value;
	return merged;
}

function resolvePath(ctx: HelperContext, value: string): string {
	// `~` follows the kernel's own env — an `env("HOME", …)` override wins, as
	// os.environ does for the Python prelude's expanduser.
	const expanded = expandTilde(value, ctx.env.get("HOME") ?? process.env.HOME);
	if (path.isAbsolute(expanded)) return path.normalize(expanded);
	return path.resolve(ctx.cwd(), expanded);
}
