import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { EvalCellResult } from "../eval/types";
import type { ToolSession } from ".";
import { EvalTool } from "./eval";

const KERNEL_OWNER = `eval-patch-directive-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings: Record<string, unknown> = {};
	return {
		cwd,
		settings: {
			get: (key: string) => settings[key],
		},
		getEvalSessionId: () => "eval-patch-directive-test",
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

interface PatchCellResult {
	status: EvalCellResult["status"] | undefined;
	output: string;
}

async function runCell(dir: string, code: string): Promise<PatchCellResult> {
	const result = await new EvalTool(stubSession(dir)).execute("eval-patch-directive-test", {
		language: "py",
		code,
		title: "patch directive",
		timeout: 60,
	});
	return {
		status: result.details?.cells?.[0]?.status,
		output: result.details?.cells?.[0]?.output ?? "",
	};
}

async function makeDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "eval-patch-directive-"));
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(KERNEL_OWNER);
});

test("patch directive unwraps a quoted path and dedents pasted body", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "quoted target.txt");
		await Bun.write(target, "before\nold\nafter\n");
		const quotedPath = JSON.stringify(target);
		const code = [
			"if True:",
			`    #@patch ${quotedPath}`,
			"        *** Begin Patch",
			`        *** Update File ${target}`,
			"        @@ -2,1 +2,1 @@",
			"         before",
			"        -old",
			"        +new",
			"        *** End Patch",
			"    #@end",
		].join("\n");
		const cell = await runCell(dir, code);
		expect(cell.status).toBe("complete");
		expect(cell.output).not.toContain("Error");
		expect(await Bun.file(target).text()).toBe("before\nnew\nafter\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("patch directives execute only at their runtime source position", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "conditional.txt");
		await Bun.write(target, "old\n");
		const quotedPath = JSON.stringify(target);
		const disabled = [
			"if False:",
			`    #@patch ${quotedPath}`,
			"        @@",
			"        -old",
			"        +disabled",
			"    #@end",
		].join("\n");
		expect((await runCell(dir, disabled)).status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("old\n");

		const enabled = [
			"if True:",
			`    #@patch ${quotedPath}`,
			"        @@",
			"        -old",
			"        +enabled",
			"    #@end",
		].join("\n");
		expect((await runCell(dir, enabled)).status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("enabled\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("custom terminators are whitespace-tolerant without consuming marker hunks", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "custom marker.txt");
		await Bun.write(target, "PATCH_DONE\nPATCH_DONE\n");
		const quotedPath = JSON.stringify(target);
		const code = [
			`#@patch ${quotedPath} until = PATCH_DONE`,
			"    @@",
			"     PATCH_DONE",
			"    -PATCH_DONE",
			"    +PATCH_DONE-updated",
			"PATCH_DONE   ",
		].join("\n");
		const cell = await runCell(dir, code);
		expect(cell.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("PATCH_DONE\nPATCH_DONE-updated\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("quoted path wrappers keep backslashes literal", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "literal\\n target.txt");
		await Bun.write(target, "old\n");
		const code = [`#@patch '${target}'`, "    @@", "    -old", "    +new", "#@end"].join("\n");
		const cell = await runCell(dir, code);
		expect(cell.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("new\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("blank body padding may omit directive indentation", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "blank padding.txt");
		await Bun.write(target, "old\n");
		const quotedPath = JSON.stringify(target);
		const code = [
			"if True:",
			`    #@patch ${quotedPath}`,
			"",
			"        @@",
			"        -old",
			"        +new",
			"    #@end",
		].join("\n");
		const cell = await runCell(dir, code);
		expect(cell.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("new\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("multiline string contents are not treated as directives", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "string protection.txt");
		await Bun.write(target, "old\n");
		const quotedPath = JSON.stringify(target);
		const code = [
			'text = """',
			`#@patch ${quotedPath}`,
			"    @@",
			"    -old",
			"    +must-not-apply",
			"#@end",
			'"""',
			"after = 42",
			"assert after == 42",
		].join("\n");
		const cell = await runCell(dir, code);
		expect(cell.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("old\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
