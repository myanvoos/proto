import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { createAgentSession } from "../sdk";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

// A finished rewind must stay finished across resume/tree navigation; otherwise the
// rewind tool loses its "already completed" guard and reports "No active checkpoint".
test("a resumed session remembers the rewind it already completed", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-rewind-rehydrate-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const settings = Settings.isolated();
	const sessionManager = SessionManager.inMemory(agentDir);
	sessionManager.appendCustomMessageEntry(
		"rewind-report",
		"Rewound.\nReport:\nfound the bug in parser.ts",
		false,
		{
			report: "found the bug in parser.ts",
			startedAt: "2026-09-27T00:00:00.000Z",
			rewoundAt: "2026-09-27T00:05:00.000Z",
		},
		"agent",
	);
	try {
		const { session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings }),
			settings,
			sessionManager,
			hasUI: false,
			disableExtensionDiscovery: true,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: agentDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			expect(session.getLastCompletedRewind()?.report).toBe("found the bug in parser.ts");
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
