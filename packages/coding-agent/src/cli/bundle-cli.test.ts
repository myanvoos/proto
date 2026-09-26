import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse } from "@babel/parser";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { bundleCodingAgent } from "../../scripts/bundle-dist";
import { decodeNodeKernelMessage, encodeNodeKernelMessage } from "../eval/js/node-protocol";
import type { WorkerInbound, WorkerOutbound } from "../eval/js/worker-protocol";

test("split CLI bundle executes commands and worker selectors through a symlink but stays inert when imported", async () => {
	using tmp = TempDir.createSync("@bundle-cli-");
	await fs.symlink(path.resolve(import.meta.dir, "../../../../node_modules"), tmp.join("node_modules"), "dir");
	const cli = await bundleCodingAgent(tmp.path());
	const alias = tmp.join("proto");
	await fs.symlink(cli, alias);
	const profile = tmp.join("profile");
	const env = { ...process.env, HOME: tmp.path(), PI_CODING_AGENT_DIR: profile, TERM: "dumb", NO_COLOR: "1" };
	const run = async (entry: string, args: string[]) => {
		const child = Bun.spawn([process.execPath, entry, ...args], {
			cwd: tmp.path(),
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	};
	const version = await run(alias, ["--version"]);
	expect(version.exitCode).toBe(0);
	expect(version.stdout.trim()).toBe(`proto/${VERSION}`);
	const worker = await run(cli, ["__proto_worker_missing_test"]);
	expect(worker.exitCode).toBe(1);
	expect(worker.stderr).toContain("unknown worker selector");
	const importer = tmp.join("importer.js");
	await Bun.write(importer, 'import "./cli.js";\n');
	const imported = await run(importer, ["__proto_worker_missing_test"]);
	expect(imported).toEqual({ stdout: "", stderr: "", exitCode: 0 });
}, 60_000);

/** Text the Node kernel bundle (node-entry.ts) prints itself, and nothing else in the CLI bundle does. */
const NODE_KERNEL_MARKER = "node kernel requires Node.js";

/** The string literals in the bundle's chunks that hold the embedded Node kernel source. */
async function embeddedNodeKernels(outDir: string): Promise<string[]> {
	const found: string[] = [];
	for (const name of await fs.readdir(outDir)) {
		if (!name.endsWith(".js")) continue;
		const text = await Bun.file(path.join(outDir, name)).text();
		if (!text.includes(NODE_KERNEL_MARKER)) continue;
		for (const token of parse(text, { sourceType: "module", tokens: true }).tokens ?? []) {
			if (token.type.label === "string" && String(token.value).includes(NODE_KERNEL_MARKER)) found.push(token.value);
		}
	}
	return found;
}

test.skipIf(!$which("node"))(
	"npm bundle embeds a Node kernel that runs cells under real Node",
	async () => {
		using tmp = TempDir.createSync("@bundle-node-kernel-");
		const outDir = tmp.join("dist");
		await bundleCodingAgent(outDir);
		const kernels = await embeddedNodeKernels(outDir);
		expect(kernels).toHaveLength(1);
		const entry = tmp.join("node-kernel.mjs");
		await Bun.write(entry, kernels[0]);

		const inbox: WorkerOutbound[] = [];
		let wake: (() => void) | undefined;
		const child = Bun.spawn([$which("node")!, "--experimental-vm-modules", entry], {
			cwd: tmp.path(),
			stdio: ["ignore", "pipe", "pipe"],
			serialization: "json",
			ipc(raw) {
				const message = decodeNodeKernelMessage(raw) as WorkerOutbound;
				if ((message.type === "text" || message.type === "bytes") && message.id)
					send({ type: "output-ack", id: message.id });
				inbox.push(message);
				wake?.();
			},
		});
		const send = (message: WorkerInbound): void => {
			child.send(encodeNodeKernelMessage(message));
		};
		const stderr = new Response(child.stderr).text();
		void child.exited.then(() => wake?.());
		const next = async <T extends WorkerOutbound["type"]>(type: T): Promise<Extract<WorkerOutbound, { type: T }>> => {
			for (;;) {
				const index = inbox.findIndex(message => message.type === type);
				if (index >= 0) return inbox.splice(index, 1)[0] as Extract<WorkerOutbound, { type: T }>;
				if (child.exitCode !== null)
					throw new Error(`node kernel exited ${child.exitCode} before ${type}: ${await stderr}`);
				const { promise, resolve } = Promise.withResolvers<void>();
				wake = resolve;
				await promise;
			}
		};

		try {
			const snapshot = { cwd: tmp.path(), sessionId: "bundle-node-kernel" };
			send({ type: "init", snapshot });
			expect(await next("ready")).toMatchObject({ type: "ready" });
			send({
				type: "run",
				runId: "r1",
				code: "console.log(typeof Bun, process.release.name, 6 * 7)",
				filename: "cell.js",
				snapshot,
			});
			expect(await next("result")).toEqual({ type: "result", runId: "r1", ok: true });
			const stdout = inbox
				.flatMap(message => (message.type === "text" && message.stream !== "stderr" ? [message.chunk] : []))
				.join("");
			expect(stdout).toBe("undefined node 42\n");
			send({ type: "close" });
			expect(await next("closed")).toEqual({ type: "closed" });
		} finally {
			child.kill();
			await child.exited;
		}
	},
	60_000,
);
