import * as fs from "node:fs/promises";
import * as path from "node:path";
import { InternalUrlRouter } from "../internal-urls/router";
import type { ToolSession } from "../tools";
import { isInternalUrlPath, realPathWithinRoot, resolveReadPath } from "../tools/path-utils";
import { MAX_MEDIA_INPUT_BYTES } from "../utils/media-loading";

export const MAX_EVAL_ARTIFACT_BYTES = MAX_MEDIA_INPUT_BYTES;
export const MAX_EVAL_ARTIFACT_READ_BYTES = 1024 * 1024;
const MAX_SESSION_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_SESSION_ARTIFACTS = 1024;

export interface EvalArtifactRef {
	readonly type: "artifact";
	readonly version: 1;
	readonly uri: string;
	readonly owner: string;
	readonly mimeType: string;
	readonly bytes: number;
	readonly sha256: string;
}
export interface EvalArtifactOptions {
	session: ToolSession;
	signal?: AbortSignal;
}
export interface EvalArtifactPublishArgs {
	kind: "json" | "text" | "binary";
	value?: unknown;
	path?: string;
	mimeType?: string;
	encoding?: "base64";
}
export interface EvalArtifactReadArgs {
	/** An immutable ref, or the bare `artifact://<id>` URI of one this session published. */
	ref: EvalArtifactRef | string;
	offset?: number;
	length?: number;
	encoding?: "utf8" | "base64" | "json";
}
export interface EvalArtifactReadResult {
	ref: EvalArtifactRef;
	offset: number;
	bytes: number;
	eof: boolean;
	encoding: "utf8" | "base64" | "json";
	data: unknown;
}
export type EvalArtifactResult = EvalArtifactRef | EvalArtifactReadResult;
interface ArtifactRecord {
	ref: EvalArtifactRef;
	path: string;
	root: string;
}
interface ArtifactStore {
	owner: string;
	sessionId: string | null;
	artifacts: Map<string, ArtifactRecord>;
	bytes: number;
	pending: number;
}
const stores = new WeakMap<ToolSession, ArtifactStore>();
const disposed = new WeakSet<ToolSession>();

function sessionStore(options: EvalArtifactOptions): ArtifactStore {
	options.signal?.throwIfAborted();
	const { session } = options;
	if (disposed.has(session) || session.isDisposed?.()) throw new Error("Artifact session is disposed");
	const sessionId = session.getSessionId?.() ?? session.getEvalSessionId?.() ?? null;
	let store = stores.get(session);
	if (!store || store.sessionId !== sessionId) {
		store = { owner: crypto.randomUUID(), sessionId, artifacts: new Map(), bytes: 0, pending: 0 };
		stores.set(session, store);
	}
	return store;
}

/** Revoke handles, not session-owned artifact files. Kernel reset must not call this. */
export function disposeEvalArtifacts(session: ToolSession): void {
	stores.delete(session);
	disposed.add(session);
}

export function isEvalArtifactRef(value: unknown): value is EvalArtifactRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const ref = value as Record<string, unknown>;
	return (
		ref.type === "artifact" &&
		ref.version === 1 &&
		typeof ref.uri === "string" &&
		/^artifact:\/\/\d+$/.test(ref.uri) &&
		typeof ref.owner === "string" &&
		ref.owner.length > 0 &&
		typeof ref.mimeType === "string" &&
		validMimeType(ref.mimeType) &&
		typeof ref.bytes === "number" &&
		Number.isSafeInteger(ref.bytes) &&
		ref.bytes >= 0 &&
		ref.bytes <= MAX_EVAL_ARTIFACT_BYTES &&
		typeof ref.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(ref.sha256)
	);
}
function validMimeType(value: string): boolean {
	return value.length <= 128 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value);
}
function assertSize(bytes: number, limit = MAX_EVAL_ARTIFACT_BYTES): void {
	if (bytes > limit) throw new Error(`Artifact exceeds ${limit} byte limit`);
}

/** Strict wire base64: no whitespace, ignored garbage, or truncated padding. */
export function decodeEvalArtifactBase64(value: unknown, limit = MAX_EVAL_ARTIFACT_BYTES): Uint8Array {
	if (typeof value !== "string") throw new Error("Binary artifact base64 value must be a string");
	if (value.length > Math.ceil(limit / 3) * 4) throw new Error(`Artifact exceeds ${limit} byte limit`);
	const data = Buffer.from(value, "base64");
	assertSize(data.byteLength, limit);
	if (data.toString("base64") !== value) throw new Error("Artifact value is not canonical base64");
	return data;
}

/** Reject lossy JSON coercions and user code (getters/toJSON) before serialization. */
function stringifyJson(value: unknown): string {
	const active = new Set<object>();
	let nodes = 0;
	let bytes = 0;
	function account(size: number): void {
		bytes += size;
		assertSize(bytes);
	}
	function accountString(text: string): void {
		assertSize(Buffer.byteLength(text));
		account(Buffer.byteLength(JSON.stringify(text)));
	}
	function visit(item: unknown, depth: number): void {
		if (++nodes > 100_000 || depth > 64) throw new Error("JSON artifact nesting or node limit exceeded");
		if (typeof item === "string") {
			accountString(item);
			return;
		}
		if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
			account(JSON.stringify(item).length);
			return;
		}
		if (!item || typeof item !== "object") throw new Error("Artifact value must be lossless JSON");
		const array = Array.isArray(item);
		if (array && item.length > 100_000) throw new Error("JSON artifact node limit exceeded");
		if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
			throw new Error("Artifact value must contain only plain JSON objects");
		if (active.has(item)) throw new Error("Artifact value must be acyclic JSON");
		active.add(item);
		const descriptors = Object.getOwnPropertyDescriptors(item);
		if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string"))
			throw new Error("Artifact value cannot contain symbol keys");
		if (array) {
			if (Object.keys(item).length !== item.length)
				throw new Error("Artifact arrays cannot be sparse or have extra properties");
			for (let index = 0; index < item.length; index++)
				if (!Object.hasOwn(descriptors, String(index)))
					throw new Error("Artifact arrays cannot be sparse or have extra properties");
		}
		const entries = Object.entries(descriptors);
		const count = entries.length - (array ? 1 : 0);
		account(2 + Math.max(0, count - 1));
		for (const [key, descriptor] of entries) {
			if (array && key === "length") continue;
			if (!array) {
				accountString(key);
				account(1);
			}
			if (!descriptor.enumerable || !("value" in descriptor))
				throw new Error("Artifact JSON cannot contain accessors or hidden properties");
			visit(descriptor.value, depth + 1);
		}
		active.delete(item);
	}
	visit(value, 0);
	return JSON.stringify(value);
}
function decodeText(data: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
	} catch {
		throw new Error("Artifact is not valid UTF-8; use base64 for binary or split code points");
	}
}
async function readBoundedFile(filePath: string): Promise<Uint8Array> {
	const file = Bun.file(filePath);
	const stat = await file.stat();
	if (!stat.isFile()) throw new Error("Artifact source must be a regular file");
	assertSize(stat.size);
	const data = new Uint8Array(await file.slice(0, stat.size + 1).arrayBuffer());
	assertSize(data.byteLength);
	if (data.byteLength !== stat.size) throw new Error("Artifact file changed while reading; retry publication");
	return data;
}
async function publicationPath(value: string, options: EvalArtifactOptions): Promise<string> {
	const { session } = options;
	// artifact:// ids are session-local here, never the router's cross-session fallback.
	if (value.startsWith("artifact://")) {
		if (!/^artifact:\/\/\d+$/.test(value)) throw new Error("Artifact source requires an unselected artifact:// ID");
		const filePath = await session.getArtifactManager?.()?.getPath(value.slice("artifact://".length));
		if (!filePath) throw new Error("Artifact source does not belong to this session");
		return filePath;
	}
	if (!isInternalUrlPath(value)) return resolveReadPath(value, session.cwd);
	const resource = await InternalUrlRouter.instance().resolve(value, {
		cwd: session.cwd,
		signal: options.signal,
		localProtocolOptions: session.localProtocolOptions,
		skills: session.skills,
		pathOnly: true,
	});
	if (!resource.sourcePath || resource.isDirectory)
		throw new Error("Artifact source URL must resolve to a local file");
	return resource.sourcePath;
}
function checkKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) throw new Error(`Unknown artifact argument: ${key}`);
}

export async function publishEvalArtifact(
	args: EvalArtifactPublishArgs,
	options: EvalArtifactOptions,
): Promise<EvalArtifactRef> {
	const store = sessionStore(options);
	checkKeys(args as unknown as Record<string, unknown>, ["kind", "value", "path", "mimeType", "encoding"]);
	if (!["json", "text", "binary"].includes(args.kind)) throw new Error("Artifact kind must be json, text, or binary");
	if (Object.hasOwn(args, "value") === Object.hasOwn(args, "path"))
		throw new Error("Artifact publication requires exactly one of value or path");
	if (args.encoding !== undefined && (args.kind !== "binary" || args.encoding !== "base64" || args.path !== undefined))
		throw new Error("Artifact encoding is only valid for a binary base64 value");
	const mimeType =
		args.mimeType ??
		(args.kind === "json" ? "application/json" : args.kind === "text" ? "text/plain" : "application/octet-stream");
	if (typeof mimeType !== "string" || !validMimeType(mimeType))
		throw new Error("Artifact MIME type must be a lowercase type/subtype without parameters");
	if (args.kind === "json" && mimeType !== "application/json" && !mimeType.endsWith("+json"))
		throw new Error("JSON artifact requires a JSON MIME type");
	if (args.kind === "text" && !mimeType.startsWith("text/"))
		throw new Error("Text artifact requires a text MIME type");
	let data: Uint8Array;
	if (Object.hasOwn(args, "path")) {
		if (typeof args.path !== "string" || !args.path) throw new Error("Artifact path must be a nonempty string");
		data = await readBoundedFile(await publicationPath(args.path, options));
		if (args.kind !== "binary") {
			const text = decodeText(data);
			if (args.kind === "json") stringifyJson(JSON.parse(text));
		}
	} else if (args.kind === "json" || args.kind === "text") {
		if (args.kind === "text" && typeof args.value !== "string")
			throw new Error("Text artifact value must be a string");
		const text = args.kind === "json" ? stringifyJson(args.value) : (args.value as string);
		assertSize(Buffer.byteLength(text));
		data = new TextEncoder().encode(text);
	} else if (args.encoding === "base64") {
		data = decodeEvalArtifactBase64(args.value);
	} else if (args.value instanceof Uint8Array) {
		assertSize(args.value.byteLength);
		data = new Uint8Array(args.value);
	} else if (Array.isArray(args.value)) {
		assertSize(args.value.length);
		for (const byte of args.value)
			if (!Number.isInteger(byte) || byte < 0 || byte > 255)
				throw new Error("Binary artifact array requires integer bytes (0–255)");
		data = Uint8Array.from(args.value);
	} else {
		throw new Error("Binary artifact value requires bytes or encoding: base64");
	}
	assertSize(data.byteLength);
	if (sessionStore(options) !== store) throw new Error("Artifact session changed during publication");
	if (
		store.artifacts.size + store.pending >= MAX_SESSION_ARTIFACTS ||
		store.bytes + data.byteLength > MAX_SESSION_ARTIFACT_BYTES
	)
		throw new Error("Session artifact count or byte limit exceeded");
	const { session } = options;
	const manager = session.getArtifactManager?.();
	const root = manager?.dir ?? session.getArtifactsDir?.();
	if (!root) throw new Error("Session artifact storage is unavailable");
	store.pending++;
	store.bytes += data.byteLength;
	let writtenPath: string | undefined;
	try {
		const allocation = session.allocateOutputArtifact
			? await session.allocateOutputArtifact("kernel-artifact")
			: await manager?.allocatePath("kernel-artifact");
		if (!allocation?.path || !allocation.id || !/^\d+$/.test(allocation.id))
			throw new Error("Session artifact allocation is unavailable");
		if (!(await realPathWithinRoot(path.dirname(allocation.path), root)))
			throw new Error("Artifact allocation escapes session storage");
		const file = await fs.open(allocation.path, "wx", 0o600);
		writtenPath = allocation.path;
		try {
			await file.writeFile(data);
			await file.chmod(0o444);
		} finally {
			await file.close();
		}
		if (sessionStore(options) !== store) throw new Error("Artifact session changed during publication");
		const ref: EvalArtifactRef = Object.freeze({
			type: "artifact",
			version: 1,
			uri: `artifact://${allocation.id}`,
			owner: store.owner,
			mimeType,
			bytes: data.byteLength,
			sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"),
		});
		store.artifacts.set(ref.uri, { ref, path: allocation.path, root });
		return ref;
	} catch (error) {
		store.bytes -= data.byteLength;
		if (writtenPath) await fs.rm(writtenPath, { force: true });
		throw error;
	} finally {
		store.pending--;
	}
}

/** Look up a bare `artifact://<id>` URI among this session's published refs. */
function publishedRef(uri: string, store: ArtifactStore): EvalArtifactRef {
	if (!/^artifact:\/\/\d+$/.test(uri))
		throw new Error(`Invalid artifact reference ${JSON.stringify(uri)}: expected a published ref or artifact://<id>`);
	const record = store.artifacts.get(uri);
	if (!record)
		throw new Error(
			`${uri} was not published by this kernel session; read session output artifacts with the read tool`,
		);
	return record.ref;
}

/** Return a fresh byte snapshot after validating ownership, metadata, size, and SHA-256. */
export async function resolveEvalArtifact(
	handle: EvalArtifactRef | string,
	options: EvalArtifactOptions,
): Promise<{ ref: EvalArtifactRef; data: Uint8Array }> {
	const store = sessionStore(options);
	const ref = typeof handle === "string" ? publishedRef(handle, store) : handle;
	if (!isEvalArtifactRef(ref)) throw new Error("Invalid immutable artifact reference");
	if (ref.owner !== store.owner) throw new Error("Artifact reference belongs to another session");
	const record = store.artifacts.get(ref.uri);
	if (!record) throw new Error("Artifact reference is unavailable in this session");
	if (ref.bytes !== record.ref.bytes || ref.sha256 !== record.ref.sha256 || ref.mimeType !== record.ref.mimeType)
		throw new Error("Artifact reference metadata does not match its immutable handle");
	const filePath = await realPathWithinRoot(record.path, record.root);
	if (!filePath) throw new Error("Artifact file is outside session storage");
	const data = await readBoundedFile(filePath);
	if (data.byteLength !== ref.bytes || new Bun.CryptoHasher("sha256").update(data).digest("hex") !== ref.sha256)
		throw new Error("Artifact integrity check failed: size or SHA-256 changed");
	if (sessionStore(options) !== store) throw new Error("Artifact session changed during resolution");
	return { ref: record.ref, data };
}

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;

/**
 * UTF-8 pages end on a character boundary: a trailing character split by the
 * page limit is left for the next page (`offset + bytes`), so sequential paging
 * never fails spuriously. Truly invalid bytes still fail in `decodePage`.
 */
function utf8Page(data: Uint8Array, offset: number, length: number): Uint8Array {
	if (offset > 0 && offset < data.byteLength && isContinuationByte(data[offset]))
		throw new Error(
			`Artifact read offset ${offset} falls inside a UTF-8 character; start at a character boundary (previous offset + bytes), or use encoding="base64" for binary data`,
		);
	let end = Math.min(offset + length, data.byteLength);
	if (end < data.byteLength) {
		let lead = end - 1;
		while (lead > offset && lead > end - 4 && isContinuationByte(data[lead])) lead--;
		const byte = data[lead];
		const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		if (lead + width > end) end = lead;
	}
	if (end === offset && offset < data.byteLength)
		throw new Error(
			`Artifact read length ${length} cannot hold the UTF-8 character at offset ${offset}; use length >= 4`,
		);
	return data.subarray(offset, end);
}
function decodePage(bytes: Uint8Array, offset: number): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error(
			`Artifact bytes ${offset}–${offset + bytes.byteLength} are not valid UTF-8; read binary data with encoding="base64"`,
		);
	}
}

export async function readEvalArtifact(
	args: EvalArtifactReadArgs,
	options: EvalArtifactOptions,
): Promise<EvalArtifactReadResult> {
	checkKeys(args as unknown as Record<string, unknown>, ["ref", "offset", "length", "encoding"]);
	const offset = args.offset ?? 0;
	const length = args.length ?? 64 * 1024;
	const encoding = args.encoding ?? "utf8";
	if (!Number.isSafeInteger(offset) || offset < 0)
		throw new Error("Artifact read offset must be a nonnegative integer");
	if (!Number.isSafeInteger(length) || length < 1 || length > MAX_EVAL_ARTIFACT_READ_BYTES)
		throw new Error(`Artifact read length must be 1–${MAX_EVAL_ARTIFACT_READ_BYTES}`);
	if (!["base64", "utf8", "json"].includes(encoding))
		throw new Error("Artifact read encoding must be base64, utf8, or json");
	const resolved = await resolveEvalArtifact(args.ref, options);
	if (offset > resolved.data.byteLength) throw new Error("Artifact read offset exceeds its size");
	const bytes =
		encoding === "utf8" ? utf8Page(resolved.data, offset, length) : resolved.data.subarray(offset, offset + length);
	const eof = offset + bytes.byteLength === resolved.data.byteLength;
	if (encoding === "json" && (offset !== 0 || !eof))
		throw new Error("JSON artifact reads must include the entire artifact within the read limit");
	const data =
		encoding === "base64"
			? Buffer.from(bytes).toString("base64")
			: encoding === "utf8"
				? decodePage(bytes, offset)
				: JSON.parse(decodeText(bytes));
	return { ref: resolved.ref, offset, bytes: bytes.byteLength, eof, encoding, data };
}

export async function runEvalArtifact(args: unknown, options: EvalArtifactOptions): Promise<EvalArtifactResult> {
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Artifact bridge expects an object");
	const { op, ...request } = args as Record<string, unknown>;
	if (op === "artifact_publish") return publishEvalArtifact(request as unknown as EvalArtifactPublishArgs, options);
	if (op === "artifact_read") return readEvalArtifact(request as unknown as EvalArtifactReadArgs, options);
	if (op === "artifact_resolve") {
		checkKeys(request, ["ref"]);
		return (await resolveEvalArtifact(request.ref as EvalArtifactRef | string, options)).ref;
	}
	throw new Error(`Unknown artifact operation: ${String(op)}`);
}
