import { expect, test } from "bun:test";
import { AgentSideConnection } from "./connection";
import type { Agent, PromptResponse } from "./protocol";
import type { AnyMessage } from "./transport";

interface Wire {
	connection: AgentSideConnection;
	send(message: AnyMessage): Promise<void>;
	next(): Promise<AnyMessage>;
	close(): Promise<void>;
}

function connect(agent: Agent): Wire {
	const inbound = new TransformStream<AnyMessage, AnyMessage>();
	const outbound = new TransformStream<AnyMessage, AnyMessage>();
	const connection = new AgentSideConnection(() => agent, {
		readable: inbound.readable,
		writable: outbound.writable,
	});
	const writer = inbound.writable.getWriter();
	const reader = outbound.readable.getReader();
	return {
		connection,
		send: message => writer.write(message),
		next: async () => {
			const { value, done } = await reader.read();
			if (done || value === undefined) throw new Error("connection closed");
			return value;
		},
		close: async () => {
			await writer.close();
			await connection.closed;
		},
	};
}

function baseAgent(overrides: Partial<Agent>): Agent {
	return {
		initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
		newSession: () => ({ sessionId: "session-1" }),
		prompt: () => ({ stopReason: "end_turn" }),
		cancel: () => {},
		...overrides,
	};
}

test("$/cancel_request for a prompt cancels its turn and the prompt answers with its own result", async () => {
	const cancelled: string[] = [];
	const turn = Promise.withResolvers<PromptResponse>();
	const wire = connect(
		baseAgent({
			prompt: () => turn.promise,
			cancel: ({ sessionId }) => {
				cancelled.push(sessionId);
				turn.resolve({ stopReason: "cancelled" });
			},
		}),
	);
	await wire.send({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s1", prompt: [] } });
	await wire.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 1 } });

	expect(await wire.next()).toEqual({ jsonrpc: "2.0", id: 1, result: { stopReason: "cancelled" } });
	expect(cancelled).toEqual(["s1"]);
	await wire.close();
});

test("$/cancel_request answers any other in-flight request with -32800 and drops its late result", async () => {
	const release = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const wire = connect(
		baseAgent({
			setSessionMode: async () => {
				started.resolve();
				await release.promise;
				return {};
			},
		}),
	);
	await wire.send({ jsonrpc: "2.0", id: 2, method: "session/set_mode", params: { sessionId: "s1", modeId: "x" } });
	await started.promise;
	await wire.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 2 } });
	expect(await wire.next()).toMatchObject({ id: 2, error: { code: -32800 } });

	release.resolve();
	await wire.send({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: 1 } });
	expect(await wire.next()).toMatchObject({ id: 3, result: { protocolVersion: 1 } });
	await wire.close();
});

test("a session created for a cancelled session/new is closed instead of leaked", async () => {
	const release = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<string>();
	const wire = connect(
		baseAgent({
			newSession: async () => {
				await release.promise;
				return { sessionId: "unclaimed" };
			},
			closeSession: ({ sessionId }) => {
				closed.resolve(sessionId);
			},
		}),
	);
	await wire.send({ jsonrpc: "2.0", id: 4, method: "session/new", params: { cwd: "/", mcpServers: [] } });
	await wire.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 4 } });
	expect(await wire.next()).toMatchObject({ id: 4, error: { code: -32800 } });
	release.resolve();
	expect(await closed.promise).toBe("unclaimed");
	await wire.close();
});

test("aborting an outbound request withdraws it with $/cancel_request and rejects with -32800", async () => {
	const wire = connect(baseAgent({}));
	const controller = new AbortController();
	const elicitation = wire.connection.unstable_createElicitation(
		{ mode: "form", sessionId: "s1", message: "Proceed?", requestedSchema: { type: "object", properties: {} } },
		{ signal: controller.signal },
	);
	const request = await wire.next();
	expect(request).toMatchObject({ method: "elicitation/create" });
	const requestId = "id" in request ? request.id : undefined;

	controller.abort();
	await expect(elicitation).rejects.toMatchObject({ code: -32800 });
	expect(await wire.next()).toEqual({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId } });
	// The client's late answer lands on the withdrawn id and is ignored.
	await wire.send({ jsonrpc: "2.0", id: requestId ?? null, result: { action: "cancel" } });
	await wire.close();
});
