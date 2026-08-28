import * as path from "node:path";

export function piReadPath(readPath: string, offset?: number, limit?: number): string | null {
	if (limit !== undefined && Math.floor(limit) <= 0) return null;
	const start = offset !== undefined ? Math.max(1, Math.floor(offset)) : undefined;
	const count = limit !== undefined ? Math.floor(limit) : undefined;
	if (start === undefined && count === undefined) return readPath;
	const base = readPath.split(":").some(chunk => chunk.toLowerCase() === "raw") ? readPath : `${readPath}:raw`;
	if (start === undefined) return `${base}:1+${count}`;
	return count === undefined ? `${base}:${start}-` : `${base}:${start}+${count}`;
}

const READ_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

function isReadRangeList(value: string): boolean {
	return value.split(",").every(chunk => {
		const match = READ_RANGE_CHUNK_RE.exec(chunk);
		if (!match) return false;
		const start = Number.parseInt(match[1]!, 10);
		if (start < 1) return false;
		const separator = match[2];
		if (!separator) return true;
		const end = match[3] ? Number.parseInt(match[3], 10) : undefined;
		if (separator === "+") return end !== undefined && end >= 1;
		return end === undefined || end >= start;
	});
}

export function piReadPathHasRange(readPath: string): boolean {
	const chunks = readPath.split(":");
	const last = chunks.at(-1);
	if (last && isReadRangeList(last)) return true;
	if (last?.toLowerCase() !== "raw") return false;
	const preceding = chunks.at(-2);
	return preceding !== undefined && isReadRangeList(preceding);
}

export function cursorRawReadPath(readPath: string): string {
	const chunks = readPath.split(":");
	if (chunks.some(chunk => chunk.toLowerCase() === "raw")) return readPath;
	if (piReadPathHasRange(readPath)) {
		const last = chunks.pop()!;
		return `${chunks.join(":")}:raw:${last}`;
	}
	return `${readPath}:raw`;
}

export function cursorEditOwnedReadPath(readPath: string, offset?: number, limit?: number): string | null {
	const ranged = piReadPath(readPath, offset, limit);
	if (ranged === null) return null;
	return cursorRawReadPath(ranged);
}

export function piReadDisplayPath(readPath: string, offset?: number, limit?: number): string {
	const composed = piReadPath(readPath, offset, limit);
	if (composed !== null) return composed;
	const start = offset !== undefined ? Math.max(1, Math.floor(offset)) : 1;
	return `${readPath}:raw:${start}+0`;
}

export function piGrepSkip(offset?: number): number | undefined {
	return offset !== undefined && offset > 0 ? Math.floor(offset) : undefined;
}

export function piJoinPath(basePath: string | undefined, pattern: string): string {
	if (path.isAbsolute(pattern)) return pattern;
	if (!basePath || basePath === ".") return pattern;
	return path.join(basePath, pattern);
}

export function piLsPath(basePath: string | undefined): string {
	return basePath || ".";
}

export function piEscapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function piLimit(limit: number | undefined): number | undefined {
	return limit === undefined ? undefined : Math.max(1, Math.floor(limit));
}

export function piTimeout(timeout: number | undefined): number | undefined {
	return timeout !== undefined && timeout >= 0 ? timeout : undefined;
}

export function omitUndefinedArgs<T extends Record<string, unknown>>(
	args: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(args)) {
		const value = args[key];
		if (value !== undefined) out[key] = value;
	}
	return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
