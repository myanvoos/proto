import { test } from "bun:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";
import { z } from "zod";
import { decodeJsKernelFrame, encodeJsKernelFrame } from "../eval/js/stdio-protocol";

const frameSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("ready") }),
	z.object({
		type: z.literal("bytes"),
		runId: z.string(),
		stream: z.enum(["stdout", "stderr"]),
		id: z.string(),
		data: z.string(),
	}),
	z.object({
		type: z.literal("text"),
		runId: z.string(),
		stream: z.enum(["stdout", "stderr"]).optional(),
		id: z.string().optional(),
		chunk: z.string(),
	}),
	z.object({ type: z.literal("display"), output: z.unknown() }),
	z.object({ type: z.literal("result"), runId: z.string(), ok: z.boolean(), error: z.unknown().optional() }),
	z.object({ type: z.literal("stdin-request"), runId: z.string() }),
	z.object({ type: z.literal("closed") }),
	z.object({ type: z.literal("init-failed"), error: z.unknown() }),
	z.object({ type: z.literal("log"), level: z.string(), msg: z.string() }),
]);
const expectedDisplay = z.object({ type: z.literal("json"), data: z.object({ compiledAnswer: z.literal(42) }) });
// Explicit opt-in prevents a stale local dist binary from contaminating normal source tests.
const executable = process.env.PROTO_COMPILED_KERNEL_TEST_BIN;
test.skipIf(!executable)(
	"compiled kernel preserves native self-spawn, streams, callbacks and retained state",
	async () => {
		assert.ok(executable);
		using dir = TempDir.createSync("@compiled-kernel-native-");
		const cwd = dir.path();
		await fs.mkdir(path.join(cwd, "data", "proto"), { recursive: true });
		const proc = Bun.spawn([executable, "__proto_worker_js_eval_process", "--stdio"], {
			cwd,
			detached: true,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: cwd, XDG_DATA_HOME: path.join(cwd, "data") },
		});
		const stderr = new Response(proc.stderr).text();
		const timer = setTimeout(() => {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {}
		}, 30_000);
		const send = (message: unknown) => {
			proc.stdin.write(encodeJsKernelFrame(message));
		};
		const snapshot = { cwd, sessionId: "compiled-smoke" };
		const bytes = new Map<string, Buffer[]>();
		const displays: unknown[] = [];
		const results: unknown[] = [];
		const realBun = Bun.which("bun")!;
		const code = `const compiledAnswer = 42;
console.log("compiled", compiledAnswer);
process.stdout.write(Buffer.from([0,255,65]));
setImmediate(() => console.error("callback"));
const child = require("node:child_process").spawnSync(process.execPath, ["-e", "console.log('native child')"], { encoding: "utf8" });
if (child.status !== 0) throw new Error("self-spawn failed: " + child.stderr);
console.log(child.stdout.trim());
display({compiledAnswer});`;
		send({ type: "init", snapshot });
		let closed = false;
		try {
			for await (const line of readLines(proc.stdout)) {
				const message = frameSchema.parse(decodeJsKernelFrame(line));
				if (message.type === "ready") {
					send({
						type: "run",
						runId: "first",
						code,
						filename: "[eval]",
						invocation: { argv: [realBun] },
						snapshot,
					});
				} else if (message.type === "bytes" || message.type === "text") {
					const key = `${message.runId}:${message.stream ?? "stdout"}`;
					const list = bytes.get(key) ?? [];
					list.push(message.type === "bytes" ? Buffer.from(message.data, "base64") : Buffer.from(message.chunk));
					bytes.set(key, list);
					if (message.id) send({ type: "output-ack", id: message.id });
				} else if (message.type === "display") {
					displays.push(message.output);
				} else if (message.type === "stdin-request") {
					send({ type: "stdin", runId: message.runId, data: "", eof: true });
				} else if (message.type === "result") {
					results.push(message);
					assert.equal(message.ok, true, JSON.stringify(message));
					if (message.runId === "first") {
						send({
							type: "run",
							runId: "second",
							code: 'console.log("retained", compiledAnswer)',
							filename: "[eval]",
							invocation: { argv: [realBun] },
							snapshot,
						});
					} else {
						send({ type: "close" });
					}
				} else if (message.type === "closed") closed = true;
				else if (message.type === "init-failed") throw new Error(JSON.stringify(message));
			}
			assert.equal(await proc.exited, 0, await stderr);
			assert.equal(closed, true);
			assert.equal(results.length, 2);
			assert.deepEqual(
				Buffer.concat(bytes.get("first:stdout") ?? []),
				Buffer.concat([Buffer.from("compiled 42\n"), Buffer.from([0, 255, 65]), Buffer.from("native child\n")]),
			);
			assert.equal(Buffer.concat(bytes.get("first:stderr") ?? []).toString(), "callback\n");
			assert.equal(Buffer.concat(bytes.get("second:stdout") ?? []).toString(), "retained 42\n");
			assert.ok(displays.some(value => expectedDisplay.safeParse(value).success));
		} finally {
			clearTimeout(timer);
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {}
			await proc.exited;
		}
	},
	45_000,
);
