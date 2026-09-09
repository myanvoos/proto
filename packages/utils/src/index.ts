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
