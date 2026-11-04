import { afterAll, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { authorizeSessionToolCall } from "../session/tool-call-policy";
import type { Tool, ToolSession } from "../tools";
import { BashTool } from "../tools/bash";
import { ReadTool } from "../tools/read";
import { disposeVmContextsByOwner } from "./js/context-manager";
import { disposeKernelSessionsByOwner } from "./py/executor";
import { checkPythonKernelAvailability } from "./py/kernel";

const python = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });

const KERNEL_OWNER = `eval-filesystem-paths-test:${process.pid}`;

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
});

function fixtureSession(cwd: string): ToolSession {
	const tools = new Map<string, Tool>();
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		toolRegistry: tools,
		getToolByName: name => tools.get(name),
		getToolForEvalBridge: name => tools.get(name),
		getEvalBridgeToolNames: () => [...tools.keys()],
		beforeEvalToolCall: (tool, id, args, signal) =>
			authorizeSessionToolCall(
				undefined,
				{ type: "toolCall", id, name: tool.name, arguments: args },
				tool,
				args,
				signal,
			),
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `eval-filesystem-paths-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	};
	tools.set("bash", new BashTool(session));
	tools.set("read", new ReadTool(session));
	return session;
}

for (const language of ["python", "node", "bun"]) {
	test.if(language !== "python" || python.ok)(
		`${language} writes URI-backed files through shell-resolved environment paths`,
		async () => {
			await using dir = await TempDir.create("@kernel-filesystem-paths-");
			const code =
				language === "python"
					? [
							"import os",
							"from pathlib import Path",
							'assert "proto_path" not in globals()',
							'Path(os.environ["LOCAL_FILE"]).write_text("24\\n")',
							'Path(os.environ["FLEET_FILE"]).write_text("job\\n")',
						].join("\n")
					: [
							'import * as fs from "node:fs";',
							'if (typeof protoPath !== "undefined") throw new Error("unexpected path helper");',
							'fs.writeFileSync(env("LOCAL_FILE"), "24\\n");',
							'fs.writeFileSync(env("FLEET_FILE"), "job\\n");',
						].join("\n");
			const result = await new BashTool(fixtureSession(dir.path())).execute("filesystem-handoff", {
				command: `${language === "python" ? `'${python.pythonPath}'` : language} <<'CELL'\n${code}\nCELL`,
				env: { LOCAL_FILE: "local://count with spaces.md", FLEET_FILE: "fleet://job.txt" },
				timeout: 60,
			});
			expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
			expect(await Bun.file(dir.join("artifacts/local/count with spaces.md")).text()).toBe("24\n");
			expect(await Bun.file(dir.join("artifacts/fleet/job.txt")).text()).toBe("job\n");
		},
	);
}

for (const language of ["node", "bun"]) {
	test(`${language} state helpers retain tilde paths and reject unresolved URIs`, async () => {
		await using dir = await TempDir.create("@kernel-state-paths-");
		const code = [
			"let saved_value = 42;",
			'await saveState("~/state.json", ["saved_value"]);',
			"saved_value = 0;",
			'await loadState("~/state.json", {collision: "overwrite"});',
			'print("restored", saved_value);',
			'try { await saveState("local://wrong.json", ["saved_value"]); } catch (error) { print(error.message); }',
		].join("\n");
		const result = await new BashTool(fixtureSession(dir.path())).execute("state-paths", {
			command: `${language} <<'CELL'\n${code}\nCELL`,
			env: { HOME: dir.path() },
			timeout: 60,
		});
		const output = result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(result.isError, output).not.toBe(true);
		expect(output).toContain("restored 42");
		expect(output).toContain("Expected a filesystem path");
		expect(await Bun.file(dir.join("state.json")).json()).toMatchObject({ format: "proto.kernel-state" });
	});
}
