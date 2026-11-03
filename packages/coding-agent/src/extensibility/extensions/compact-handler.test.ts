import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

test("aborting callback-based extension compaction does not crash the host or prevent the next compaction", async () => {
	await using agentDir = await TempDir.create();
	const source = `
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "./src/config/model-registry";
import { Settings } from "./src/config/settings";
import { runExtensionCompact } from "./src/extensibility/extensions/compact-handler";
import { AgentSession } from "./src/session/agent-session";
import { AuthStorage } from "./src/session/auth-storage";
import { SessionManager } from "./src/session/session-manager";

const entered = Promise.withResolvers();
const release = Promise.withResolvers();
const failed = Promise.withResolvers();
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
const authStorage = await AuthStorage.create(":memory:");
const sessionManager = SessionManager.inMemory();
const session = new AgentSession({
  agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
  sessionManager,
  settings: Settings.isolated({
    "compaction.enabled": true,
    "compaction.selfSummary": false,
    "compaction.keepRecentTokens": 1,
  }),
  modelRegistry: new ModelRegistry(authStorage),
  extensionRunner: {
    hasHandlers: type => type === "session_before_compact",
    async emit(event) {
      if (event.type !== "session_before_compact") return;
      entered.resolve();
      await release.promise;
      return { compaction: { summary: "Retained context", firstKeptEntryId: "", tokensBefore: 1000 } };
    },
  },
});
for (let turn = 0; turn < 3; turn++) {
  sessionManager.appendMessage({ role: "user", content: "question " + turn, timestamp: turn });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "answer " + turn }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: turn,
  });
}
session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
const errors = [];
const completions = [];
// Match the memory extension: callbacks own the outcome; the promise is deliberately detached.
void runExtensionCompact(session, {
  onComplete: result => completions.push(result.summary),
  onError: error => { errors.push(error.name); failed.resolve(); },
});
await entered.promise;
session.abortCompaction();
release.resolve();
await failed.promise;
// Allow any detached rejection to reach the process-level handler before starting another compaction.
await Bun.sleep(0);
await runExtensionCompact(session, {
  onComplete: result => completions.push(result.summary),
  onError: error => errors.push(error.name),
});
console.log(JSON.stringify({ errors, completions, isCompacting: session.isCompacting }));
await session.dispose();
authStorage.close();
`;
	const child = Bun.spawn([process.execPath, "-e", source], {
		cwd: path.resolve(import.meta.dir, "../../.."),
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
	expect(JSON.parse(stdout)).toEqual({
		errors: ["CompactionCancelledError"],
		completions: ["Retained context"],
		isCompacting: false,
	});
}, 15_000);
