/**
 * Wire codec for standalone kernels (node-entry.ts ↔ context-manager.ts). Bun and Node share only JSON
 * IPC serialization — their structured-clone formats differ — so each message crosses as one JSON
 * string. The codec keeps the structured-clone contract CLI-hosted Bun kernels get from "advanced" IPC: what
 * plain JSON would flatten (undefined, NaN/±Infinity/-0, bigints, bytes, Date, RegExp, Map, Set, errors,
 * cycles and shared references) crosses as tagged nodes, and what structured clone rejects (functions,
 * symbols, promises, weak collections) throws a DataCloneError instead of silently vanishing. Host-side
 * validators (artifact values, tool arguments) therefore see the same values for `node` and `bun` cells.
 */

const TAG = "\u0000proto";

type Encoded = null | boolean | number | string | Encoded[] | { [key: string]: Encoded };

type Tagged =
	| { [TAG]: "undefined" }
	| { [TAG]: "number"; value: string }
	| { [TAG]: "bigint"; value: string }
	| { [TAG]: "ref"; id: number }
	| { [TAG]: "date"; value: Encoded }
	| { [TAG]: "regexp"; source: string; flags: string }
	| { [TAG]: "bytes"; kind: BinaryKind; value: string }
	| { [TAG]: "map"; entries: [Encoded, Encoded][] }
	| { [TAG]: "set"; values: Encoded[] }
	| { [TAG]: "error"; name: string; message: string; stack?: string; cause?: Encoded }
	// A plain object that itself owns the tag key; entries keep it from decoding as a tagged node.
	| { [TAG]: "object"; entries: [string, Encoded][] };

const TYPED_ARRAYS = {
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array,
};
type BinaryKind = keyof typeof TYPED_ARRAYS | "ArrayBuffer" | "DataView";

const ERRORS: Record<string, ErrorConstructor> = {
	Error,
	EvalError,
	RangeError,
	ReferenceError,
	SyntaxError,
	TypeError,
	URIError,
};

function dataCloneError(what: string): DOMException {
	return new DOMException(`${what} could not be cloned.`, "DataCloneError");
}

function setOwn(target: object, key: string, value: unknown): void {
	// Plain assignment would treat an own "__proto__" key as a prototype change.
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

export function encodeNodeKernelMessage(message: unknown): string {
	// Objects are numbered in pre-order as first seen; the decoder numbers them in the same order.
	const seen = new Map<object, number>();
	const encode = (value: unknown): Encoded => {
		switch (typeof value) {
			case "string":
			case "boolean":
				return value;
			case "number":
				return Number.isFinite(value) && !Object.is(value, -0)
					? value
					: tagged({ [TAG]: "number", value: Object.is(value, -0) ? "-0" : String(value) });
			case "bigint":
				return tagged({ [TAG]: "bigint", value: value.toString() });
			case "undefined":
				return tagged({ [TAG]: "undefined" });
			case "symbol":
				throw dataCloneError(value.toString());
			case "function":
				throw dataCloneError(value.name ? `function ${value.name}` : "anonymous function");
		}
		if (value === null) return null;
		const object = value as object;
		const ref = seen.get(object);
		if (ref !== undefined) return tagged({ [TAG]: "ref", id: ref });
		if (
			object instanceof Promise ||
			object instanceof WeakMap ||
			object instanceof WeakSet ||
			object instanceof WeakRef
		)
			throw dataCloneError(Object.prototype.toString.call(object));
		seen.set(object, seen.size);
		// Array.from visits holes as undefined.
		if (Array.isArray(object)) return Array.from(object as unknown[], item => encode(item));
		if (object instanceof Date) return tagged({ [TAG]: "date", value: encode(object.getTime()) });
		if (object instanceof RegExp) return tagged({ [TAG]: "regexp", source: object.source, flags: object.flags });
		if (object instanceof ArrayBuffer) return bytes("ArrayBuffer", new Uint8Array(object));
		if (ArrayBuffer.isView(object)) {
			// "[object Uint8Array]" for a Node Buffer too, which structured clone also sends as a Uint8Array.
			const kind = Object.prototype.toString.call(object).slice(8, -1);
			if (kind !== "DataView" && !Object.hasOwn(TYPED_ARRAYS, kind)) throw dataCloneError(kind);
			return bytes(kind as BinaryKind, new Uint8Array(object.buffer, object.byteOffset, object.byteLength));
		}
		if (object instanceof Map)
			return tagged({ [TAG]: "map", entries: Array.from(object, ([key, item]) => [encode(key), encode(item)]) });
		if (object instanceof Set) return tagged({ [TAG]: "set", values: Array.from(object, item => encode(item)) });
		if (object instanceof Error) {
			const error: Tagged = { [TAG]: "error", name: object.name, message: object.message };
			if (typeof object.stack === "string") error.stack = object.stack;
			if ("cause" in object) error.cause = encode(object.cause);
			return tagged(error);
		}
		const record = object as Record<string, unknown>;
		const keys = Object.keys(record);
		if (Object.hasOwn(record, TAG))
			return tagged({ [TAG]: "object", entries: keys.map(key => [key, encode(record[key])]) });
		const encoded: { [key: string]: Encoded } = {};
		for (const key of keys) setOwn(encoded, key, encode(record[key]));
		return encoded;
	};
	return JSON.stringify(encode(message));
}

function tagged(node: Tagged): Encoded {
	return node as unknown as Encoded;
}

function bytes(kind: BinaryKind, view: Uint8Array): Encoded {
	return tagged({
		[TAG]: "bytes",
		kind,
		value: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64"),
	});
}

export function decodeNodeKernelMessage(raw: unknown): unknown {
	if (typeof raw !== "string") throw new Error("Node kernel IPC frame is not an encoded message");
	const refs: unknown[] = [];
	const decode = (value: Encoded): unknown => {
		if (value === null || typeof value !== "object") return value;
		if (Array.isArray(value)) {
			const array: unknown[] = [];
			refs.push(array);
			for (const item of value) array.push(decode(item));
			return array;
		}
		if (!Object.hasOwn(value, TAG)) {
			const object = {};
			refs.push(object);
			for (const [key, item] of Object.entries(value)) setOwn(object, key, decode(item));
			return object;
		}
		const node = value as unknown as Tagged;
		switch (node[TAG]) {
			case "undefined":
				return undefined;
			case "number":
				return Number(node.value);
			case "bigint":
				return BigInt(node.value);
			case "ref":
				if (!(node.id < refs.length)) throw new Error(`Node kernel IPC frame references unknown object ${node.id}`);
				return refs[node.id];
			case "date": {
				const date = new Date(decode(node.value) as number);
				refs.push(date);
				return date;
			}
			case "regexp": {
				const regexp = new RegExp(node.source, node.flags);
				refs.push(regexp);
				return regexp;
			}
			case "bytes": {
				const data = new Uint8Array(Buffer.from(node.value, "base64"));
				const binary =
					node.kind === "ArrayBuffer"
						? data.buffer
						: node.kind === "DataView"
							? new DataView(data.buffer)
							: new TYPED_ARRAYS[node.kind](data.buffer);
				refs.push(binary);
				return binary;
			}
			case "map": {
				const map = new Map<unknown, unknown>();
				refs.push(map);
				for (const [key, item] of node.entries) {
					const decodedKey = decode(key);
					map.set(decodedKey, decode(item));
				}
				return map;
			}
			case "set": {
				const set = new Set<unknown>();
				refs.push(set);
				for (const item of node.values) set.add(decode(item));
				return set;
			}
			case "error": {
				const error = new (ERRORS[node.name] ?? Error)(node.message);
				if (error.name !== node.name) setOwn(error, "name", node.name);
				refs.push(error);
				if (node.stack !== undefined) setOwn(error, "stack", node.stack);
				if (node.cause !== undefined) setOwn(error, "cause", decode(node.cause));
				return error;
			}
			case "object": {
				const object = {};
				refs.push(object);
				for (const [key, item] of node.entries) setOwn(object, key, decode(item));
				return object;
			}
			default:
				throw new Error(`Node kernel IPC frame has unknown tag ${JSON.stringify(value[TAG])}`);
		}
	};
	return decode(JSON.parse(raw) as Encoded);
}
