import { expect, test } from "bun:test";
import {
	fitAbortAndRestoreQueueResponse,
	RpcInputDispatcher,
	type RpcInputFrameDeps,
	RpcShutdownCoordinator,
} from "./rpc-mode";
import type { RpcResponse } from "./rpc-types";

function rpcDeps(): RpcInputFrameDeps {
	return {
		handleCommand: async () => ({ type: "success" }) as unknown as RpcResponse,
		output: () => {},
		errorResponse: () => ({ type: "error" }) as unknown as RpcResponse,
		pendingExtensionRequests: new Map(),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
}

test("rejected tracked RPC tasks do not create derived unhandled rejections", async () => {
	const trackedTask = Promise.reject(new Error("tracked task failed"));
	const shutdown = new RpcShutdownCoordinator({
		isShutdownRequested: () => false,
		performShutdown: async () => {},
	});
	shutdown.track(trackedTask);
	await trackedTask.catch(() => {});
	await shutdown.drain();

	let cleanupAttempts = 0;
	const dispatcher = new RpcInputDispatcher({
		deps: rpcDeps(),
		afterSerialCommand: async () => {
			cleanupAttempts++;
			throw new Error("serial cleanup failed");
		},
	});
	dispatcher.dispatch({ type: "get_state", id: "test" });
	await dispatcher.drain();
	const nextTurn = Promise.withResolvers<void>();
	setImmediate(nextTurn.resolve);
	await nextTurn.promise;

	expect(cleanupAttempts).toBe(1);
});

test("withdrawing an oversized queue preserves its text and reports omitted image attachments", () => {
	const response = fitAbortAndRestoreQueueResponse(
		"withdraw",
		{
			steering: [
				{ text: "keep steering", images: [{ type: "image", mimeType: "image/png", data: "a".repeat(2000) }] },
			],
			followUp: [{ text: "keep follow-up" }],
		},
		400,
	);
	expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(400);
	expect(response).toMatchObject({
		success: true,
		data: {
			steering: [{ text: "keep steering" }],
			followUp: [{ text: "keep follow-up" }],
			imagesDropped: true,
		},
	});
});

test("withdrawing oversized text returns an oldest-first prefix with an explicit truncation flag", () => {
	const response = fitAbortAndRestoreQueueResponse(
		"withdraw",
		{
			steering: [{ text: "oldest" }, { text: "newer".repeat(500) }],
			followUp: [{ text: "latest" }],
		},
		200,
	);
	expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(200);
	expect(response).toMatchObject({
		success: true,
		data: { steering: [{ text: "oldest" }], followUp: [], truncated: true },
	});
});
