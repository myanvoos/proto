import { expect, test } from "bun:test";
import { encodeRpcFrame, RpcFrameEncoder } from "./rpc-frame";

const LARGE_TELEMETRY = "x".repeat(1_100_000);

function encodeCompacted(messages: readonly object[], streamedMessage: object): Record<string, unknown> {
	const encoder = new RpcFrameEncoder();
	encoder.encode({ type: "message_end", message: streamedMessage });
	return JSON.parse(encoder.encode({ type: "agent_end", messages, telemetry: LARGE_TELEMETRY, willContinue: true }));
}

test("compacts a wire-equivalent message even when object keys are reordered", () => {
	const frame = encodeCompacted([{ timestamp: 1, content: "same", role: "user" }], {
		role: "user",
		content: "same",
		timestamp: 1,
	});
	expect(frame.messages).toEqual([]);
	expect(frame.messageCount).toBe(1);
});

test("retains a message when equal fingerprints hide a changed middle field", () => {
	const streamed = { role: "user", content: "a".repeat(80), timestamp: 1 };
	const changed = { role: "user", content: `${"a".repeat(39)}b${"a".repeat(40)}`, timestamp: 1 };
	const frame = encodeCompacted([changed], streamed);
	expect(frame.messages).toHaveLength(1);
	expect(frame.messageCount).toBe(1);
});

test("keeps the legacy exact comparison for direct callers with non-wire fields", () => {
	const streamed = Object.create({ inherited: true }) as { role: string; content: string; timestamp: number };
	streamed.role = "user";
	streamed.content = "same";
	streamed.timestamp = 1;
	(streamed as Record<string, unknown>).nonWire = undefined;
	const frame = JSON.parse(
		encodeRpcFrame(
			{ type: "agent_end", messages: [{ role: "user", content: "same", timestamp: 1 }], telemetry: LARGE_TELEMETRY },
			1,
			[streamed],
		),
	) as { messages: unknown[] };
	expect(frame.messages).toHaveLength(1);
});
