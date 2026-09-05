import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runExtensionCompact } from "./compact-handler";

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
  skipPythonPreflight: true,
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
  result,
}));
await created.session.dispose();
authStorage.close();
`;
	const child = Bun.spawn([process.execPath, "-e", source], {
		cwd: packageDir,
		env: { ...Bun.env, PI_CODING_AGENT_DIR: agentDir.path() },
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
		result: {
			compaction: { summary: string; firstKeptEntryId: string; details: { compactor: string } };
		};
	};
	expect(output.extensions).toContain("<builtin-memory>");
	expect(output.command).toBe(true);
	expect(output.tool).toBe(true);
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
