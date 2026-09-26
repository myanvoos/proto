import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeBashSessions } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("");
}

async function withBash(run: (bash: BashTool) => Promise<void>): Promise<void> {
	await using dir = await TempDir.create("@bash-internal-urls-");
	await Bun.write(dir.join("example skill", "notes with spaces.txt"), "needle one\nother\nneedle two\n");
	const session = {
		cwd: dir.path(),
		getSessionId: () => dir.path(),
		getArtifactsDir: () => dir.join("artifacts"),
		skills: [
			{
				name: "example",
				description: "test skill",
				baseDir: dir.join("example skill"),
				filePath: dir.join("example skill", "SKILL.md"),
				source: "builtin",
			},
		],
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
	} as unknown as ToolSession;
	try {
		await run(new BashTool(session));
	} finally {
		await disposeBashSessions(dir.path());
	}
}

test("rg searches harness documentation files and the documentation root", async () => {
	await withBash(async bash => {
		const file = await bash.execute("docs-file", {
			command: "rg --no-heading -n '^# Bash tool runtime$' harness://bash-tool-runtime.md",
		});
		expect(file.isError, textOf(file)).not.toBe(true);
		expect(textOf(file)).toContain("1:# Bash tool runtime");
		const root = await bash.execute("docs-root", {
			command: "rg -l '^# Bash tool runtime$' harness://",
		});
		expect(root.isError, textOf(root)).not.toBe(true);
		expect(textOf(root)).toContain("bash-tool-runtime.md");
	});
});

test("builtins share rewritten skill paths without splitting spaces", async () => {
	await withBash(async bash => {
		const result = await bash.execute("skill-urls", {
			command:
				"cat skill://example/notes%20with%20spaces.txt | rg '^needle'; rg -c '^needle' skill://example/notes%20with%20spaces.txt",
		});
		expect(result.isError, textOf(result)).not.toBe(true);
		expect(textOf(result)).toContain("needle one\nneedle two\n2");
	});
});

test("read selectors survive URI rewriting on the resolved path", async () => {
	await withBash(async bash => {
		const result = await bash.execute("selector-url", {
			command: "echo harness://bash-tool-runtime.md:1-3 harness://bash-tool-runtime.md:raw:5-9",
		});
		expect(result.isError, textOf(result)).not.toBe(true);
		expect(textOf(result)).toMatch(/^\/\S*\/bash-tool-runtime\.md:1-3 \/\S*\/bash-tool-runtime\.md:raw:5-9$/m);
	});
});

test("unresolvable URI arguments fail before commands run and teach read", async () => {
	await withBash(async bash => {
		await expect(
			bash.execute("missing-url", {
				command: "cat harness://not-a-document.md",
			}),
		).rejects.toThrow("Documentation file not found");
		await expect(
			bash.execute("generated-url", {
				command: "cat history://",
			}),
		).rejects.toThrow("Use read");
	});
});
