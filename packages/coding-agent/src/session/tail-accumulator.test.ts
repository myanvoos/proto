import { expect, test } from "bun:test";
import { TailAccumulator } from "./streaming-output";

test("retains the most recent bytes and reports what it dropped", () => {
	const tail = new TailAccumulator(10);
	tail.push("aaaaa");
	tail.push("bbbbb");
	expect(tail.text()).toBe("aaaaabbbbb");
	expect(tail.droppedBytes).toBe(0);

	tail.push("ccccc");
	expect(tail.text()).toBe("bbbbbccccc");
	expect(tail.droppedBytes).toBe(5);
});

test("keeps the newest chunk even when it alone exceeds the window", () => {
	const tail = new TailAccumulator(4);
	tail.push("old");
	tail.push("a much longer final chunk");

	expect(tail.text()).toBe("a much longer final chunk");
	expect(tail.droppedBytes).toBe(3);
});

test("counts UTF-8 bytes rather than code units when evicting", () => {
	// Four 3-byte characters fill a 12-byte window exactly; one more must evict the first chunk.
	const tail = new TailAccumulator(12);
	tail.push("世界");
	tail.push("你好");
	expect(tail.text()).toBe("世界你好");
	expect(tail.droppedBytes).toBe(0);

	tail.push("!");
	expect(tail.text()).toBe("你好!");
	expect(tail.droppedBytes).toBe(6);
});

test("ignores empty pushes so emptiness tracks real output", () => {
	const tail = new TailAccumulator(100);
	expect(tail.isEmpty).toBe(true);
	tail.push("");
	expect(tail.isEmpty).toBe(true);
	tail.push("x");
	expect(tail.isEmpty).toBe(false);
});
