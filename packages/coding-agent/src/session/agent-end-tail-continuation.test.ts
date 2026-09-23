/**
 * The deferred `agent_end` is flushed just before the settle drain schedules work that arrived after the loop's final
 * queue poll. Subscribers that treat a terminal end as "stopped" (idle title, await monitors) saw a stop and then a
 * new turn; such an end is now marked non-terminal.
 */
import { afterEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
});

it.each(["irc", "follow-up"] as const)("marks the end before a tail-arriving %s turn non-terminal", async arrival => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const mock = createMockModel();
	mock.push({ content: ["first answer"] });
	mock.push({ content: ["follow-up answer"] });
	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => mock.stream(requested, context, options),
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	const ends: Array<boolean | undefined> = [];
	let queued = false;
	const current = session;
	current.subscribe(event => {
		if (event.type === "agent_end") ends.push(event.isTerminal);
	});
	// The agent emits its own agent_end after the loop's final queue/aside poll; work arriving then is stranded
	// until the settle drain continues with it.
	current.agent.subscribe(event => {
		if (queued || event.type !== "agent_end") return;
		queued = true;
		if (arrival === "irc") {
			void current.deliverIrcMessage({ id: "m1", from: "peer", to: "main", body: "one more thing", ts: Date.now() });
		} else {
			current.agent.followUp({
				role: "user",
				content: "one more thing",
				attribution: "user",
				timestamp: Date.now(),
			});
		}
	});

	await current.prompt("start");
	await current.waitForIdle();
	for (let i = 0; i < 50 && ends.length < 2; i++) await Bun.sleep(2);

	expect(ends).toEqual([false, true]);
});
