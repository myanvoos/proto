import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { isLowSignalTitleInput } from "../tiny/text";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

/**
 * Contract: a session whose only operator message carries no titleable text of
 * its own is still named once, from the assistant's reading of the task. Without
 * the deferred retitle it stayed unnamed for its whole life, because nothing
 * else ever calls `maybeStartTitleGeneration` for an agent launched from one
 * brief and left to run.
 */

let session: AgentSession | undefined;
let auth: AuthStorage | undefined;
// Suite files that boot main() in ACP/RPC mode leave PI_NO_TITLE=1 behind, which gates titling off.
let previousNoTitle: string | undefined;

beforeEach(() => {
	previousNoTitle = Bun.env.PI_NO_TITLE;
	delete Bun.env.PI_NO_TITLE;
});

afterEach(async () => {
	if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
	else Bun.env.PI_NO_TITLE = previousNoTitle;
	vi.restoreAllMocks();
	await session?.dispose();
	auth?.close();
	session = undefined;
	auth = undefined;
});

/** `omp "@brief.md"` sends the brief as one `<file>` attachment, which the pre-filter cleans away. */
const ATTACHED_BRIEF = `<file name="/mnt/briefs/shellport-audit.md">
You are the ShellPortAudit lane. You own seven pull requests that were out of draft and are now
unmergeable, because upstream main deleted the vendored brush crates and rewrote the builtins.
Rebase each one onto live main, resolve the conflicts, re-run the shell suite and report.
</file>`;

/** A reply long enough (>= 40 words) to reveal the task to the deferred retitle. */
const AUDIT_REPLY =
	"Starting on the ShellPortAudit lane. Seven pull requests need rebasing onto live main after the vendored brush crates were deleted, so each one's conflicts have to be resolved against the new builtins before the shell suite can run again. I will take them oldest first and report once the suite is green.";

function stepTool(): AgentTool {
	return {
		name: "step",
		label: "Step",
		description: "One unit of work",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

async function createSession(responses: MockResponse[], tools: AgentTool[] = []): Promise<AgentSession> {
	auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			streamFn: createMockModel({ responses }).stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"retry.modelFallback": false,
		}),
		modelRegistry: new ModelRegistry(auth),
	});
	return session;
}

/** Resolves on the session's next title change. */
function nextTitle(target: AgentSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = target.sessionManager.onSessionNameChanged(() => {
		unsubscribe();
		resolve();
	});
	return promise;
}

describe("AgentSession titles a session whose operator message cannot be titled", () => {
	it("treats an attached brief as untitleable, which is why nothing names the session from it", () => {
		// The premise of every test below: the brief itself carries the task, but the
		// deterministic pre-filter cleans the `<file>` envelope away and declines it.
		expect(isLowSignalTitleInput(ATTACHED_BRIEF)).toBe(true);
	});

	it("names the session from the assistant's reading when the only operator message is an attached brief", async () => {
		const target = await createSession([{ content: [AUDIT_REPLY] }]);
		const titleInputs: string[] = [];
		vi.spyOn(target, "generateTitle").mockImplementation(async input => {
			titleInputs.push(input);
			return "Rebase the ShellPortAudit pull requests";
		});
		const titled = nextTitle(target);

		target.maybeStartTitleGeneration(ATTACHED_BRIEF);
		await target.prompt(ATTACHED_BRIEF);
		await titled;

		expect(target.sessionName).toBe("Rebase the ShellPortAudit pull requests");
		// One request, and it names the conversation rather than the stripped brief.
		expect(titleInputs).toHaveLength(1);
		expect(titleInputs[0]).toContain("ShellPortAudit");
	});

	it("asks the title model once per operator message, however many assistant turns follow", async () => {
		// The bound: assistant turns never drive title requests. Four turns, one request.
		const toolCall = { type: "toolCall" as const, name: "step", arguments: {} };
		const target = await createSession(
			[
				{ content: [AUDIT_REPLY, toolCall] },
				{ content: [AUDIT_REPLY, toolCall] },
				{ content: [AUDIT_REPLY, toolCall] },
				{ content: [AUDIT_REPLY] },
			],
			[stepTool()],
		);
		const generateTitle = vi.spyOn(target, "generateTitle").mockResolvedValue(null);

		target.maybeStartTitleGeneration(ATTACHED_BRIEF);
		await target.prompt(ATTACHED_BRIEF);
		await target.waitForIdle();

		expect(target.sessionName).toBeUndefined();
		expect(generateTitle).toHaveBeenCalledTimes(1);
	});

	it("lets a later operator message name the session after the deferred request failed outright", async () => {
		const target = await createSession([{ content: [AUDIT_REPLY] }, { content: [AUDIT_REPLY] }]);
		let attempts = 0;
		vi.spyOn(target, "generateTitle").mockImplementation(async () => {
			attempts++;
			if (attempts === 1) throw new Error("overloaded");
			return "Rebase the ShellPortAudit pull requests";
		});

		target.maybeStartTitleGeneration(ATTACHED_BRIEF);
		await target.prompt(ATTACHED_BRIEF);
		await target.waitForIdle();
		expect(target.sessionName).toBeUndefined();

		// The next operator message gets its own try, and names the session.
		const titled = nextTitle(target);
		target.maybeStartTitleGeneration("keep going");
		await target.prompt("keep going");
		await titled;

		expect(target.sessionName).toBe("Rebase the ShellPortAudit pull requests");
		expect(attempts).toBe(2);
	});
});
