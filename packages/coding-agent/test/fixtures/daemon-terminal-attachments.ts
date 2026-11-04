import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import type { DaemonOperation } from "../../src/launch/protocol";

const project = process.argv[2]!;
const runtimeDir = path.join(project, "run");
await fs.mkdir(runtimeDir, { recursive: true });
await Bun.write(path.join(runtimeDir, "broker.token"), "terminal-attachment-fixture-token");
const endpoint = daemonBrokerEndpoint(project, runtimeDir);
const readiness = new AbortController();
const listenerReady = (async () => {
	for await (const event of fs.watch(runtimeDir, { signal: readiness.signal })) {
		if (event.filename !== path.basename(endpoint)) continue;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const socket = net.createConnection(endpoint);
		socket.once("connect", () => {
			socket.destroy();
			resolve();
		});
		socket.once("error", error => {
			socket.destroy();
			reject(error);
		});
		await promise;
		return;
	}
})();
const broker = startDaemonBrokerFromEnvironment();
const clients: DaemonBrokerClient[] = [];
const refused: string[] = [];
let first: DaemonBrokerClient | undefined;
try {
	await Promise.race([
		listenerReady,
		broker.then(() => {
			throw new Error("Broker exited before listening");
		}),
	]);
	readiness.abort();
	first = await createDaemonBrokerClient(project, { runtimeDir });
	const second = await createDaemonBrokerClient(project, { runtimeDir });
	const observer = await createDaemonBrokerClient(project, { runtimeDir });
	clients.push(first, second, observer);
	const started = await first.request({
		op: "start",
		spec: {
			name: "terminal",
			application: process.execPath,
			args: [path.resolve(import.meta.dir, "terminal-attachment-child.ts")],
			cwd: project,
			env: {},
			pty: true,
			persist: true,
			detached: false,
			restart: "no",
			ready: { log: "PTY_READY:", timeoutMs: 5000 },
		},
	});
	if (started.op !== "start" || started.readyTimedOut || !started.daemon.pid)
		throw new Error("PTY child did not become ready");
	const target = { name: "terminal", expectedId: started.daemon.id };
	const pid = started.daemon.pid;
	const reject = async (
		client: DaemonBrokerClient,
		operation: DaemonOperation,
		label: string = operation.op,
	): Promise<void> => {
		try {
			await client.request(operation);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("reattach")) throw error;
			refused.push(label);
			return;
		}
		throw new Error(`Unauthorized ${label} succeeded`);
	};
	const readUntil = async (
		client: DaemonBrokerClient,
		terminalLeaseId: string | undefined,
		cursor: number,
		pattern: string,
		stage = pattern,
	) => {
		let text = "";
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const frame = await client.request({
				op: "read",
				...target,
				terminalLeaseId,
				cursor,
				maxBytes: 64 * 1024,
				timeoutMs: 1000,
			});
			if (frame.op !== "read") throw new Error("Unexpected raw read reply");
			if (frame.reset || frame.omittedBytes) throw new Error("Fresh terminal output was lost");
			text += frame.text;
			cursor = frame.nextCursor;
			if (text.includes(pattern)) return { text, cursor };
			if (frame.daemon.state === "exited" || frame.daemon.state === "failed")
				throw new Error("PTY exited while awaiting output");
		}
		throw new Error(`PTY ${stage} did not emit ${pattern}; received ${JSON.stringify(text)}`);
	};

	const firstAttach = await first.request({ op: "terminal_attach", ...target, columns: 90, rows: 30 });
	if (firstAttach.op !== "terminal_attach") throw new Error("Unexpected attachment reply");
	const oldLease = firstAttach.terminalLeaseId;
	const firstScreen = await readUntil(first, oldLease, firstAttach.cursor, "SCREEN:", "first attach");
	await first.request({ op: "send", ...target, terminalLeaseId: oldLease, data: "size:first\n", enter: false });
	const firstSize = await readUntil(first, oldLease, firstScreen.cursor, "SIZE:first:90:30");
	await reject(observer, { op: "send", ...target, data: "emit:intruder\n", enter: false }, "unleased-send");
	await reject(
		observer,
		{ op: "terminal_resize", ...target, terminalLeaseId: oldLease, columns: 10, rows: 10 },
		"stolen-resize",
	);
	const observing = await observer.request({
		op: "read",
		...target,
		cursor: firstAttach.cursor,
		maxBytes: 64 * 1024,
		timeoutMs: 0,
	});
	if (observing.op !== "read" || !observing.text.includes("SIZE:first:90:30"))
		throw new Error("Read-only observer could not coexist");

	const pendingRead = first.request({
		op: "read",
		...target,
		terminalLeaseId: oldLease,
		cursor: firstSize.cursor,
		maxBytes: 4096,
		timeoutMs: 5000,
	});
	const pendingOutcome = pendingRead.then(
		() => "incorrectly-served",
		error => (error instanceof Error ? error.message : String(error)),
	);
	await first.request({ op: "ping" }); // Same-socket barrier: the long read has entered the broker before replacement.
	const replacement = await second.request({ op: "terminal_attach", ...target, columns: 90, rows: 30 });
	if (replacement.op !== "terminal_attach") throw new Error("Unexpected replacement attachment reply");
	const currentLease = replacement.terminalLeaseId;
	const replacementScreen = await readUntil(second, currentLease, replacement.cursor, "SCREEN:", "replacement");
	const pendingRejection = await pendingOutcome;
	if (!pendingRejection.includes("reattach"))
		throw new Error(`Pending old read retained authority: ${pendingRejection}`);
	for (const operation of [
		{ op: "read", ...target, terminalLeaseId: oldLease, cursor: replacement.cursor, maxBytes: 4096, timeoutMs: 0 },
		{ op: "send", ...target, terminalLeaseId: oldLease, data: "emit:intruder\n", enter: false },
		{ op: "terminal_resize", ...target, terminalLeaseId: oldLease, columns: 10, rows: 10 },
		{ op: "terminal_detach", ...target, terminalLeaseId: oldLease },
	] satisfies DaemonOperation[])
		await reject(first, operation);
	await reject(
		first,
		{
			op: "read",
			...target,
			terminalLeaseId: currentLease,
			cursor: replacement.cursor,
			maxBytes: 4096,
			timeoutMs: 0,
		},
		"stolen-read",
	);
	await reject(
		first,
		{ op: "send", ...target, terminalLeaseId: currentLease, data: "emit:intruder\n", enter: false },
		"stolen-send",
	);

	await second.request({ op: "terminal_resize", ...target, terminalLeaseId: currentLease, columns: 111, rows: 37 });
	const resizedScreen = await readUntil(second, currentLease, replacementScreen.cursor, ":111:37");
	await second.request({
		op: "send",
		...target,
		terminalLeaseId: currentLease,
		data: "size:resized\nemit:before-detach\n",
		enter: false,
	});
	const resized = await readUntil(second, currentLease, resizedScreen.cursor, "EVENT:before-detach");
	if (!resized.text.includes("SIZE:resized:111:37")) throw new Error("Resize did not reach child terminal dimensions");
	const effectiveSizes: string[] = [];
	let detachedCursor = resized.cursor;
	for (const geometry of [
		{ label: "minimum", columns: 1, rows: 1, actual: "20:5" },
		{ label: "maximum", columns: 1000, rows: 1000, actual: "400:200" },
	]) {
		await second.request({
			op: "terminal_resize",
			...target,
			terminalLeaseId: currentLease,
			columns: geometry.columns,
			rows: geometry.rows,
		});
		const screen = await readUntil(second, currentLease, detachedCursor, `:${geometry.actual}`);
		await second.request({
			op: "send",
			...target,
			terminalLeaseId: currentLease,
			data: `size:${geometry.label}\n`,
			enter: false,
		});
		const size = await readUntil(second, currentLease, screen.cursor, `SIZE:${geometry.label}:${geometry.actual}`);
		const observed = size.text.match(/SIZE:(?:minimum|maximum):\d+:\d+/)?.[0];
		if (!observed) throw new Error("Child omitted its effective terminal size");
		effectiveSizes.push(observed);
		detachedCursor = size.cursor;
	}
	await second.request({ op: "terminal_resize", ...target, terminalLeaseId: currentLease, columns: 111, rows: 37 });
	detachedCursor = (await readUntil(second, currentLease, detachedCursor, ":111:37")).cursor;
	await second.request({ op: "terminal_detach", ...target, terminalLeaseId: currentLease });
	await reject(
		second,
		{ op: "terminal_resize", ...target, terminalLeaseId: currentLease, columns: 90, rows: 30 },
		"detached-resize",
	);
	const afterDetach = await observer.request({ op: "describe", ...target });
	if (afterDetach.op !== "describe" || afterDetach.daemon.pid !== pid || afterDetach.daemon.state !== "ready")
		throw new Error("Detach terminated or replaced the PTY process");
	process.kill(pid, 0);
	second.close();

	const reconnected = await createDaemonBrokerClient(project, { runtimeDir });
	clients.push(reconnected);
	const fresh = await reconnected.request({ op: "terminal_attach", ...target, columns: 111, rows: 37 });
	if (fresh.op !== "terminal_attach") throw new Error("Unexpected reconnect reply");
	if (fresh.cursor < detachedCursor) throw new Error("Reconnect replayed an old screen cursor");
	const freshScreen = await readUntil(reconnected, fresh.terminalLeaseId, fresh.cursor, "SCREEN:", "reconnect");
	if (freshScreen.text.includes("before-detach") || freshScreen.text.includes("intruder"))
		throw new Error("Reconnect replayed stale output");
	const observerScreen = await readUntil(observer, undefined, fresh.cursor, "SCREEN:", "reconnect");
	await reconnected.request({
		op: "send",
		...target,
		terminalLeaseId: fresh.terminalLeaseId,
		data: "emit:after-reconnect\n",
		enter: false,
	});
	const confirmed = await readUntil(reconnected, fresh.terminalLeaseId, freshScreen.cursor, "EVENT:after-reconnect");
	reconnected.close();
	const afterDisconnect = await observer.request({ op: "describe", ...target });
	if (
		afterDisconnect.op !== "describe" ||
		afterDisconnect.daemon.pid !== pid ||
		afterDisconnect.daemon.state !== "ready"
	)
		throw new Error("Socket disconnect terminated the PTY");
	await reject(
		observer,
		{ op: "terminal_resize", ...target, terminalLeaseId: fresh.terminalLeaseId, columns: 1, rows: 1 },
		"disconnected-resize",
	);
	const history = await observer.request({ op: "read", ...target, cursor: 0, maxBytes: 64 * 1024, timeoutMs: 0 });
	if (history.op !== "read") throw new Error("Unexpected observer history response");
	process.stdout.write(
		JSON.stringify({
			refused,
			pendingRejection,
			firstSize: firstSize.text,
			resized: resized.text,
			freshScreen: freshScreen.text,
			observerScreen: observerScreen.text,
			confirmed: confirmed.text,
			freshCursor: fresh.cursor,
			detachedCursor,
			effectiveSizes,
			unintendedInput: history.text.includes("EVENT:intruder"),
			samePidAfterDetach: afterDetach.daemon.pid === pid,
			samePidAfterDisconnect: afterDisconnect.daemon.pid === pid,
		}),
	);
} finally {
	readiness.abort();
	if (first) await first.request({ op: "shutdown" }).catch(() => undefined);
	for (const client of clients) client.close();
	await broker;
}
