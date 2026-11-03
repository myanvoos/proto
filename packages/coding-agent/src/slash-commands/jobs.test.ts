import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "../async/job-manager";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { executeAcpBuiltinSlashCommand } from "./acp-builtins";
import type { SlashCommandRuntime } from "./types";

test("jobs kill refuses other sessions' jobs and kill all only cancels owned running jobs", async () => {
	const auth = await AuthStorage.create(":memory:");
	const manager = new AsyncJobManager({});
	const settings = Settings.isolated();
	const sessionManager = SessionManager.inMemory();
	const session = new AgentSession({
		agent: new Agent({ initialState: { tools: [], messages: [], systemPrompt: [] } }),
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(auth),
		asyncJobManager: manager,
	});
	const release = Promise.withResolvers<void>();
	const pending = async () => {
		await release.promise;
		return "finished";
	};
	const own = manager.register("bash", "owned command", pending, { ownerId: session.getAsyncJobOwnerId() });
	const foreign = manager.register("bash", "other command", pending, { ownerId: "another-session" });
	const output: string[] = [];
	const runtime: SlashCommandRuntime = {
		session,
		sessionManager,
		settings,
		cwd: sessionManager.getCwd(),
		output: text => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	try {
		await executeAcpBuiltinSlashCommand(`/jobs kill ${foreign}`, runtime);
		expect(manager.getJob(foreign)?.status).toBe("running");
		expect(manager.getJob(own)?.status).toBe("running");
		await executeAcpBuiltinSlashCommand("/jobs kill all", runtime);
		expect(manager.getJob(own)?.status).toBe("cancelled");
		expect(manager.getJob(foreign)?.status).toBe("running");
		expect(output[0]).toContain("No running background job");
	} finally {
		release.resolve();
		await manager.waitForAll();
		await session.dispose();
		await manager.dispose();
		auth.close();
	}
});
