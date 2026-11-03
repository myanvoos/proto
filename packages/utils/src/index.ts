export { isAbortError, isCancellation, isTimeoutError, once, untilAborted } from "./abortable";
export * from "./async";
export * from "./atomic-write";
export * from "./binary";
export * from "./bytes";
export * from "./color";
export * from "./conformance";
export * from "./dirs";
export * from "./env";
export * from "./fetch-retry";
export * from "./file-lock";
export * from "./format";
export * from "./frontmatter";
export * from "./fs-error";
export * from "./fs-open";
export * from "./intent";
export * from "./json";
export * from "./json-parse";
export * from "./levenshtein";
export * as logger from "./logger";
export * from "./loop-phase";
export * from "./materialize-string";
export * from "./math";
export * from "./mermaid-ascii";
export * from "./mime";
export * from "./path-tree";
export * from "./peek-file";
export * as postmortem from "./postmortem";
export * from "./process-name";
export * as procmgr from "./procmgr";
export * as prompt from "./prompt";
export * as ptree from "./ptree";
export { AbortError, ChildProcess, Exception, NonZeroExitError } from "./ptree";
export * from "./runtime-install";
export * from "./sanitize-text";
export * from "./snowflake";
export * from "./sqlite";
export * from "./stderr-guard";
export * from "./stream";
export * from "./tab-spacing";
export * from "./temp";
export * from "./tls-fetch";
export * from "./type-guards";
export * from "./version";
export * from "./which";

function isPlainObject(val: object): val is Record<string, unknown> {
	return Object.getPrototypeOf(val) === Object.prototype || Array.isArray(val);
}

export function structuredCloneJSON<T>(value: T): T {
	if (!value || typeof value !== "object") {
		return value;
	}

	if (isPlainObject(value)) {
		try {
			return structuredClone(value);
		} catch {}
	}
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Deep-copies a JSON-shaped tree (arrays and plain or null-prototype objects)
 * so later mutation of the source can never reach the copy. Strings and other
 * primitives are immutable and shared, so the cost is O(containers) instead of
 * `structuredClone`'s O(bytes) — the difference matters for hot paths that
 * re-copy large string payloads (e.g. streamed tool-call arguments) per delta.
 *
 * Copies own enumerable string keys only. Any other object (class instance,
 * Date, Map, inherited-prototype object) is copied with {@link structuredCloneJSON}.
 * Not cycle-safe: callers MUST pass acyclic data, as any JSON-serializable value is.
 */
export function cloneJsonTree<T>(value: T): T {
	return cloneJsonNode(value) as T;
}

function isJsonRecord(value: object): value is Record<string, unknown> {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function cloneJsonNode(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		const length = value.length;
		const out: unknown[] = new Array(length);
		for (let i = 0; i < length; i++) out[i] = cloneJsonNode(value[i]);
		return out;
	}
	if (!isJsonRecord(value)) return structuredCloneJSON(value);
	const out: Record<string, unknown> = {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const child = cloneJsonNode(value[key]);
		// Assigning `__proto__` would swap the copy's prototype instead of
		// creating the own data property JSON.parse produces.
		if (key === "__proto__") {
			Object.defineProperty(out, key, { value: child, enumerable: true, writable: true, configurable: true });
		} else {
			out[key] = child;
		}
	}
	return out;
}
