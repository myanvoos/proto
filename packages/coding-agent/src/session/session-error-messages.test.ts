import { expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentSession } from "../sdk";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

// Two startup/corruption paths used to answer with something the user cannot act on:
// "Raw session entry file is invalid for undefined", and a bare mkdir errno that also
// lost the turn. Both are driven here through the real SessionManager.
// Larger than the raw-entry cache ceiling, so the entry is spilled to a temp file and never
// held in memory: reading it back has to go through that file.
const UNCACHEABLE = "L".repeat(9 * 1024 * 1024);

async function tempDir(prefix: string): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("an oversized entry whose temporary copy is gone degrades to the truncated copy and says why", async () => {
	const dir = await tempDir("proto-session-errors-");
	try {
		const manager = SessionManager.create(dir, dir);
		const warnings: string[] = [];
		manager.onHistoryDegraded(message => warnings.push(message));
		const id = manager.appendMessage({ role: "user", content: UNCACHEABLE, timestamp: Date.now() });
		await manager.flush();

		// Simulate the temp cleaner that removes the per-process spill directory.
		const spillRoots = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith("proto-session-history-"));
		expect(spillRoots.length).toBeGreaterThan(0);
		for (const root of spillRoots) await fs.rm(path.join(os.tmpdir(), root), { recursive: true, force: true });

		// The entry still resolves, truncated: a lost cache must never fail a session operation.
		const entry = manager.getEntry(id);
		expect(entry).toBeDefined();
		const message: unknown = entry && "message" in entry ? entry.message : undefined;
		const content = message && typeof message === "object" && "content" in message ? message.content : undefined;
		expect(typeof content).toBe("string");
		expect((content as string).length).toBeLessThan(UNCACHEABLE.length);

		// Reading it again is silent: the mapping is forgotten, not retried forever.
		expect(manager.getEntry(id)).toBeDefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).not.toContain("undefined");
		expect(warnings[0]).toContain(id);
		expect(warnings[0]).toContain("The session file was not modified");
		expect(warnings[0]).toContain("truncated form");
		expect(warnings[0]).toContain("proto-session-history-*");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test("an oversized record with no id loads and reads back instead of failing for undefined", async () => {
	const dir = await tempDir("proto-session-errors-");
	try {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		// The file is only created once the history holds an assistant turn.
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-responses",
			provider: "test",
			model: "test",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();

		// A hand-edited session file: valid JSON, too big to keep in the raw-entry cache, and
		// carrying no entry id at all. The spill file is keyed by that id.
		const shapeless = {
			type: "message",
			timestamp: new Date().toISOString(),
			message: { role: "user", content: UNCACHEABLE },
		};
		await fs.appendFile(sessionFile!, `${JSON.stringify(shapeless)}\n`);

		const reopened = await SessionManager.open(sessionFile!, dir);
		const entries = reopened.getEntries();
		const loaded = entries
			.filter(entry => entry.type === "message")
			.find(entry => {
				const message: unknown = entry.message;
				return !!message && typeof message === "object" && "content" in message && message.content === UNCACHEABLE;
			});
		expect(loaded).toBeDefined();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test("an unwritable session directory fails with the cause and the fix, not a bare errno", async () => {
	const root = await tempDir("proto-session-errors-");
	const sessions = path.join(root, "sessions");
	try {
		await fs.mkdir(sessions);
		await fs.chmod(sessions, 0o555);

		let thrown: unknown;
		try {
			SessionManager.getDefaultSessionDir(path.join(root, "work"), root);
		} catch (error) {
			thrown = error;
		}
		const message = thrown instanceof Error ? thrown.message : String(thrown);
		const hint = thrown instanceof Error && "hint" in thrown ? String(thrown.hint) : "";

		expect(message).toContain("Cannot create the session directory");
		expect(message).toContain("permission denied");
		expect(message).toContain(sessions);
		expect(hint).toContain("chmod u+w");
		expect(hint).toContain("PI_CODING_AGENT_DIR");
		expect(hint).toContain("--no-session");
	} finally {
		await fs.chmod(sessions, 0o755).catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);

test("an unwritable session directory still answers the turn, unpersisted, and says why", async () => {
	const provider = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => {
			const frames = [
				{ choices: [{ delta: { role: "assistant", content: "ANSWERED ANYWAY" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			];
			const body = `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const root = await tempDir("proto-session-unwritable-");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "profile");
	const cwd = path.join(root, "work");
	const sessions = path.join(agentDir, "sessions");
	try {
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(sessions, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			[
				"providers:",
				"  unwritable:",
				`    baseUrl: http://127.0.0.1:${provider.port}/v1`,
				"    apiKey: test-key",
				"    api: openai-completions",
				"    models:",
				"      - id: munwritable",
				'        name: "munwritable"',
				"        contextWindow: 16384",
				"        maxTokens: 1024",
				"",
			].join("\n"),
		);
		await fs.chmod(sessions, 0o555);

		const child = Bun.spawn({
			cmd: [
				process.execPath,
				path.resolve(import.meta.dir, "..", "cli.ts"),
				"--cwd",
				cwd,
				"--no-extensions",
				"--no-title",
				"--tools",
				"read",
				"--model",
				"unwritable/munwritable",
				"-p",
				"say something",
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
				PI_CODING_AGENT_DIR: agentDir,
				TERM: "dumb",
				NO_COLOR: "1",
			},
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		const exitCode = await child.exited;

		// The turn is what the user asked for; the transcript is ours to lose.
		expect(exitCode).toBe(0);
		expect(await stdout).toContain("ANSWERED ANYWAY");
		const errorOutput = await stderr;
		expect(errorOutput).toContain("Cannot create the session directory");
		expect(errorOutput).toContain("This run is not being saved.");
		expect(errorOutput).toContain("PI_CODING_AGENT_DIR");
		expect(await fs.readdir(sessions)).toEqual([]);
	} finally {
		provider.stop(true);
		await fs.chmod(sessions, 0o755).catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
}, 120_000);

test("a live session survives its spill directory being deleted mid-run", async () => {
	// The reported symptom: /tmp/proto-session-history-* vanished under a running process and every
	// later operation that materializes history — spawn, compaction, recovery, all of which call
	// getBranch() — failed with a bare internal string until the process was restarted.
	const dir = await tempDir("proto-session-spill-");
	try {
		const manager = SessionManager.create(dir, dir);
		const warnings: string[] = [];
		manager.onHistoryDegraded(message => warnings.push(message));
		manager.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
		const spilledId = manager.appendMessage({ role: "user", content: UNCACHEABLE, timestamp: Date.now() });
		await manager.flush();

		const spillDirectory = manager.getRawEntryDirectory();
		expect(spillDirectory).toBeDefined();
		expect(spillDirectory?.startsWith(os.tmpdir())).toBe(true);
		await fs.rm(spillDirectory!, { recursive: true, force: true });

		// Everything the session does with its history keeps working.
		expect(manager.getBranch().length).toBeGreaterThan(0);
		expect(manager.getEntries().length).toBeGreaterThan(0);
		expect(manager.getEntry(spilledId)).toBeDefined();

		// And the process re-creates the directory for the next oversized entry instead of
		// staying broken until a restart.
		const afterId = manager.appendMessage({ role: "user", content: `${UNCACHEABLE}after`, timestamp: Date.now() });
		await manager.flush();
		const recreated = manager.getRawEntryDirectory();
		expect(recreated).toBeDefined();
		expect(fsSync.existsSync(recreated!)).toBe(true);
		const restored = manager.getEntry(afterId);
		const message: unknown = restored && "message" in restored ? restored.message : undefined;
		const content = message && typeof message === "object" && "content" in message ? message.content : undefined;
		expect(content).toBe(`${UNCACHEABLE}after`);

		expect(warnings).toHaveLength(1);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 120_000);

test("the degradation reaches the user as a session warning, not only the log", async () => {
	const agentDir = await tempDir("proto-session-notice-");
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const sessionDir = path.join(agentDir, "sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionManager = SessionManager.create(agentDir, sessionDir);
	try {
		const { session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			sessionManager,
			disableExtensionDiscovery: true,
			enableMCP: false,
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			extensions: [],
		});
		const notices: Array<{ level: string; message: string; source?: string }> = [];
		session.subscribe(event => {
			if (event.type === "notice")
				notices.push({ level: event.level, message: event.message, source: event.source });
		});
		try {
			sessionManager.appendMessage({ role: "user", content: UNCACHEABLE, timestamp: Date.now() });
			await sessionManager.flush();
			const spillDirectory = sessionManager.getRawEntryDirectory();
			expect(spillDirectory).toBeDefined();
			await fs.rm(spillDirectory!, { recursive: true, force: true });

			expect(sessionManager.getBranch().length).toBeGreaterThan(0);

			const warning = notices.find(notice => notice.source === "session");
			expect(warning?.level).toBe("warning");
			expect(warning?.message).toContain("The session file was not modified");
			expect(warning?.message).toContain("truncated form");
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 120_000);
