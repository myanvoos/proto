import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { createAgentSession } from "../sdk";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

test("SDK Python submissions are fresh while explicit store and named kernels retain their own state", async () => {
	using directory = TempDir.createSync("@sdk-python-fresh-");
	const cwd = directory.path();
	const authStorage = await AuthStorage.create(directory.join("auth.db"));
	const settings = Settings.isolated();
	const manager = SessionManager.create(cwd, directory.join("sessions"));
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			authStorage,
			settings,
			sessionManager: manager,
			modelRegistry: new ModelRegistry(authStorage, directory.join("models.yml"), { settings }),
			toolNames: ["bash"],
			disableExtensionDiscovery: true,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			const first = await session.executePython("import os; value = 41; print(os.getpid())");
			const second = await session.executePython(
				'import os; print(os.getpid()); print("value" in globals(), "tool" in globals())',
			);
			expect(first.exitCode).toBe(0);
			expect(second.exitCode).toBe(0);
			expect(second.output).toContain("False False");
			expect(second.output.trim().split("\n")[0]).not.toBe(first.output.trim());
			const seed = await session.executePython(
				[
					"import proto_harness as harness",
					'harness.store["value"] = {"answer": 42}',
					'harness.kernel("analysis").run("value = 41")',
				].join("\n"),
			);
			expect(seed.exitCode, seed.output).toBe(0);
			const reuse = await session.executePython(
				[
					"import proto_harness as harness",
					'print("stored-value", harness.store["value"]["answer"])',
					`print(harness.kernel("analysis").run("print('warm-value', value + 1)")["output"])`,
					'print("still-fresh", "value" in globals())',
				].join("\n"),
			);
			expect(reuse.exitCode, reuse.output).toBe(0);
			expect(reuse.output).toContain("stored-value 42");
			expect(reuse.output).toContain("warm-value 42");
			expect(reuse.output).toContain("still-fresh False");
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
	}
}, 60_000);
