import { expect, test } from "bun:test";
import { RpcInputDispatcher, type RpcInputFrameDeps, RpcShutdownCoordinator } from "./rpc-mode";
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
