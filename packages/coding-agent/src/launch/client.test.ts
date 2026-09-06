import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient } from "./client";
import { daemonBrokerEndpoint } from "./paths";

async function connectionFixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-client-"));
	const sockets = new Set<net.Socket>();
	const requests: string[] = [];
	await Bun.write(path.join(dir, "broker.token"), "test-token");
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const request = JSON.parse(buffer.slice(0, newline)) as { id: string; operation: { op: string } };
				buffer = buffer.slice(newline + 1);
				requests.push(request.operation.op);
				socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { op: "ping", projectDir: dir } })}\n`);
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(daemonBrokerEndpoint(dir, dir), listening.resolve);
	await listening.promise;
	const client = await createDaemonBrokerClient(dir, { runtimeDir: dir });
	return {
		client,
		requests,
		async dispose() {
			client.close();
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => {
				if (error) closed.reject(error);
				else closed.resolve();
			});
			await closed.promise;
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

test("closing a client during connection never publishes the pending operation or leaves a live socket", async () => {
	const fixture = await connectionFixture();
	try {
		const pending = fixture.client.request({ op: "ping" });
		fixture.client.close();
		await expect(pending).rejects.toThrow("closed");
		expect(fixture.requests).toEqual([]);
	} finally {
		await fixture.dispose();
	}
});

test("aborting during connection does not publish the operation and leaves the client reusable", async () => {
	const fixture = await connectionFixture();
	try {
		const controller = new AbortController();
		const pending = fixture.client.request({ op: "ping" }, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		expect(fixture.requests).toEqual([]);
		expect(await fixture.client.request({ op: "ping" })).toMatchObject({ op: "ping" });
		expect(fixture.requests).toEqual(["ping"]);
	} finally {
		await fixture.dispose();
	}
});
