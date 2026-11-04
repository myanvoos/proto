import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "./client";
import { BrokerExecutionAdmission, BrokerExecutionAdmissionClient } from "./execution-admission";
import { daemonBrokerEndpoint } from "./paths";
import { parseDaemonWireRequest } from "./protocol";

test("two socket clients share broker capacity and a cancelled pending acquisition cannot leak a lease", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-broker-admission-"));
	await Bun.write(path.join(dir, "broker.token"), "token");
	const admission = new BrokerExecutionAdmission(1);
	const sockets = new Set<net.Socket>();
	const secondRequested = Promise.withResolvers<void>();
	let acquisitions = 0;
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			for (;;) {
				const end = buffer.indexOf("\n");
				if (end < 0) break;
				const request = parseDaemonWireRequest(JSON.parse(buffer.slice(0, end)));
				buffer = buffer.slice(end + 1);
				void (async () => {
					const op = request.operation;
					try {
						let result: object;
						if (op.op === "ping")
							result = {
								op: "ping",
								projectDir: dir,
								protocolVersion: 2,
								capabilities: ["execution-admission"],
							};
						else if (op.op === "execution-acquire") {
							if (++acquisitions === 2) secondRequested.resolve();
							await admission.acquire(op);
							result = { op: op.op, leaseId: op.leaseId };
						} else if (op.op === "execution-release") {
							await admission.release(op.leaseId, op.ownerPid);
							result = { op: op.op, leaseId: op.leaseId };
						} else throw new Error("Unexpected fixture operation");
						socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
					} catch (error) {
						if (!socket.destroyed)
							socket.write(`${JSON.stringify({ id: request.id, ok: false, error: String(error) })}\n`);
					}
				})();
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(daemonBrokerEndpoint(dir, dir), listening.resolve);
	await listening.promise;
	const firstClient = await createDaemonBrokerClient(dir, { runtimeDir: dir });
	const secondClient = await createDaemonBrokerClient(dir, { runtimeDir: dir });
	try {
		const first = new BrokerExecutionAdmissionClient(firstClient);
		const second = new BrokerExecutionAdmissionClient(secondClient);
		const active = await first.acquire({
			nodeId: "a",
			treeId: "root-a",
			maxConcurrency: 1,
			signal: new AbortController().signal,
		});
		const cancelled = new AbortController();
		const queued = second.acquire({ nodeId: "b", treeId: "root-b", maxConcurrency: 1, signal: cancelled.signal });
		const outcome = queued.catch(error => error);
		await secondRequested.promise;
		cancelled.abort(new Error("cancelled acquisition"));
		expect(await outcome).toBeInstanceOf(Error);
		await active.release();
		const after = await withTimeout(
			second.acquire({ nodeId: "c", treeId: "root-b", maxConcurrency: 1, signal: new AbortController().signal }),
			1_000,
			"cancelled broker request leaked capacity",
		);
		await after.release();
	} finally {
		firstClient.close();
		secondClient.close();
		await admission.close();
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("the actual broker process enforces one shared cap across independent client connections", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-real-broker-admission-"));
	const first = await createDaemonBrokerClient(dir, { runtimeDir: dir, idleGraceMs: 100 });
	const second = await createDaemonBrokerClient(dir, { runtimeDir: dir, idleGraceMs: 100 });
	const leases = Array.from({ length: 32 }, (_, index) => `real-${index}`);
	try {
		await Promise.all(
			leases.map(leaseId =>
				first.request({
					op: "execution-acquire",
					leaseId,
					ownerPid: process.pid,
					nodeId: leaseId,
					treeId: "real-root",
				}),
			),
		);
		await second.ensureCapability("execution-admission");
		let granted = false;
		const queued = second
			.request({
				op: "execution-acquire",
				leaseId: "other-host",
				ownerPid: process.pid,
				nodeId: "other-node",
				treeId: "other-root",
			})
			.then(() => {
				granted = true;
			});
		await second.request({ op: "ping" });
		expect(granted).toBe(false);
		await first.request({ op: "execution-release", leaseId: leases[0], ownerPid: process.pid });
		await withTimeout(queued, 5_000, "actual broker did not return shared capacity");
		expect(granted).toBe(true);
		await second.request({ op: "execution-release", leaseId: "other-host", ownerPid: process.pid });
		await Promise.all(
			leases.slice(1).map(leaseId => first.request({ op: "execution-release", leaseId, ownerPid: process.pid })),
		);
	} finally {
		await first.request({ op: "shutdown" }).catch(() => {});
		first.close();
		second.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);

test("broker restart retains acknowledged active host reservations until explicit release", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-broker-lease-"));
	const file = path.join(dir, "leases.json");
	const original = new BrokerExecutionAdmission(1, file);
	const restored = new BrokerExecutionAdmission(1, file);
	try {
		await original.acquire({ leaseId: "active", ownerPid: process.pid, nodeId: "a", treeId: "A" });
		await original.detach();
		await restored.initialize();
		let entered = false;
		const queued = restored
			.acquire({ leaseId: "queued", ownerPid: process.pid, nodeId: "b", treeId: "B" })
			.then(() => {
				entered = true;
			});
		expect(entered).toBe(false);
		await restored.release("active", process.pid);
		await withTimeout(queued, 1_000, "restored reservation did not release");
		expect(entered).toBe(true);
		await restored.release("queued", process.pid);
		expect(await Bun.file(file).json()).toEqual([]);
	} finally {
		await restored.close();
		await original.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a dead host returns broker capacity without releasing a still-live host reservation", async () => {
	const host = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
		stdin: "pipe",
		stdout: "ignore",
		stderr: "ignore",
	});
	vi.useFakeTimers();
	const admission = new BrokerExecutionAdmission(1);
	try {
		await admission.acquire({ leaseId: "dead", ownerPid: host.pid, nodeId: "dead-node", treeId: "dead-root" });
		const next = admission.acquire({
			leaseId: "live",
			ownerPid: process.pid,
			nodeId: "live-node",
			treeId: "live-root",
		});
		host.stdin.end();
		await host.exited;
		vi.advanceTimersByTime(1_000);
		await next;
		await admission.release("live", process.pid);
	} finally {
		host.kill();
		await admission.close();
		vi.useRealTimers();
	}
});
