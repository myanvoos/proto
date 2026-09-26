import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async";
import { Settings } from "../config/settings";
import { disposeEvalArtifacts } from "../eval/artifact-values";
import { disposeSessionExecutionEvents } from "../eval/execution-events";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { disposeBashSessions } from "../exec/bash-executor";
import { ArtifactManager } from "../session/artifacts";
import { createTools, type Tool, type ToolSession } from ".";

// `node` cells must run on the real Node.js the shell would run, in a kernel of their own; these
// drive the real Brush shell and real kernels end to end, like every other bash-kernel test.
const NODE = $which("node");

interface Harness {
	cwd: string;
	run(command: string, options?: { lane?: string; env?: Record<string, string> }): Promise<Cell>;
	context: Tool;
}

interface Cell {
	isError: boolean;
	exitCode: number | undefined;
	output: string;
}

async function fixture(run: (harness: Harness) => Promise<void>): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-node-"));
	const owner = `kernel-node:${crypto.randomUUID()}`;
	const artifacts = new ArtifactManager(path.join(cwd, "artifacts"));
	const jobs = new AsyncJobManager({});
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": true,
			"bash.autoBackground.enabled": false,
			"tools.xdev": false,
			"bash.direnv": "off",
		}),
		getSessionId: () => owner,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactsDir: () => artifacts.dir,
		getArtifactManager: () => artifacts,
		allocateOutputArtifact: kind => artifacts.allocatePath(kind),
		asyncJobManager: jobs,
	};
	try {
		await createTools(session, ["bash", "context", "read"]);
		const tools = session.toolRegistry!;
		session.getToolByName = name => tools.get(name);
		session.getToolForEvalBridge = name => tools.get(name);
		session.getEvalBridgeToolNames = () => [...tools.keys()];
		const bash = tools.get("bash")!;
		await run({
			cwd,
			context: tools.get("context")!,
			async run(command, options) {
				const result = await bash.execute("node-cell", { command, timeout: 60, ...options });
				return {
					isError: result.isError === true,
					exitCode: (result.details as { exitCode?: number } | undefined)?.exitCode,
					output: result.content
						.filter(block => block.type === "text")
						.map(block => (block.type === "text" ? block.text : ""))
						.join("\n"),
				};
			},
		});
	} finally {
		await disposeSessionExecutionEvents(session);
		await jobs.dispose();
		await Promise.all([
			disposeBashSessions(owner),
			disposeKernelSessionsByOwner(owner),
			disposeVmContextsByOwner(owner),
		]);
		disposeEvalArtifacts(session);
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

function cell(interpreter: string, source: string): string {
	return `${interpreter} <<'__NODE_CELL__'\n${source}\n__NODE_CELL__`;
}

describe.skipIf(!NODE)("node bash cells", () => {
	test("run on the real Node.js from PATH, keep top-level state, and stay separate from bun cells", async () => {
		await fixture(async ({ run }) => {
			const identity = await run(
				cell(
					"node",
					"console.log(JSON.stringify({ bun: typeof Bun, release: process.release.name, execPath: process.execPath }));\nvar seenVar = 1;\nlet seenLet = 2;\nconst seenConst = 3;\nfunction seenFunction() { return seenVar + seenLet + seenConst; }",
				),
			);
			expect(identity.isError).toBe(false);
			const reported = JSON.parse(/\{.*\}/.exec(identity.output)![0]) as Record<string, string>;
			expect(reported.bun).toBe("undefined");
			expect(reported.release).toBe("node");
			expect(await fs.realpath(reported.execPath)).toBe(await fs.realpath(NODE!));

			const persisted = await run(
				"node -e 'console.log(\"persisted\", seenFunction(), seenVar, seenLet, seenConst)'",
			);
			expect(persisted.isError).toBe(false);
			expect(persisted.output).toContain("persisted 6 1 2 3");

			const bun = await run(
				"bun -e 'console.log(\"bun-cell\", typeof Bun, typeof process.versions.bun, typeof seenFunction, typeof seenLet)'",
			);
			expect(bun.isError).toBe(false);
			expect(bun.output).toContain("bun-cell object string undefined undefined");

			const afterBun = await run("node -e 'console.log(\"still\", seenFunction(), typeof Bun)'");
			expect(afterBun.output).toContain("still 6 undefined");
		});
	}, 60_000);

	test("call session tools and round-trip artifacts through the host", async () => {
		await fixture(async ({ run, cwd }) => {
			await Bun.write(path.join(cwd, "input.txt"), "alpha-line\nbeta-line\n");
			const result = await run(
				cell(
					"node",
					[
						'const page = await tool.read({ path: "input.txt" });',
						'console.log("read-has-beta", JSON.stringify(page).includes("beta-line"));',
						'const ref = await publishArtifact("héllo artifact", { kind: "text" });',
						"const back = await readArtifact(ref);",
						'console.log("artifact", JSON.stringify({ data: back.data, encoding: back.encoding, eof: back.eof }));',
					].join("\n"),
				),
			);
			expect(result.isError).toBe(false);
			expect(result.output).toContain("read-has-beta true");
			expect(result.output).toContain('artifact {"data":"héllo artifact","encoding":"utf8","eof":true}');
		});
	}, 60_000);

	test("report tracked writes, read piped stdin, and display the final expression", async () => {
		await fixture(async ({ run, cwd }) => {
			const write = await run(
				'node -e \'require("node:fs").writeFileSync("made-by-node.txt", "node wrote this\\n")\'',
			);
			expect(write.isError).toBe(false);
			expect(write.output).toMatch(/^<kernel> note: created .*made-by-node\.txt/m);
			expect(await Bun.file(path.join(cwd, "made-by-node.txt")).text()).toBe("node wrote this\n");

			const piped = await run(
				'printf "piped-bytes" | node -e \'let input = ""; for await (const chunk of process.stdin) input += chunk; console.log("stdin=" + input.toUpperCase())\'',
			);
			expect(piped.isError).toBe(false);
			expect(piped.output).toContain("stdin=PIPED-BYTES");

			const display = await run("node -e 'const base = 20; base * 2 + 2'");
			expect(display.isError).toBe(false);
			expect(display.output.split("\n")[0]).toBe("42");
		});
	}, 60_000);

	for (const interpreter of ["node", "bun"]) {
		test(`${interpreter} shares piped binary stdin across descriptor reads, streams, and inherited children`, async () => {
			await fixture(async ({ run, cwd }) => {
				const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
				await Bun.write(path.join(cwd, "stdin.bin"), bytes);
				const source = [
					'const fs = require("node:fs");',
					"const prefix = Buffer.alloc(16);",
					'console.log("prefix", fs.readSync(0, prefix, 0, prefix.length, null), prefix.toString("hex"));',
					'console.log("rest", fs.readFileSync(0).toString("hex"));',
				].join(" ");
				const descriptor = await run(`cat stdin.bin | ${interpreter} -e '${source}'`);
				expect(descriptor.isError, descriptor.output).toBe(false);
				expect(descriptor.output).toContain(`prefix 16 ${bytes.subarray(0, 16).toString("hex")}`);
				expect(descriptor.output).toContain(`rest ${bytes.subarray(16).toString("hex")}`);

				const mixed = await run(
					`cat stdin.bin | ${interpreter} -e 'const fs = require("node:fs"); const prefix = Buffer.alloc(16); fs.readSync(0, prefix); const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); console.log(Buffer.concat([prefix, ...chunks]).toString("hex"));'`,
				);
				expect(mixed.isError).toBe(false);
				expect(mixed.output).toContain(bytes.toString("hex"));

				const inherited = await run(
					`cat stdin.bin | ${interpreter} -e 'const child = require("node:child_process").spawnSync(process.execPath, ["-e", "process.stdout.write(require(\\"node:fs\\").readFileSync(0))"], {stdio:["inherit","pipe","pipe"]}); if (child.status !== 0) throw new Error(child.stderr.toString()); console.log(child.stdout.toString("hex"));'`,
				);
				expect(inherited.isError).toBe(false);
				expect(inherited.output).toContain(bytes.toString("hex"));

				const empty = await run(
					`${interpreter} -e 'console.log("empty", require("node:fs").readFileSync(0).length)'`,
				);
				expect(empty.isError).toBe(false);
				expect(empty.output).toContain("empty 0");
			});
		}, 60_000);
		test(`${interpreter} streams stdin larger than transport buffers and isolates early-exit input`, async () => {
			await fixture(async ({ run, cwd }) => {
				const bytes = Buffer.alloc(1024 * 1024, 0xa5);
				await Bun.write(path.join(cwd, "large.bin"), bytes);
				const result = await run(
					`cat large.bin | ${interpreter} -e 'const input = require("node:fs").readFileSync(0); console.log(input.length, input.every(byte => byte === 165));'`,
				);
				expect(result.isError, result.output).toBe(false);
				expect(result.output).toContain("1048576 true");
				const early = await run(
					`cat large.bin | ${interpreter} -e 'const byte = Buffer.alloc(1); require("node:fs").readSync(0, byte); console.log("first", byte[0]);'`,
				);
				expect(early.isError, early.output).toBe(false);
				expect(early.output).toContain("first 165");
				const next = await run(
					`printf next-cell | ${interpreter} -e 'console.log(require("node:fs").readFileSync(0, "utf8"));'`,
				);
				expect(next.isError, next.output).toBe(false);
				expect(next.output.split("\n")[0]).toBe("next-cell");
			});
		}, 60_000);
	}

	test("hand host validators the same values bun cells do", async () => {
		await fixture(async ({ run }) => {
			// Node crosses a JSON IPC channel, Bun a structured-clone one; lossy or unclonable values must
			// reach the host (and fail) the same way instead of being flattened into valid-looking JSON.
			const source = [
				"const report = async (label, work) => console.log(label, await work.then(() => 'accepted', error => error.name + ': ' + error.message));",
				"const cyclic = { a: 1 }; cyclic.self = cyclic;",
				"await report('cyclic', publishArtifact(cyclic));",
				"await report('lossy', publishArtifact([1, undefined, NaN]));",
				"await report('map', publishArtifact({ m: new Map([[1, 2]]) }));",
				"await report('function', tool.read({ path: 'missing.txt', callback: () => 1 }));",
				"const shaped = await readArtifact(await publishArtifact({ '\\u0000proto': 'bigint', value: '5' }), { encoding: 'json' });",
				"console.log('shaped', typeof shaped.data, JSON.stringify(shaped.data));",
			].join("\n");
			const node = await run(cell("node", source));
			const bun = await run(cell("bun", source));
			expect(node.isError).toBe(false);
			expect(bun.isError).toBe(false);
			// DataCloneError wording is runtime-specific; the error class is the contract.
			const lines = (output: string) =>
				output
					.split("\n")
					.filter(line => /^(cyclic|lossy|map|function|shaped) /.test(line))
					.map(line => line.replace(/DataCloneError: .*/, "DataCloneError"));
			expect(lines(node.output)).toEqual(lines(bun.output));
			expect(lines(node.output)).toHaveLength(5);
			expect(node.output).toContain("cyclic Error: Artifact value must be acyclic JSON");
			expect(node.output).toMatch(/^function DataCloneError: /m);
			expect(node.output).toContain('shaped object {"\\u0000proto":"bigint","value":"5"}');
		});
	}, 60_000);

	test("name the same kernel function in helper error stacks as bun cells", async () => {
		await fixture(async ({ run }) => {
			const source = "await saveState('state.json', [])";
			const topFrame = (output: string) => /^\s+at (\S+) \(/m.exec(output)?.[1];
			const node = await run(`node -e "${source}"`);
			const bun = await run(`bun -e "${source}"`);
			expect(node.isError).toBe(true);
			expect(topFrame(bun.output)).toBeString();
			expect(topFrame(node.output)).toBe(topFrame(bun.output));
		});
	}, 60_000);

	test("strip TypeScript annotations in node cells", async () => {
		await fixture(async ({ run }) => {
			const result = await run(
				cell(
					"node",
					'interface Point { x: number; y: number }\nconst point: Point = { x: 3, y: 4 };\nfunction norm(p: Point): number { return Math.hypot(p.x, p.y); }\nconsole.log("norm=" + norm(point));',
				),
			);
			expect(result.isError).toBe(false);
			expect(result.output).toContain("norm=5");
		});
	}, 60_000);

	test("announce lost state once after the lane's kernel is reset", async () => {
		await fixture(async ({ run, context }) => {
			const seeded = await run("node -e 'var resetMarker = 7; console.log(\"seeded\", resetMarker)'", {
				lane: "resettable",
			});
			expect(seeded.output).toContain("seeded 7");
			expect(seeded.output).not.toContain("<kernel> state lost:");

			const reset = await context.execute("reset-node", {
				resource: "kernel",
				op: "reset",
				language: "node",
				lane: "resettable",
			});
			expect(reset.isError).not.toBe(true);

			const inspect = "node -e 'console.log(\"marker=\" + typeof resetMarker)'";
			const after = await run(inspect, { lane: "resettable" });
			expect(after.isError).toBe(false);
			expect(after.output).toContain("marker=undefined");
			expect(after.output.match(/<kernel> state lost: node:resettable restarted;/g)).toHaveLength(1);

			const healthy = await run(inspect, { lane: "resettable" });
			expect(healthy.output).toContain("marker=undefined");
			expect(healthy.output).not.toContain("<kernel> state lost:");
		});
	}, 60_000);
});

test("node cells fall through to command-not-found when neither node nor nodejs is on the cell PATH", async () => {
	await fixture(async ({ run, cwd }) => {
		const empty = path.join(cwd, "empty-bin");
		await fs.mkdir(empty);
		const result = await run(`PATH=${empty} node -e 'console.log("must not run")'`);
		expect(result.output).toContain("node: command not found (no node or nodejs on PATH)");
		expect(result.output).not.toContain("must not run");
		expect(result.exitCode).toBe(127);
	});
}, 60_000);
