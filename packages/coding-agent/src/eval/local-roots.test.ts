import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "../tools";
import { BashTool } from "../tools/bash";
import { disposeVmContextsByOwner } from "./js/context-manager";
import { disposeKernelSessionsByOwner } from "./py/executor";

const KERNEL_OWNER = `eval-local-roots-test:${process.pid}`;

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
});

function stubSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `eval-local-roots-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

test("a fresh session's local:// and fleet:// files are writable from the first kernel cell", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-local-roots-"));
	try {
		const result = await new BashTool(stubSession(dir)).execute("eval-local-roots-test", {
			command: [
				"python <<'__PROTO_CELL__'",
				"proto_path('local://count.md').write_text('24\\n')",
				"proto_path('fleet://job.py').write_text('print(1)\\n')",
				"__PROTO_CELL__",
			].join("\n"),
			timeout: 60,
		});
		expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
		expect(await Bun.file(path.join(dir, "artifacts", "local", "count.md")).text()).toBe("24\n");
		expect(await Bun.file(path.join(dir, "artifacts", "fleet", "job.py")).text()).toBe("print(1)\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("proto_path errors name the missing skill or the accessor that reads a URL, identically in both kernels", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-proto-path-errors-"));
	try {
		const session = stubSession(dir);
		session.skills = [
			{
				name: "example",
				description: "test skill",
				filePath: path.join(dir, "SKILL.md"),
				baseDir: dir,
				source: "test",
			},
		];
		const urls = ["skill://foo/SKILL.md", "artifact://35", "agent://scout_0", "history://", "bogus://y"];
		const tool = new BashTool(session);
		const run = async (command: string): Promise<string[]> => {
			const result = await tool.execute("eval-proto-path-errors", { command, timeout: 60 });
			const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
			expect(result.isError, text).toBeFalsy();
			return text.split("\n").filter(line => urls.some(url => line.startsWith(url)));
		};
		const python = await run(
			[
				"python <<'__PROTO_CELL__'",
				`for url in ${JSON.stringify(urls)}:`,
				"    try:",
				"        proto_path(url)",
				"    except ValueError as exc:",
				"        print(exc)",
				"__PROTO_CELL__",
			].join("\n"),
		);
		const js = await run(
			[
				"node <<'__PROTO_CELL__'",
				`for (const url of ${JSON.stringify(urls)}) {`,
				"  try { protoPath(url); } catch (error) { print(error.message); }",
				"}",
				"__PROTO_CELL__",
			].join("\n"),
		);
		expect(python).toEqual([
			'skill://foo/SKILL.md: no skill named "foo" is installed; available skills: example',
			'artifact://35 is not a filesystem path; read it with tool.read({"path": "artifact://35"}), or pass a kernel-published artifact ref to read_artifact(ref)',
			'agent://scout_0 is not a filesystem path; read it with output(<agent id>) or tool.read({"path": "agent://scout_0"})',
			'history:// is not a filesystem path; read it with tool.read({"path": "history://"})',
			"bogus://y: unsupported URL scheme bogus://; proto_path resolves plain paths and local://, fleet://, skill://",
		]);
		// Same wording; only each kernel's own helper names differ.
		expect(js).toEqual(
			python.map(line => line.replace("read_artifact(", "readArtifact(").replace("proto_path ", "protoPath ")),
		);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
