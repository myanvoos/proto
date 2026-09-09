import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const HISTORY_STORAGE_MODULE = path.resolve(import.meta.dir, "history-storage.ts");
const AGENT_STORAGE_MODULE = path.resolve(import.meta.dir, "agent-storage.ts");
const tempDirs = new Set<string>();

type ScriptResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

type HistoryRow = {
	prompt: string;
	cwd: string | null;
	session_id: string | null;
};

type ModelPerfRow = {
	samples: number;
	output_tokens: number;
	gen_ms: number;
};

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.add(dir);
	return dir;
}

async function runScript(source: string): Promise<ScriptResult> {
	const child = Bun.spawn([process.execPath, "--eval", source], {
		cwd: REPO_ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function copyMainDatabase(dbPath: string): Promise<string> {
	const copyPath = `${dbPath}.main-copy`;
	await Bun.write(copyPath, Bun.file(dbPath));
	return copyPath;
}

function readHistoryRow(dbPath: string): HistoryRow | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.query<HistoryRow, []>("SELECT prompt, cwd, session_id FROM history ORDER BY id DESC LIMIT 1").get();
	} finally {
		db.close();
	}
}

function readModelPerfRow(dbPath: string, modelKey: string): ModelPerfRow | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.query<ModelPerfRow, [string]>("SELECT samples, output_tokens, gen_ms FROM model_perf WHERE model_key = ?")
			.get(modelKey);
	} finally {
		db.close();
	}
}

afterEach(async () => {
	const dirs = [...tempDirs];
	tempDirs.clear();
	await Promise.all(dirs.map(dir => removeWithRetries(dir)));
});

describe("storage durability", () => {
	test("a submitted prompt survives an abrupt exit without graceful cleanup", async () => {
		const dir = await makeTempDir("proto-history-abrupt-");
		const historyDbPath = path.join(dir, "history.db");
		const result = await runScript(
			[
				`import { HistoryStorage } from ${JSON.stringify(HISTORY_STORAGE_MODULE)};`,
				`const history = HistoryStorage.open(${JSON.stringify(historyDbPath)});`,
				'void history.add("durable prompt", "/tmp/project", "session-abrupt");',
				"process.reallyExit(0);",
			].join("\n"),
		);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(readHistoryRow(historyDbPath)).toEqual({
			prompt: "durable prompt",
			cwd: "/tmp/project",
			session_id: "session-abrupt",
		});
	});

	test("explicit close flushes pending writes and leaves standalone database files", async () => {
		const dir = await makeTempDir("proto-storage-close-");
		const historyDbPath = path.join(dir, "history.db");
		const agentDbPath = path.join(dir, "agent.db");
		const result = await runScript(
			[
				`import { HistoryStorage } from ${JSON.stringify(HISTORY_STORAGE_MODULE)};`,
				`import { AgentStorage } from ${JSON.stringify(AGENT_STORAGE_MODULE)};`,
				`const history = HistoryStorage.open(${JSON.stringify(historyDbPath)});`,
				`const agent = await AgentStorage.open(${JSON.stringify(agentDbPath)});`,
				'const promptWrite = history.add("closed prompt", "/tmp/project", "session-close");',
				'const perfWrite = agent.recordModelPerf("openai/close", { outputTokens: 12, durationMs: 600 });',
				"HistoryStorage.close();",
				"AgentStorage.close();",
				"await Promise.all([promptWrite, perfWrite]);",
				"process.reallyExit(0);",
			].join("\n"),
		);

		expect(result.exitCode, result.stderr).toBe(0);
		const [historyCopy, agentCopy] = await Promise.all([
			copyMainDatabase(historyDbPath),
			copyMainDatabase(agentDbPath),
		]);
		expect(readHistoryRow(historyCopy)?.prompt).toBe("closed prompt");
		expect(readModelPerfRow(agentCopy, "openai/close")).toEqual({
			samples: 1,
			output_tokens: 12,
			gen_ms: 600,
		});
	});

	test("process exit flushes deferred writes and checkpoints both databases", async () => {
		const dir = await makeTempDir("proto-storage-exit-");
		const historyDbPath = path.join(dir, "history.db");
		const agentDbPath = path.join(dir, "agent.db");
		const result = await runScript(
			[
				`import { HistoryStorage } from ${JSON.stringify(HISTORY_STORAGE_MODULE)};`,
				`import { AgentStorage } from ${JSON.stringify(AGENT_STORAGE_MODULE)};`,
				`const history = HistoryStorage.open(${JSON.stringify(historyDbPath)});`,
				`const agent = await AgentStorage.open(${JSON.stringify(agentDbPath)});`,
				'void history.add("exit prompt", "/tmp/project", "session-exit");',
				'void agent.recordModelPerf("openai/exit", { outputTokens: 10, durationMs: 1000 });',
				"process.exit(0);",
			].join("\n"),
		);

		expect(result.exitCode, result.stderr).toBe(0);
		const [historyCopy, agentCopy] = await Promise.all([
			copyMainDatabase(historyDbPath),
			copyMainDatabase(agentDbPath),
		]);
		expect(readHistoryRow(historyCopy)?.prompt).toBe("exit prompt");
		expect(readModelPerfRow(agentCopy, "openai/exit")).toEqual({
			samples: 1,
			output_tokens: 10,
			gen_ms: 1000,
		});
	});

	test("exit cleanup re-arms for a store opened after manual cleanup", async () => {
		const dir = await makeTempDir("proto-storage-rearm-");
		const agentDbPath = path.join(dir, "agent.db");
		const result = await runScript(
			[
				'import { postmortem } from "@oh-my-pi/pi-utils";',
				`import { AgentStorage } from ${JSON.stringify(AGENT_STORAGE_MODULE)};`,
				"await postmortem.cleanup();",
				`const agent = await AgentStorage.open(${JSON.stringify(agentDbPath)});`,
				'void agent.recordModelPerf("openai/rearm", { outputTokens: 20, durationMs: 2000 });',
				"process.exit(0);",
			].join("\n"),
		);

		expect(result.exitCode, result.stderr).toBe(0);
		const agentCopy = await copyMainDatabase(agentDbPath);
		expect(readModelPerfRow(agentCopy, "openai/rearm")).toEqual({
			samples: 1,
			output_tokens: 20,
			gen_ms: 2000,
		});
	});
});
