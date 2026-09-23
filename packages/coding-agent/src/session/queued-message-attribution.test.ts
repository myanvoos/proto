/**
 * Queued user-role messages record who initiated them: host and parent-agent steers (a subagent's
 * budget notice, extension `sendUserMessage`) must not be stamped as the user's own words (#12077).
 */
import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

async function streamingSession(): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const started = Promise.withResolvers<void>();
	const mock = createMockModel({
		responses: [
			() => {
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
		],
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	const run = session.prompt("start");
	cleanup = async () => {
		await session.dispose();
		await run.catch(() => {});
		authStorage.close();
	};
	await started.promise;
	return session;
}

function textOf(message: AgentMessage | undefined): string | undefined {
	if (message?.role !== "user" || typeof message.content === "string") return undefined;
	const part = message.content[0];
	return part?.type === "text" ? part.text : undefined;
}

function queued(session: AgentSession): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const message of [...session.agent.peekSteeringQueue(), ...session.agent.peekFollowUpQueue()]) {
		const text = textOf(message);
		if (text && message.role === "user") out[text] = message.attribution;
	}
	return out;
}

it("queued messages keep the initiator they were given, defaulting to the user", async () => {
	const session = await streamingSession();

	await session.steer("typed steer");
	await session.steer("parent steer", undefined, { attribution: "agent" });
	await session.followUp("parent follow-up", undefined, { attribution: "agent" });
	await session.sendUserMessage("host steer", { deliverAs: "steer", attribution: "agent" });
	await session.prompt("auto continue", { synthetic: true, streamingBehavior: "followUp" });

	expect(queued(session)).toEqual({
		"typed steer": "user",
		"parent steer": "agent",
		"parent follow-up": "agent",
		"host steer": "agent",
		"auto continue": "agent",
	});
});

it("a fresh session file opened with a parent records it; reopening keeps the original header", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-parent-session-"));
	cleanup = () => fs.rm(dir, { recursive: true, force: true });
	const parent = path.join(dir, "parent.jsonl");
	const child = path.join(dir, "parent", "worker.jsonl");

	const fresh = await SessionManager.open(child, undefined, undefined, {
		initialCwd: dir,
		parentSession: parent,
		suppressBreadcrumb: true,
	});
	expect(fresh.getHeader()?.parentSession).toBe(parent);
	await fresh.close();

	const reopened = await SessionManager.open(child, undefined, undefined, {
		parentSession: `${parent}.replacement`,
		suppressBreadcrumb: true,
	});
	expect(reopened.getHeader()?.parentSession).toBe(parent);
	await reopened.close();
});
