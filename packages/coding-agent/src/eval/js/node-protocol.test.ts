import { describe, expect, test } from "bun:test";
import { decodeNodeKernelMessage, encodeNodeKernelMessage } from "./node-protocol";

// The Node kernel's JSON IPC must keep the structured-clone contract Bun kernels get from "advanced"
// IPC: host validators (artifact values, tool arguments) reject lossy values only if they see them.
const roundTrip = (value: unknown): unknown => decodeNodeKernelMessage(encodeNodeKernelMessage(value));

describe("node kernel IPC codec", () => {
	test("preserves values plain JSON would flatten", () => {
		const decoded = roundTrip({
			missing: undefined,
			list: [1, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0],
			big: 12345678901234567890n,
			when: new Date(0),
			pattern: /a+b/giu,
			map: new Map<unknown, unknown>([
				[1, "one"],
				[{ k: 1 }, [2]],
			]),
			set: new Set(["x", 3]),
		}) as Record<string, unknown>;
		expect(Object.hasOwn(decoded, "missing")).toBe(true);
		expect(decoded.missing).toBeUndefined();
		const list = decoded.list as number[];
		expect(list).toHaveLength(6);
		expect(list[1]).toBeUndefined();
		expect(list[2]).toBeNaN();
		expect(list.slice(3, 5)).toEqual([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
		expect(Object.is(list[5], -0)).toBe(true);
		expect(decoded.big).toBe(12345678901234567890n);
		expect(decoded.when).toEqual(new Date(0));
		expect(decoded.pattern).toEqual(/a+b/giu);
		expect(decoded.map).toEqual(
			new Map<unknown, unknown>([
				[1, "one"],
				[{ k: 1 }, [2]],
			]),
		);
		expect(decoded.set).toEqual(new Set(["x", 3]));
	});

	test("preserves binary kinds and view bounds", () => {
		const backing = new Uint8Array([9, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		const decoded = roundTrip({
			slice: backing.subarray(1, 3),
			buffer: Buffer.from("hi"),
			raw: new Uint8Array([7, 8]).buffer,
			wide: new Uint16Array([1, 65535]),
			floats: new Float64Array([0.5]),
			view: new DataView(backing.buffer, 2, 2),
		}) as Record<string, unknown>;
		expect(decoded.slice).toEqual(new Uint8Array([1, 2]));
		expect(decoded.buffer).toBeInstanceOf(Uint8Array);
		expect([...(decoded.buffer as Uint8Array)]).toEqual([104, 105]);
		expect(decoded.raw).toBeInstanceOf(ArrayBuffer);
		expect([...new Uint8Array(decoded.raw as ArrayBuffer)]).toEqual([7, 8]);
		expect(decoded.wide).toEqual(new Uint16Array([1, 65535]));
		expect(decoded.floats).toEqual(new Float64Array([0.5]));
		expect(decoded.view).toBeInstanceOf(DataView);
		expect([...new Uint8Array((decoded.view as DataView).buffer)]).toEqual([2, 3]);
	});

	test("preserves cycles and shared references instead of stringifying them", () => {
		const shared = { id: "shared" };
		const root: Record<string, unknown> = { left: shared, right: [shared], map: new Map([["s", shared]]) };
		root.self = root;
		const decoded = roundTrip(root) as Record<string, unknown>;
		expect(decoded.self).toBe(decoded);
		expect((decoded.right as unknown[])[0]).toBe(decoded.left);
		expect((decoded.map as Map<string, unknown>).get("s")).toBe(decoded.left);
		expect(decoded.left).toEqual({ id: "shared" });
	});

	test("preserves errors with their class, stack, and cause", () => {
		const cause = new RangeError("inner");
		const outer = new TypeError("outer", { cause });
		const custom = new Error("custom");
		custom.name = "ValidationError";
		const decoded = roundTrip({ outer, custom }) as Record<string, Error>;
		expect(decoded.outer).toBeInstanceOf(TypeError);
		expect(decoded.outer.message).toBe("outer");
		expect(decoded.outer.stack).toBe(outer.stack);
		expect(decoded.outer.cause).toBeInstanceOf(RangeError);
		expect((decoded.outer.cause as Error).message).toBe("inner");
		expect(decoded.custom.name).toBe("ValidationError");
		expect(decoded.custom.message).toBe("custom");
	});

	test("user data shaped like a codec tag or carrying __proto__ decodes as the same plain data", () => {
		const lookalike = JSON.parse('{"\\u0000proto":"bigint","value":"5","__proto__":{"polluted":true}}');
		const decoded = roundTrip({ lookalike, text: "\u0000proto" }) as {
			lookalike: Record<string, unknown>;
			text: string;
		};
		expect(decoded.text).toBe("\u0000proto");
		expect(Object.keys(decoded.lookalike)).toEqual(["\u0000proto", "value", "__proto__"]);
		expect(decoded.lookalike["\u0000proto"]).toBe("bigint");
		expect(Object.getPrototypeOf(decoded.lookalike)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(decoded.lookalike, "__proto__")?.value).toEqual({ polluted: true });
	});

	test("rejects values structured clone cannot carry with a DataCloneError", () => {
		for (const value of [{ callback: () => 1 }, [Symbol("s")], { pending: Promise.resolve() }]) {
			let thrown: unknown;
			try {
				encodeNodeKernelMessage({ type: "tool-call", args: value });
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(DOMException);
			expect((thrown as DOMException).name).toBe("DataCloneError");
		}
	});
});
