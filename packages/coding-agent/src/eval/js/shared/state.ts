import * as fs from "node:fs/promises";
import { types } from "node:util";
import { atomicWriteFile } from "@oh-my-pi/pi-utils/atomic-write";

const FORMAT = "proto.kernel-state";
const VERSION = 1;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;
const MAX_BINDINGS = 4096;
const IDENTIFIER = /^[$_\p{ID_Start}](?:[$\p{ID_Continue}]|\u200c|\u200d)*$/u;
const RESERVED: Record<string, true> = Object.fromEntries(
	"await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield"
		.split(" ")
		.map(name => [name, true]),
);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;

export interface StateInterpreter {
	implementation: string;
	version: string;
	executable: string;
}

export interface StateResult {
	path: string;
	names: string[];
	version: number;
	language: "javascript";
	interpreter: StateInterpreter;
}

export interface LoadStateOptions {
	collision?: "reject" | "overwrite";
}

type Encoded =
	| null
	| boolean
	| number
	| string
	| { type: string; value: Encoded[] | [string, Encoded][] | string; kind?: string };
interface Snapshot {
	format: string;
	version: number;
	language: "javascript";
	interpreter: StateInterpreter;
	bindings: { name: string; value: Encoded }[];
}

/** The runtime executing this kernel: Bun, or Node for `node` cells (eval/js/node-entry.ts). */
export function runtimeInterpreter(): StateInterpreter {
	return typeof Bun !== "undefined"
		? { implementation: "bun", version: Bun.version, executable: process.execPath }
		: { implementation: "node", version: process.versions.node, executable: process.execPath };
}

function bindingName(value: unknown, reserved: ReadonlySet<string>): string {
	if (
		typeof value !== "string" ||
		!IDENTIFIER.test(value) ||
		value.startsWith("__") ||
		Object.hasOwn(RESERVED, value) ||
		reserved.has(value)
	)
		throw new Error("state binding name must be a non-reserved identifier");
	return value;
}

class Budget {
	#nodes = 0;
	#bytes = 0;
	visit(depth: number, size = 0): void {
		this.#nodes++;
		this.#bytes += size;
		if (depth > MAX_DEPTH || this.#nodes > MAX_NODES || this.#bytes > MAX_BYTES)
			throw new Error("state exceeds the depth, item, or 16 MiB size limit");
	}
}

function encode(value: unknown, active: Set<object>, budget: Budget, depth = 0): Encoded {
	budget.visit(depth);
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		budget.visit(depth, value.length);
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("state numbers must be finite");
		// JSON itself does not preserve negative zero.
		if (Object.is(value, -0)) return { type: "negative-zero", value: "" };
		return value;
	}
	if (typeof value !== "object" || types.isProxy(value))
		throw new Error(
			"state supports only plain JSON values and bytes; objects, proxies, and resources are unsupported",
		);
	const prototype = Object.getPrototypeOf(value);
	let bytes: Buffer | undefined;
	let kind: string | undefined;
	if (types.isUint8Array(value) && (prototype === Uint8Array.prototype || prototype === Buffer.prototype)) {
		const buffer: ArrayBuffer = typedBuffer.call(value);
		if (types.isSharedArrayBuffer(buffer)) throw new Error("state cannot contain shared-memory resources");
		const length: number = typedLength.call(value);
		budget.visit(depth, Math.ceil(length / 3) * 4);
		bytes = Buffer.from(buffer, typedOffset.call(value), length);
		kind = prototype === Buffer.prototype ? "buffer" : "uint8array";
	} else if (types.isArrayBuffer(value) && prototype === ArrayBuffer.prototype) {
		bytes = Buffer.from(value as ArrayBuffer);
		budget.visit(depth, Math.ceil(bytes.length / 3) * 4);
		kind = "arraybuffer";
	}
	if (bytes) return { type: "bytes", kind, value: bytes.toString("base64") };
	const array = Array.isArray(value);
	if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
		throw new Error("state supports only plain JSON values and bytes; objects and resources are unsupported");
	if (active.has(value)) throw new Error("state cannot contain cycles");
	active.add(value);
	try {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Reflect.ownKeys(descriptors);
		if (array) {
			const length: number = descriptors.length.value;
			if (length > MAX_NODES || keys.length !== length + 1)
				throw new Error("state arrays must be dense and contain only indexed values");
			const items: Encoded[] = [];
			for (let index = 0; index < length; index++) {
				const descriptor = descriptors[index];
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
					throw new Error("state cannot contain accessors or sparse arrays");
				items.push(encode(descriptor.value, active, budget, depth + 1));
			}
			return { type: "array", value: items };
		}
		const entries: [string, Encoded][] = [];
		for (const key of keys) {
			if (typeof key !== "string") throw new Error("state object keys must be strings");
			const descriptor = descriptors[key];
			if (!("value" in descriptor) || !descriptor.enumerable)
				throw new Error("state cannot contain accessors or non-enumerable properties");
			budget.visit(depth + 1, key.length);
			entries.push([key, encode(descriptor.value, active, budget, depth + 1)]);
		}
		return { type: prototype === null ? "null-object" : "object", value: entries };
	} finally {
		active.delete(value);
	}
}

function fields(value: unknown, expected: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== expected.length ||
		expected.some(key => !Object.hasOwn(value, key))
	)
		throw new Error("invalid state snapshot fields");
	return value as Record<string, unknown>;
}

function decode(value: unknown, budget: Budget, depth = 0): unknown {
	budget.visit(depth);
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		budget.visit(depth, value.length);
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("state numbers must be finite");
		return value;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid encoded state value");
	const tag = (value as Record<string, unknown>).type;
	if (tag === "bytes") {
		const encoded = fields(value, ["type", "kind", "value"]);
		if (
			typeof encoded.value !== "string" ||
			!BASE64.test(encoded.value) ||
			typeof encoded.kind !== "string" ||
			!["buffer", "uint8array", "arraybuffer"].includes(encoded.kind)
		)
			throw new Error("invalid state bytes encoding");
		budget.visit(depth, encoded.value.length);
		const bytes = Buffer.from(encoded.value, "base64");
		if (bytes.toString("base64") !== encoded.value) throw new Error("invalid state bytes encoding");
		if (encoded.kind === "buffer") return bytes;
		const copied = new Uint8Array(bytes);
		return encoded.kind === "arraybuffer" ? copied.buffer : copied;
	}
	const encoded = fields(value, ["type", "value"]);
	if (tag === "negative-zero" && encoded.value === "") return -0;
	if (!Array.isArray(encoded.value)) throw new Error("invalid encoded state container");
	if (tag === "array") return encoded.value.map(item => decode(item, budget, depth + 1));
	if (tag === "object" || tag === "null-object") {
		const result: Record<string, unknown> = tag === "null-object" ? Object.create(null) : {};
		for (const pair of encoded.value) {
			if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || Object.hasOwn(result, pair[0]))
				throw new Error("invalid or duplicate state object key");
			budget.visit(depth + 1, pair[0].length);
			Object.defineProperty(result, pair[0], {
				value: decode(pair[1], budget, depth + 1),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return result;
	}
	throw new Error("unknown encoded state value type");
}

function validate(
	snapshot: unknown,
	reserved: ReadonlySet<string>,
): { snapshot: Snapshot; restored: Map<string, unknown> } {
	const state = fields(snapshot, ["format", "version", "language", "interpreter", "bindings"]);
	if (state.format !== FORMAT) throw new Error("invalid state snapshot format");
	if (state.version !== VERSION) throw new Error("unsupported state snapshot version");
	if (state.language !== "javascript") throw new Error("state snapshot language mismatch: expected javascript");
	const saved = fields(state.interpreter, ["implementation", "version", "executable"]);
	if (Object.values(saved).some(value => typeof value !== "string" || value.length === 0))
		throw new Error("invalid state interpreter metadata");
	if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(saved.version as string))
		throw new Error("invalid state interpreter version");
	const current = runtimeInterpreter();
	if (
		saved.implementation !== current.implementation ||
		(saved.version as string).split(".")[0] !== current.version.split(".")[0]
	)
		throw new Error("state interpreter implementation or major version mismatch");
	if (!Array.isArray(state.bindings) || state.bindings.length === 0 || state.bindings.length > MAX_BINDINGS)
		throw new Error("invalid state bindings");
	const restored = new Map<string, unknown>();
	const budget = new Budget();
	for (const raw of state.bindings) {
		const binding = fields(raw, ["name", "value"]);
		const name = bindingName(binding.name, reserved);
		if (restored.has(name)) throw new Error("duplicate state binding");
		restored.set(name, decode(binding.value, budget));
	}
	return { snapshot: snapshot as Snapshot, restored };
}

function summary(path: string, snapshot: Snapshot): StateResult {
	return {
		path,
		names: snapshot.bindings.map(binding => binding.name),
		version: VERSION,
		language: "javascript",
		interpreter: snapshot.interpreter,
	};
}

export async function saveKernelState(
	path: string,
	names: unknown,
	namespace: Record<string, unknown>,
	reserved: ReadonlySet<string>,
): Promise<StateResult> {
	// Validate the selection through the same descriptor-only encoder, too.
	const selection = encode(names, new Set(), new Budget());
	if (
		!selection ||
		typeof selection !== "object" ||
		selection.type !== "array" ||
		!Array.isArray(selection.value) ||
		selection.value.length === 0 ||
		selection.value.length > MAX_BINDINGS
	)
		throw new Error("state names must contain an explicit list of 1 to 4096 identifiers");
	const selected = selection.value.map(name => bindingName(name, reserved));
	if (new Set(selected).size !== selected.length) throw new Error("state names must not contain duplicates");
	const budget = new Budget();
	const bindings = selected.map(name => {
		const descriptor = Object.getOwnPropertyDescriptor(namespace, name);
		if (!descriptor) throw new Error(`selected state binding does not exist: ${name}`);
		if (!("value" in descriptor)) throw new Error("state cannot save an accessor binding");
		return { name, value: encode(descriptor.value, new Set(), budget) };
	});
	const snapshot: Snapshot = {
		format: FORMAT,
		version: VERSION,
		language: "javascript",
		interpreter: runtimeInterpreter(),
		bindings,
	};
	const encoded = `${JSON.stringify(snapshot)}\n`;
	if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error("state snapshot exceeds the 16 MiB size limit");
	await atomicWriteFile(path, encoded);
	return summary(path, snapshot);
}

export async function loadKernelState(
	path: string,
	namespace: Record<string, unknown>,
	reserved: ReadonlySet<string>,
	options: LoadStateOptions = {},
	beforeCommit?: (names: readonly string[]) => void,
): Promise<StateResult> {
	const encodedOptions = encode(options, new Set(), new Budget());
	if (!encodedOptions || typeof encodedOptions !== "object" || encodedOptions.type !== "object")
		throw new Error("invalid loadState options");
	const optionValues = decode(encodedOptions, new Budget()) as Record<string, unknown>;
	if (Object.keys(optionValues).some(key => key !== "collision")) throw new Error("unknown loadState option");
	const collision = Object.hasOwn(optionValues, "collision") ? optionValues.collision : "reject";
	if (collision !== "reject" && collision !== "overwrite")
		throw new Error('state collision must be "reject" or "overwrite"');
	const handle = await fs.open(path, "r");
	let text: string;
	try {
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > MAX_BYTES) throw new Error("state snapshot exceeds the 16 MiB size limit");
		text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
	} finally {
		await handle.close();
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("invalid state snapshot JSON");
	}
	const { snapshot, restored } = validate(raw, reserved);
	const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
	for (const [name, value] of restored) {
		const existing = Object.getOwnPropertyDescriptor(namespace, name);
		if (existing && collision === "reject") throw new Error(`state binding collision: ${name}`);
		if (!existing && name in namespace) throw new Error(`state cannot overwrite an inherited binding: ${name}`);
		if (existing && (!("value" in existing) || !existing.writable))
			throw new Error(`state cannot overwrite an accessor or read-only binding: ${name}`);
		if (!existing && !Object.isExtensible(namespace)) throw new Error("state namespace is not extensible");
		descriptors[name] = existing
			? { ...existing, value }
			: { value, enumerable: true, writable: true, configurable: true };
	}
	// No await or user code between preflight and commit to the ordinary global object.
	beforeCommit?.([...restored.keys()]);
	Object.defineProperties(namespace, descriptors);
	return summary(path, snapshot);
}
