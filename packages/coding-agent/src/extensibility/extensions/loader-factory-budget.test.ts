import { afterAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadExtensions } from "./loader";

// A factory that never settles kept no handle alive, so the process drained its event loop and exited
// 0 having done nothing. These tests drive the real loader against real extension modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-ext-budget-"));

const hangPath = path.join(root, "hang.ts");
await fs.writeFile(
	hangPath,
	[
		"export default async function hang() {",
		"\tconst { promise } = Promise.withResolvers<void>();",
		"\tawait promise;",
		"}",
		"",
	].join("\n"),
);

const slowPath = path.join(root, "slow.ts");
await fs.writeFile(
	slowPath,
	[
		"export default async function slow() {",
		// Integration test of the loader's own timing budget: there is nothing to fake here, the
		// behaviour under test is how long a real factory is allowed to take.
		"\tawait Bun.sleep(260);",
		"}",
		"",
	].join("\n"),
);

const fastPath = path.join(root, "fast.ts");
await fs.writeFile(fastPath, ["export default function fast() {}", ""].join("\n"));

const previousTimeout = process.env.PI_EXTENSION_LOAD_TIMEOUT_MS;

beforeEach(() => {
	delete process.env.PI_EXTENSION_LOAD_TIMEOUT_MS;
});

afterAll(async () => {
	if (previousTimeout === undefined) delete process.env.PI_EXTENSION_LOAD_TIMEOUT_MS;
	else process.env.PI_EXTENSION_LOAD_TIMEOUT_MS = previousTimeout;
	await fs.rm(root, { recursive: true, force: true });
});

test("a factory that never settles is given up on instead of stalling the process", async () => {
	process.env.PI_EXTENSION_LOAD_TIMEOUT_MS = "300";
	const started = Date.now();
	const result = await loadExtensions([hangPath], root);
	const elapsed = Date.now() - started;

	expect(result.extensions).toHaveLength(0);
	expect(result.errors).toHaveLength(1);
	expect(result.errors[0]?.path).toBe(hangPath);
	expect(result.errors[0]?.error).toContain("did not finish within 300ms");
	// Bounded: without the budget this await never returns at all.
	expect(elapsed).toBeLessThan(30_000);
});

test("one stalled extension does not prevent the others from loading", async () => {
	process.env.PI_EXTENSION_LOAD_TIMEOUT_MS = "300";
	const result = await loadExtensions([hangPath, fastPath], root);

	expect(result.errors.map(item => item.path)).toEqual([hangPath]);
	expect(result.extensions.map(extension => extension.path)).toEqual([fastPath]);
});

test("a factory that loads but costs a large share of the budget is reported", async () => {
	process.env.PI_EXTENSION_LOAD_TIMEOUT_MS = "400";
	const result = await loadExtensions([slowPath], root);

	expect(result.errors).toHaveLength(0);
	expect(result.extensions).toHaveLength(1);
	expect(result.warnings).toHaveLength(1);
	expect(result.warnings[0]?.path).toBe(slowPath);
	expect(result.warnings[0]?.warning).toContain("delayed startup");
});

test("a fast factory produces neither an error nor a warning", async () => {
	const result = await loadExtensions([fastPath], root);

	expect(result.errors).toEqual([]);
	expect(result.warnings).toEqual([]);
	expect(result.extensions).toHaveLength(1);
});

// End to end: the reported symptom was a `proto -p` run that exited 0 with empty stdout, empty stderr
// and zero provider requests, because the never-settling await let the event loop drain.
test("a stalled extension no longer turns a real run into a silent exit", async () => {
	const requests: string[] = [];
	const modelServer = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async request => {
			requests.push(await request.text());
			return new Response(
				`data: ${JSON.stringify({ choices: [{ delta: { content: "RAN-ANYWAY" } }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const home = path.join(root, "e2e-home");
	const agentDir = path.join(root, "e2e-profile");
	const cwd = path.join(root, "e2e-work");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  w8local:",
			`    baseUrl: http://127.0.0.1:${modelServer.port}/v1`,
			"    apiKey: test-key",
			"    api: openai-completions",
			"    models:",
			"      - id: local-stream",
			'        name: "local-stream"',
			"        contextWindow: 16384",
			"        maxTokens: 1024",
			"",
		].join("\n"),
	);

	try {
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				path.resolve(import.meta.dir, "..", "..", "cli.ts"),
				"--cwd",
				cwd,
				"--no-title",
				"--no-skills",
				"--no-rules",
				"--model",
				"w8local/local-stream",
				"-e",
				hangPath,
				"-p",
				"hello",
			],
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				XDG_CACHE_HOME: path.join(home, ".cache"),
				XDG_DATA_HOME: path.join(home, ".local", "share"),
				XDG_STATE_HOME: path.join(home, ".local", "state"),
				PI_CODING_AGENT_DIR: agentDir,
				PI_EXTENSION_LOAD_TIMEOUT_MS: "1500",
				TERM: "dumb",
				NO_COLOR: "1",
				NO_PROXY: "127.0.0.1,localhost",
			},
		});
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		await child.exited;

		expect(stdout).toContain("RAN-ANYWAY");
		expect(requests.length).toBeGreaterThan(0);
		expect(stderr).toContain("Failed to load extension");
		expect(stderr).toContain("did not finish within 1500ms");
	} finally {
		modelServer.stop(true);
	}
}, 120_000);
