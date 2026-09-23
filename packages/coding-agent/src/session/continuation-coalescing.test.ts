/**
 * Two continuation requests landing in the same tick used to call Agent.continue() twice; the second call hit a
 * still-running first attempt and failed with AgentBusyError. Concurrent requests now share one attempt.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
});

it("coalesces concurrent continuation requests instead of calling a busy agent", async () => {
	authStorage = await AuthStorage.create(":memory:");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
	session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	const release = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let inFlight = false;
	const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
		if (inFlight) throw new AgentBusyError();
		inFlight = true;
		started.resolve();
		await release.promise;
		inFlight = false;
	});
	const warn = vi.spyOn(logger, "warn");

	session.resumeAfterAskReanswer();
	session.resumeAfterAskReanswer();
	await started.promise;
	release.resolve();
	await session.waitForIdle();

	expect(continueSpy).toHaveBeenCalledTimes(1);
	expect(warn).not.toHaveBeenCalledWith("agent.continue failed after scheduling", expect.anything());
});
