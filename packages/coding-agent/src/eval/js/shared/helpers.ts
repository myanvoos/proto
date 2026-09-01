import * as path from "node:path";
import { capEventDiff } from "../../../edit/diff";
import { ToolError } from "../../../tools/tool-errors";
import { noteReported, shaOfBytes, snapshotBeforeText } from "./fs-tracker";
import type { JsStatusEvent } from "./types";

export interface HelperContext {
	cwd(): string;
	env: Map<string, string>;

	localRoots(): Record<string, string>;
	emitStatus(event: JsStatusEvent): void;
}

export interface HelperBundle {
	writeFile(rawPath: string, data: unknown): Promise<string>;
	env(key?: string, value?: string): string | Record<string, string> | undefined;
}

const utf8Encoder = new TextEncoder();

export function createHelpers(ctx: HelperContext): HelperBundle {
	return {
		writeFile: async (rawPath, data) => {
			if (!isWriteData(data)) {
				throw new ToolError("write() expects string, Blob, ArrayBuffer, or TypedArray data");
			}
			const filePath = resolveHelperPath(ctx, rawPath);
			const before = snapshotBeforeText(filePath);
			const bytes = await writeDataBytes(data);
			await Bun.write(filePath, bytes);
			const sha = shaOfBytes(bytes);
			const event: JsStatusEvent = { op: "write", path: filePath, sha };
			if (typeof data === "string") {
				event.chars = data.length;
				const capped = before !== null ? capEventDiff(before, data) : undefined;
				if (capped) {
					event.diff = capped.diff;
					if (capped.diffTruncated) event.diffTruncated = true;
				}
			} else {
				event.bytes = bytes.byteLength;
			}
			ctx.emitStatus(event);
			noteReported(filePath, sha, typeof data === "string" ? data : undefined);
			return filePath;
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
	if (path.isAbsolute(value)) return path.normalize(value);
	return path.resolve(ctx.cwd(), value);
}

function resolveHelperPath(ctx: HelperContext, rawPath: string): string {
	const match = INTERNAL_URL_RE.exec(rawPath);
	if (!match) return resolvePath(ctx, rawPath);
	const scheme = match[1].toLowerCase();
	const root = ctx.localRoots()[scheme];
	if (!root) {
		throw new ToolError(`Protocol paths are not supported by write(): ${rawPath}`);
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

async function writeDataBytes(data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<Uint8Array> {
	if (typeof data === "string") return utf8Encoder.encode(data);
	if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function isWriteData(value: unknown): value is string | Blob | ArrayBuffer | ArrayBufferView {
	return (
		typeof value === "string" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
	);
}
