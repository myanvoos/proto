import { afterAll, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { BashTool } from "../tools/bash";
import { disposeVmContextsByOwner } from "./js/context-manager";
import { disposeKernelSessionsByOwner } from "./py/executor";

const KERNEL_OWNER = `eval-filesystem-paths-test:${process.pid}`;

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
});

function stubSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `eval-filesystem-paths-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

for (const language of ["python", "node", "bun"]) {
	test(`${language} writes URI-backed files through shell-resolved environment paths`, async () => {
		await using dir = await TempDir.create("@kernel-filesystem-paths-");
		const code =
			language === "python"
				? [
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
		const result = await new BashTool(stubSession(dir.path())).execute("filesystem-handoff", {
			command: `${language} <<'CELL'\n${code}\nCELL`,
			env: { LOCAL_FILE: "local://count with spaces.md", FLEET_FILE: "fleet://job.txt" },
			timeout: 60,
		});
		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		expect(await Bun.file(dir.join("artifacts/local/count with spaces.md")).text()).toBe("24\n");
		expect(await Bun.file(dir.join("artifacts/fleet/job.txt")).text()).toBe("job\n");
	});

	test(`${language} state helpers retain tilde paths and reject unresolved URIs`, async () => {
		await using dir = await TempDir.create("@kernel-state-paths-");
		const code =
			language === "python"
				? [
						"saved_value = 42",
						'save_state("~/state.json", ["saved_value"])',
						"del saved_value",
						'load_state("~/state.json")',
						'print("restored", saved_value)',
						"try:",
						'    save_state("local://wrong.json", ["saved_value"])',
						"except ValueError as error:",
						"    print(error)",
					].join("\n")
				: [
						"let saved_value = 42;",
						'await saveState("~/state.json", ["saved_value"]);',
						"saved_value = 0;",
						'await loadState("~/state.json", {collision: "overwrite"});',
						'print("restored", saved_value);',
						'try { await saveState("local://wrong.json", ["saved_value"]); } catch (error) { print(error.message); }',
					].join("\n");
		const result = await new BashTool(stubSession(dir.path())).execute("state-paths", {
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
