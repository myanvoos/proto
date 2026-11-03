import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

async function admissionSession() {
	const auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing Anthropic test fixture");
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const mock = createMockModel({
		responses: [
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["first reply"] };
			},
			{ content: ["joined reply"] },
		],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	return { session, auth, started, release };
}

test("active-turn joining queues user content on its client-owned turn instead of starting a detached run", async () => {
	const { session, auth, started, release } = await admissionSession();
	try {
		expect(await session.joinActiveTurn("idle content")).toBe(false);
		const prompt = session.prompt("initial prompt");
		await started.promise;
		expect(await session.joinActiveTurn("joined content")).toBe(true);
		release.resolve();
		await prompt;
		await session.waitForIdle();
		const users = session.messages.filter(message => message.role === "user");
		expect(users.map(message => message.content)).toEqual([
			[{ type: "text", text: "initial prompt" }],
			[{ type: "text", text: "joined content" }],
		]);
	} finally {
		release.resolve();
		await session.dispose();
		auth.close();
	}
});

test("a cancel racing active-turn image preprocessing refuses admission and leaves no stranded user content", async () => {
	const { session, auth, started, release } = await admissionSession();
	try {
		const prompt = session.prompt("initial prompt");
		await started.promise;
		const joining = session.joinActiveTurn("must stay with client");
		const aborting = session.abort({ reason: "user interrupted" });
		expect(await joining).toBe(false);
		release.resolve();
		await Promise.all([prompt, aborting]);
		expect(session.queuedMessageCount).toBe(0);
		expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
	} finally {
		release.resolve();
		await session.dispose();
		auth.close();
	}
});
