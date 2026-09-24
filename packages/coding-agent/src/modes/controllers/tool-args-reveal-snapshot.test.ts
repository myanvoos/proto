import { expect, test } from "bun:test";
import { decodeStreamedToolArgs, decodeStreamedToolArgsSnapshot, ToolArgsRevealController } from "./tool-args-reveal";

const NOOP = () => {};

test("decoded snapshots preserve malformed prefixes and expose the same display view", () => {
	const partialJson = '{"command":"echo';
	const snapshot = decodeStreamedToolArgsSnapshot(partialJson, {
		rawInput: false,
		streamingStringKeys: [],
	});

	expect(snapshot.args).toEqual(decodeStreamedToolArgs(partialJson, { rawInput: false, streamingStringKeys: [] }));
	expect(snapshot.displayArgs).toEqual({ command: "echo", __partialJson: partialJson });
	expect(snapshot.args.__partialJson).toBe(partialJson);
});

test("eval code extraction is shared by classification and the initial renderer frame", () => {
	const partialJson = '{"code":"print(1 + 2)';
	const snapshot = decodeStreamedToolArgsSnapshot(partialJson, {
		rawInput: false,
		streamingStringKeys: ["code"],
	});
	const reveal = new ToolArgsRevealController({ getSmoothStreaming: () => true, requestRender: NOOP });

	try {
		const rendered = reveal.setTarget(
			"eval-1",
			partialJson,
			{ rawInput: false, exposeRawPartialJson: false, streamingStringKeys: ["code"] },
			snapshot,
		);
		expect(snapshot.extractedValues).toEqual({ code: "print(1 + 2)" });
		expect(snapshot.args.code).toBe("print(1 + 2)");
		expect(rendered).toBe(snapshot.displayArgs);
		expect(rendered.code).toBe("print(1 + 2)");
	} finally {
		reveal.stop();
	}
});

test("raw-input snapshots render incomplete wire input byte-for-byte", () => {
	const partialJson = 'raw \\"input\\" { not json';
	const snapshot = decodeStreamedToolArgsSnapshot(partialJson, { rawInput: true });
	const reveal = new ToolArgsRevealController({ getSmoothStreaming: () => true, requestRender: NOOP });

	try {
		const rendered = reveal.setTarget(
			"raw-1",
			partialJson,
			{ rawInput: true, exposeRawPartialJson: false },
			snapshot,
		);
		expect(rendered).toBe(snapshot.displayArgs);
		expect(rendered).toEqual({ input: partialJson, __partialJson: partialJson });
	} finally {
		reveal.stop();
	}
});

test("prefix reset starts a new decoded snapshot instead of retaining old fields", () => {
	const reveal = new ToolArgsRevealController({ getSmoothStreaming: () => false, requestRender: NOOP });
	try {
		const first = '{"command":"one"';
		const second = '{"path":"two"';
		const firstSnapshot = decodeStreamedToolArgsSnapshot(first, { rawInput: false });
		const secondSnapshot = decodeStreamedToolArgsSnapshot(second, { rawInput: false });
		reveal.setTarget("reset-1", first, { rawInput: false, exposeRawPartialJson: false }, firstSnapshot);
		const rendered = reveal.setTarget(
			"reset-1",
			second,
			{ rawInput: false, exposeRawPartialJson: false },
			secondSnapshot,
		);

		expect(rendered).toEqual(secondSnapshot.displayArgs);
		expect(rendered.command).toBeUndefined();
		expect(rendered.path).toBe("two");
	} finally {
		reveal.stop();
	}
});

test("1000 monotonically growing prefixes keep classification and rendering byte-equivalent", () => {
	const reveal = new ToolArgsRevealController({ getSmoothStreaming: () => false, requestRender: NOOP });
	try {
		for (let index = 0; index < 1000; index++) {
			const partialJson = `{"command":"${"x".repeat(index + 1)}`;
			const snapshot = decodeStreamedToolArgsSnapshot(partialJson, { rawInput: false });
			const rendered = reveal.setTarget(
				"monotonic-1",
				partialJson,
				{ rawInput: false, exposeRawPartialJson: false },
				snapshot,
			);
			expect(snapshot.args).toEqual(decodeStreamedToolArgs(partialJson, { rawInput: false }));
			expect(rendered).toBe(snapshot.displayArgs);
			expect(rendered.__partialJson).toBe(partialJson);
		}
	} finally {
		reveal.stop();
	}
});
