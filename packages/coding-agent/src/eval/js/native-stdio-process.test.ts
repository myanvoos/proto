import { expect, test } from "bun:test";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../../subprocess/worker-client";
import { decodeJsKernelFrame, encodeJsKernelFrame } from "./stdio-protocol";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol";

test("remote stdio supervisor forwards native bytes through an isolated interpreter and closes cleanly", async () => {
	using directory = TempDir.createSync("@js-stdio-native-");
	const command = resolveWorkerSpawnCmd("__proto_worker_js_eval_process");
	const proc = Bun.spawn([...command.cmd, "--stdio"], {
		cwd: directory.path(),
		env: workerEnvFromParent(),
		detached: true,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const ready = Promise.withResolvers<void>();
	const result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
	const closed = Promise.withResolvers<void>();
	const stdout: Buffer[] = [];
	const stderr = new Response(proc.stderr).text();
	const send = (message: WorkerInbound): void => {
		proc.stdin.write(encodeJsKernelFrame(message));
	};
	const messages = (async () => {
		for await (const line of readLines(proc.stdout)) {
			const message = decodeJsKernelFrame(line) as WorkerOutbound;
			if (message.type === "ready") ready.resolve();
			if (message.type === "init-failed") ready.reject(new Error(message.error.message));
			if (message.type === "text" || message.type === "bytes") {
				if ((message.stream ?? "stdout") === "stdout")
					stdout.push(message.type === "text" ? Buffer.from(message.chunk) : Buffer.from(message.data, "base64"));
				if (message.id) send({ type: "output-ack", id: message.id });
			}
			if (message.type === "result") result.resolve(message);
			if (message.type === "closed") closed.resolve();
		}
	})();
	try {
		const snapshot = { cwd: directory.path(), sessionId: "native-stdio-test" };
		send({ type: "init", snapshot });
		await ready.promise;
		const code = `process.stdout.write(Buffer.from([0,255])); console.log({native: "remote"}); require("node:child_process").spawn(process.execPath, ["-e", "console.log('descendant')"], {stdio: "inherit"});`;
		const native = Bun.spawn([process.execPath, "-e", code], {
			cwd: directory.path(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const expected = new Uint8Array(await new Response(native.stdout).arrayBuffer());
		expect(await native.exited).toBe(0);
		send({
			type: "run",
			runId: "remote-cell",
			code,
			filename: "remote-cell.js",
			invocation: { argv: [Bun.which("bun")!] },
			snapshot,
		});
		expect(await result.promise).toMatchObject({ ok: true });
		expect(Buffer.concat(stdout)).toEqual(Buffer.from(expected));
		send({ type: "close" });
		await closed.promise;
		expect(await proc.exited).toBe(0);
		await messages;
		expect(await stderr).toBe("");
	} finally {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {}
		await proc.exited;
	}
}, 20_000);
