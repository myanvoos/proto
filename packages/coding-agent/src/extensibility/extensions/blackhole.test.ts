import { expect, test } from "bun:test";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MEMORY_THINKING_LEVEL, resolveMemoryModelCandidates } from "../../vendor/pi-blackhole/index.js";
import { runExtensionCompact } from "./compact-handler";

test("memory workers use a provider-compatible thinking effort", () => {
	expect(MEMORY_THINKING_LEVEL).toBe("low");
});

test("memory candidates use existing role resolution and preserve an active role model", () => {
	const active = { provider: "active", id: "large" } as Model;
	const smol = { provider: "fast", id: "small" } as Model;
	const tiny = { provider: "local", id: "tiny" } as Model;
	const models = { resolve: (spec: string) => (spec === "@smol" ? smol : tiny) };

	expect(resolveMemoryModelCandidates({ model: active, models })).toEqual([smol, tiny, active]);
	expect(resolveMemoryModelCandidates({ model: tiny, models })).toEqual([tiny, smol]);
});

test("compact options preserve extension-provided instructions", async () => {
	let receivedInstructions: string | undefined;
	const session = {
		async compact(instructions?: string): Promise<void> {
			receivedInstructions = instructions;
		},
	};

	await runExtensionCompact(session, { customInstructions: "__pi_vcc__" });

	expect(receivedInstructions).toBe("__pi_vcc__");
});

test("an advisory compaction request the session declines is cancelled, not run", async () => {
	let compactions = 0;
	const errors: string[] = [];
	const session = {
		advisoryCompactionAllowed: () => false,
		async compact(): Promise<void> {
			compactions++;
		},
	};

	await runExtensionCompact(session, { onError: error => errors.push(error.message) }, true);

	expect(compactions).toBe(0);
	// Requesters clear their in-flight flag on this exact message and stay quiet about it.
	expect(errors).toEqual(["Compaction cancelled"]);
});

test("a user-invoked compaction request runs even when the session would decline an advisory one", async () => {
	let compactions = 0;
	const session = {
		advisoryCompactionAllowed: () => false,
		async compact(): Promise<void> {
			compactions++;
		},
	};

	await runExtensionCompact(session, { customInstructions: "__pi_vcc__" }, false);

	expect(compactions).toBe(1);
});

test("built-in memory extension produces deterministic structural compaction", async () => {
	await using agentDir = await TempDir.create();
	const packageDir = path.resolve(import.meta.dir, "../../..");
	const source = `
import { AuthStorage, createAgentSession } from "./src/index";
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required");
const authStorage = await AuthStorage.create(agentDir + "/auth.db");
let failureEvent;
const created = await createAgentSession({
  cwd: process.cwd(),
  agentDir,
  authStorage,
  disableExtensionDiscovery: true,
  enableMCP: false,
  workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
  skills: [],
  rules: [],
  contextFiles: [],
  promptTemplates: [],
  slashCommands: [],
  extensions: [pi => {
    pi.on("session_compact_failed", event => { failureEvent = event; });
  }],
});
const extension = created.extensionsResult.extensions.find(item => item.path === "<builtin-memory>");
if (!extension) throw new Error("built-in memory extension was not loaded");
const handler = extension.handlers.get("session_before_compact")?.[0];
if (!handler) throw new Error("memory compaction hook was not registered");
const message = (id, role, content) => ({ id, type: "message", message: { role, content } });
const branchEntries = [
  message("m1", "user", "Fix the authentication bug"),
  message("m2", "assistant", "I will update src/auth.ts"),
  message("m3", "toolResult", "updated file"),
  message("m4", "assistant", "Tests pass"),
];
const notices = [];
const observerEntries = [
  message("observer-user", "user", "Remember this context"),
  message("observer-source", "assistant", "context ".repeat(10000)),
];
const observerContext = {
  cwd: process.cwd(),
  hasUI: true,
  ui: { notify(message) { notices.push(message); } },
  model: { provider: "missing", id: "active", api: "test" },
  models: { resolve(spec) { return { provider: "missing", id: spec === "@smol" ? "smol" : "tiny", api: "test" }; } },
  modelRegistry: created.session.modelRegistry,
  sessionManager: { getSessionId() { return "observer-regression"; }, getBranch() { return observerEntries; } },
};
for (const agentStartHandler of extension.handlers.get("agent_start") ?? []) {
  await agentStartHandler({ type: "agent_start" }, observerContext);
}
await Bun.sleep(500);
const result = await handler(
  {
    type: "session_before_compact",
    customInstructions: "__pi_vcc__",
    branchEntries,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: ["src/auth.ts"], edited: [] },
      tokensBefore: 1000,
    },
    signal: new AbortController().signal,
  },
  { cwd: process.cwd(), hasUI: false, ui: { notify() {} }, model: { provider: "test", api: "test" } },
);
await created.session.compact().catch(() => {});
console.log(JSON.stringify({
  extensions: created.extensionsResult.extensions.map(item => item.path),
  command: Boolean(created.session.extensionRunner?.getCommand("memory")),
  tool: Boolean(created.session.extensionRunner?.getRegisteredTool("recall")),
  failureEvent,
  notices,
  result,
}));
await created.session.dispose();
authStorage.close();
`;
	const child = Bun.spawn([process.execPath, "-e", source], {
		cwd: packageDir,
		env: { ...Bun.env, PI_CODING_AGENT_DIR: agentDir.path(), PI_BLACKHOLE_OBSERVE_AFTER_TOKENS: "1000" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout as ReadableStream<Uint8Array>).text(),
		new Response(child.stderr as ReadableStream<Uint8Array>).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const output = JSON.parse(stdout) as {
		extensions: string[];
		command: boolean;
		tool: boolean;
		failureEvent: { type: string; reason: string; aborted: boolean; willRetry: boolean };
		notices: string[];
		result: {
			compaction: { summary: string; firstKeptEntryId: string; details: { compactor: string } };
		};
	};
	expect(output.extensions).toContain("<builtin-memory>");
	expect(output.command).toBe(true);
	expect(output.tool).toBe(true);
	expect(output.notices.some(notice => notice.includes("undefined is not an object"))).toBe(false);
	expect(output.failureEvent).toMatchObject({
		type: "session_compact_failed",
		reason: "manual",
		aborted: false,
		willRetry: false,
	});
	expect(output.result.compaction.details.compactor).toBe("blackhole");
	expect(output.result.compaction.firstKeptEntryId).toBe("");
	expect(output.result.compaction.summary).toContain("[Session Goal]\n- Fix the authentication bug");
	expect(output.result.compaction.summary).toContain("I will update src/auth.ts");
}, 15_000);
