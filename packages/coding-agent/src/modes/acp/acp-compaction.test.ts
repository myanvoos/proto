import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { createAgentSession } from "../../sdk";
import type { AgentSessionEvent } from "../../session/agent-session";
import { AuthStorage } from "../../session/auth-storage";
import { SessionManager } from "../../session/session-manager";
import { AcpAgent } from "./acp-agent";

afterEach(() => vi.restoreAllMocks());

test("ACP buffers compaction transitions before bootstrap and delivers later failures without exposing internal token projections", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-acp-compaction-"));
	const auth = await AuthStorage.create(":memory:");
	const settings = Settings.isolated();
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const notifications: { method: string; params: Record<string, unknown> }[] = [];
	const drained = Promise.withResolvers<void>();
	const live = Promise.withResolvers<void>();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		authStorage: auth,
		settings,
		modelRegistry: new ModelRegistry(auth, path.join(dir, "models.yml"), { settings }),
		sessionManager: SessionManager.inMemory(dir),
		toolNames: [],
		enableMCP: false,
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: dir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});
	spyOn(session, "subscribe").mockImplementation(listener => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	});
	const connection = {
		signal: new AbortController().signal,
		sessionUpdate: async () => {},
		extNotification: async (method: string, params: Record<string, unknown>) => {
			notifications.push({ method, params: JSON.parse(JSON.stringify(params)) });
			if (notifications.length === 2) drained.resolve();
			if (notifications.length === 3) live.resolve();
		},
	} as unknown as AgentSideConnection;
	const acp = new AcpAgent(connection, async () => session);
	try {
		await acp.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await acp.newSession({ cwd: dir, mcpServers: [] });
		for (const listener of listeners)
			listener({ type: "auto_compaction_start", reason: "threshold", action: "remote" });
		for (const listener of listeners)
			listener({
				type: "auto_compaction_end",
				action: "remote",
				result: { summary: "compacted", firstKeptEntryId: "entry", tokensBefore: 1200 },
				aborted: false,
				willRetry: true,
			});
		expect(notifications).toEqual([]);
		await drained.promise;
		expect(notifications).toEqual([
			{ method: "_proto/compaction/start", params: { sessionId, reason: "threshold", action: "remote" } },
			{
				method: "_proto/compaction/end",
				params: { sessionId, action: "remote", aborted: false, willRetry: true, tokensBefore: 1200 },
			},
		]);
		// Let the bootstrap continuation open live delivery after its buffered drain.
		await Promise.resolve();
		for (const listener of listeners)
			listener({
				type: "auto_compaction_end",
				action: "context-full",
				result: undefined,
				aborted: true,
				willRetry: false,
				skipped: true,
				errorMessage: "cancelled",
			});
		await live.promise;
		expect(notifications[2]).toEqual({
			method: "_proto/compaction/end",
			params: {
				sessionId,
				action: "context-full",
				aborted: true,
				willRetry: false,
				skipped: true,
				errorMessage: "cancelled",
			},
		});
	} finally {
		await acp.dispose();
		auth.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
