import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import { createAgentSession } from "../sdk";
import { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { checkPythonKernelAvailability } from "./py/kernel";

const pythonAvailable = (await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true })).ok;

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

test.if(pythonAvailable)(
	"kernel tool-bridge calls resolve relative paths against the calling cell's cwd",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-cwd-"));
		const sessionDir = path.join(root, "session");
		const cellDir = path.join(root, "cell");
		await Bun.write(path.join(sessionDir, "probe.txt"), "from-session-dir\n");
		await Bun.write(path.join(cellDir, "probe.txt"), "from-cell-dir\n");
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		try {
			const { session } = await createAgentSession({
				cwd: sessionDir,
				agentDir: root,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"checklist.enabled": false,
					"tools.xdev": false,
				}),
				authStorage,
				sessionManager: SessionManager.create(sessionDir, path.join(root, "sessions")),
				toolNames: ["bash", "read"],
				disableExtensionDiscovery: true,
				enableMCP: false,
				workspaceTree: { rootPath: sessionDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				extensions: [],
			});
			try {
				const bash = session.getToolByName("bash");
				if (!bash) throw new Error("bash tool missing");

				const pyRead = await bash.execute("py-read", {
					command: `python -c 'print(tool.read({"path": "probe.txt"})["text"])'`,
					cwd: cellDir,
				});
				expect(textOf(pyRead)).toContain("from-cell-dir");
				expect(textOf(pyRead)).not.toContain("from-session-dir");

				const jsRead = await bash.execute("js-read", {
					command: `node -e 'console.log((await tool.read({ path: "probe.txt" })).text)'`,
					cwd: cellDir,
				});
				expect(textOf(jsRead)).toContain("from-cell-dir");
				expect(textOf(jsRead)).not.toContain("from-session-dir");

				const pyArtifact = await bash.execute("py-artifact", {
					command: `python -c 'ref = publish_artifact(path="probe.txt", kind="text"); print(read_artifact(ref)["data"])'`,
					cwd: cellDir,
				});
				expect(textOf(pyArtifact)).toContain("from-cell-dir");

				// Without a per-call cwd the cell runs in the session directory, and so does the bridge.
				const sessionRead = await bash.execute("py-session-read", {
					command: `python -c 'print(tool.read({"path": "probe.txt"})["text"])'`,
				});
				expect(textOf(sessionRead)).toContain("from-session-dir");
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	120_000,
);
