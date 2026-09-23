import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient } from "./client";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "proto-broker-terminal-query-"));
const project = path.join(tmp, "project");
await fs.mkdir(project);
const client = await createDaemonBrokerClient(project, { runtimeDir: path.join(tmp, "run") });

// Nothing plays terminal for a supervised PTY: a program that probes the cursor position would block until its own
// timeout unless the broker answers the query.
test.skipIf(process.platform === "win32")(
	"a supervised PTY gets an answer to a cursor position query",
	async () => {
		const scriptPath = path.join(project, "terminal-query.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", chunk => {
	input += chunk;
	const match = /\\x1b\\[(\\d+);(\\d+)R/.exec(input);
	if (!match) return;
	process.stdout.write("CPR:" + match[1] + ":" + match[2] + "\\n");
	process.exit(0);
});
process.stdout.write("READY\\x1b[6n");
`,
		);
		await client.request({
			op: "start",
			spec: {
				name: "terminal-query",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: project,
				pty: true,
				restart: "no",
				persist: false,
				detached: false,
			},
		});

		const completed = await client.request({ op: "wait", name: "terminal-query", for: "exit", timeoutMs: 5_000 });
		if (completed.op !== "wait") throw new Error("unexpected wait result");
		expect(completed.timedOut).toBe(false);
		expect(completed.daemon.exitCode).toBe(0);

		const logs = await client.request({
			op: "logs",
			name: "terminal-query",
			lines: 20,
			head: false,
			follow: false,
			timeoutMs: 1_000,
		});
		if (logs.op !== "logs") throw new Error("unexpected logs result");
		expect(logs.text).toContain("CPR:1:1");
		expect(logs.text).not.toContain("\x1b[1;1R");
	},
	60_000,
);

afterAll(async () => {
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
	await fs.rm(tmp, { recursive: true, force: true });
});
