import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import type { ToolSession } from ".";
import { ReadTool } from "./read";
import {
	buildInMemoryMultiRangeResult,
	buildInMemoryTextResult,
	countTextLines,
	formatLineEntriesWithMode,
	formatSummaryElisionFooter,
} from "./read-format";
import { dispatchXdTarget } from "./xdev";

const settingsValues: Record<string, unknown> = {
	"images.autoResize": false,
	"read.defaultLimit": 200,
	readLineNumbers: false,
	"read.renderMarkdown": false,
	"read.summarize.enabled": false,
	"fetch.enabled": true,
	"bashInterceptor.enabled": false,
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"kernel.speculation.enabled": false,
	"kernel.assertPreflight.enabled": false,
	"bash.direnv": "off",
	"tools.maxTimeout": 300,
	"tools.outputMaxColumns": 0,
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("");
}

function readSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: {
			get: (key: string) => settingsValues[key],
			getShellConfig: () => ({ env: {} }),
			getStorage: () => null,
		},
		hasUI: false,
		canPromptUser: false,
		skills: [],
		additionalDirectories: [],
		getSessionFile: () => null,
		getSessionId: () => "read-xdev",
		getImageAttachments: () => [],
		getArtifactsDir: () => null,
		getActiveModel: () => undefined,
		isToolActive: () => false,
	} as unknown as ToolSession;
}

async function withReadSession(
	run: (session: ToolSession, read: ReadTool, root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-xdev-"));
	const session = readSession(root);
	try {
		await run(session, new ReadTool(session), root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

test("plain text selectors stay exact while code ranges retain context", async () => {
	await withReadSession(async (session, read, root) => {
		expect(session.cwd).toBe(root);
		await fs.writeFile(path.join(root, "file.txt"), "A\nB\nC\n");
		await fs.writeFile(path.join(root, "code.ts"), "function f() {\n\treturn 1;\n}\n");

		const whole = await read.execute("plain-whole", { path: "file.txt" });
		expect(textOf(whole)).toBe("A\nB\nC");

		const bounded = await read.execute("plain-bounded", { path: "file.txt:2-2" });
		expect(textOf(bounded)).toBe("B");

		const multi = await read.execute("plain-multi", { path: "file.txt:1-1,3-3" });
		expect(textOf(multi)).toBe("A\n…\nC");

		const raw = await read.execute("plain-raw", { path: "file.txt:2-2:raw" });
		expect(textOf(raw)).toBe("B");

		const code = await read.execute("code-bounded", { path: "code.ts:2-2" });
		const codeText = textOf(code);
		expect(codeText).toContain("function f() {");
		expect(codeText).toContain("return 1;");
		expect(codeText).toContain("}");
		expect(code.details?.totalLines).toBe(3);
	});
});

test("plain text range policy stays consistent for in-memory and artifact reads", async () => {
	await withReadSession(async (session, read, root) => {
		const plainPath = path.join(root, "file.txt");
		const codePath = path.join(root, "code.ts");
		const plainText = "A\nB\nC\n";
		const codeText = "function f() {\n\treturn 1;\n}\n";

		const inMemory = buildInMemoryTextResult(session, plainText, 2, 1, {
			sourcePath: plainPath,
			entityLabel: "file",
		});
		expect(textOf(inMemory)).toBe("B");

		const rawWhole = buildInMemoryTextResult(session, plainText, undefined, undefined, {
			sourcePath: plainPath,
			entityLabel: "file",
			raw: true,
		});
		expect(rawWhole.details?.totalLines).toBe(3);
		expect(textOf(rawWhole)).toBe(plainText);

		const inMemoryMulti = buildInMemoryMultiRangeResult(
			session,
			plainText,
			[
				{ startLine: 1, endLine: 1 },
				{ startLine: 3, endLine: 3 },
			],
			{ sourcePath: plainPath, entityLabel: "file" },
		);
		expect(textOf(inMemoryMulti)).toBe("A\n…\nC");

		const inMemoryCode = buildInMemoryTextResult(session, codeText, 2, 1, {
			sourcePath: codePath,
			entityLabel: "file",
		});
		const inMemoryCodeText = textOf(inMemoryCode);
		expect(inMemoryCodeText).toContain("function f() {");
		expect(inMemoryCodeText).toContain("return 1;");
		expect(inMemoryCodeText).toContain("}");

		const artifactDir = path.join(root, "artifacts");
		await fs.mkdir(artifactDir);
		await fs.writeFile(path.join(artifactDir, "7.txt"), plainText);
		const unregister = registerArtifactsDir(artifactDir);
		try {
			const artifact = await read.execute("artifact-plain-bounded", { path: "artifact://7:2-2" });
			expect(textOf(artifact)).toBe("B");

			const artifactMulti = await read.execute("artifact-plain-multi", {
				path: "artifact://7:1-1,3-3",
			});
			expect(textOf(artifactMulti)).toBe("A\n…\nC");
		} finally {
			unregister();
		}

		const archivePath = path.join(root, "fixture.tar");
		await Bun.write(archivePath, await new Bun.Archive({ "plain.txt": plainText, "code.ts": codeText }).bytes());
		const archivePlain = await read.execute("archive-plain-bounded", {
			path: "fixture.tar:plain.txt:2-2",
		});
		expect(textOf(archivePlain)).toBe("B");

		const archiveCode = await read.execute("archive-code-bounded", {
			path: "fixture.tar:code.ts:2-2",
		});
		const archiveCodeText = textOf(archiveCode);
		expect(archiveCodeText).toContain("function f() {");
		expect(archiveCodeText).toContain("return 1;");
		expect(archiveCodeText).toContain("}");
	});
});

test("mounted read preserves loopback HTTP URLs and scopes filesystem paths to branch cwd", async () => {
	await withReadSession(async (session, read, root) => {
		const branch = path.join(root, "branch");
		await fs.mkdir(branch);
		await fs.writeFile(path.join(branch, "relative.txt"), "branch file\n");
		session.xdev = {
			tools: new Map([["read", read]]),
			mountedNames: new Set(["read"]),
			builtInNames: new Set(["read"]),
			isActive: () => false,
		};

		for (const uri of ["xd://", "xd://read"]) {
			const result = await dispatchXdTarget(session, "read", JSON.stringify({ path: uri }), {
				toolCallId: "mounted-internal-uri",
				cwd: branch,
			});
			expect(result.isError).not.toBe(true);
			expect(textOf(result)).toContain("read");
		}

		const body = "loopback URL body\n";
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(body, { headers: { "content-type": "text/plain" } }),
		});
		try {
			const url = `http://127.0.0.1:${server.port}/value`;
			const literal = await dispatchXdTarget(session, "read", JSON.stringify({ path: url }), {
				toolCallId: "mounted-url-literal",
				cwd: branch,
			});
			expect(literal.isError).not.toBe(true);
			expect(textOf(literal)).toContain(body.trim());

			const escapedUrl = url.replaceAll("/", "\\/");
			const escaped = await dispatchXdTarget(session, "read", `{"path":"${escapedUrl}"}`, {
				toolCallId: "mounted-url-escaped",
				cwd: branch,
			});
			expect(escaped.isError).not.toBe(true);
			expect(textOf(escaped)).toContain(body.trim());

			const file = await dispatchXdTarget(session, "read", JSON.stringify({ path: "relative.txt" }), {
				toolCallId: "mounted-file-relative",
				cwd: branch,
			});
			expect(file.isError).not.toBe(true);
			expect(textOf(file)).toContain("branch file");
		} finally {
			server.stop(true);
		}
	});
});

test("delimited read errors remove terminal control characters", async () => {
	await withReadSession(async (_session, read, root) => {
		await Bun.write(path.join(root, "ok.txt"), "ok");

		const result = await read.execute("sanitized-error", { path: "ok.txt;missing\t\rname" });
		const output = textOf(result);

		expect(output).toContain("Could not read missing");
		expect(output).not.toContain("\t");
		expect(output).not.toContain("\r");
		expect(result.details?.displayReadTargets).toEqual(["ok.txt", "missing   name"]);
	});
});

test("bracket-context anchors carry a marker distinct from selected lines", () => {
	const entries = [
		{ kind: "line" as const, lineNumber: 1, text: "opening", context: true },
		{ kind: "line" as const, lineNumber: 2, text: "selected", context: false },
		{ kind: "ellipsis" as const },
		{ kind: "line" as const, lineNumber: 30, text: "closing", context: true },
	];

	expect(formatLineEntriesWithMode(entries, false)).toBe("⋮ opening\nselected\n…\n⋮ closing");
	expect(formatLineEntriesWithMode(entries, true)).toBe("1|⋮ opening\n2|selected\n…\n30|⋮ closing");
});

test("raw and non-raw totals agree when the file ends with a newline", async () => {
	await withReadSession(async (_session, read, root) => {
		await fs.writeFile(path.join(root, "file.txt"), "A\nB\nC\n");

		const plain = await read.execute("line-count-plain", { path: "file.txt:2-2" });
		const raw = await read.execute("line-count-raw", { path: "file.txt:2-2:raw" });
		const rawWhole = await read.execute("line-count-raw-whole", { path: "file.txt:raw" });

		expect(countTextLines("A\nB\nC\n")).toBe(3);
		expect(plain.details?.totalLines).toBe(3);
		expect(raw.details?.totalLines).toBe(3);
		expect(rawWhole.details?.totalLines).toBe(3);
		expect(textOf(plain)).toBe("B");
		expect(textOf(raw)).toBe("B");
		expect(textOf(rawWhole)).toBe("A\nB\nC\n");
	});
});

test("summary footer samples the largest elided ranges in file order", () => {
	const footer = formatSummaryElisionFooter(
		"src/read.ts",
		[
			{ start: 2, end: 88 },
			{ start: 99, end: 115 },
			{ start: 547, end: 2042 },
			{ start: 3000, end: 3500 },
		],
		2090,
	);

	expect(footer).toContain("src/read.ts:2-88,547-2042,3000-3500");
	expect(footer).not.toContain("99-115");
});

test("file code ranges mark opening and closing bracket anchors", async () => {
	await withReadSession(async (_session, read, root) => {
		await fs.writeFile(
			path.join(root, "code.ts"),
			[
				"function f() {",
				"  const a = 1;",
				"  const b = 2;",
				"  const c = 3;",
				"  const d = 4;",
				"  const e = 5;",
				"  const g = 6;",
				"  return a + b;",
				"}",
			].join("\n"),
		);

		const result = await read.execute("anchor-read", { path: "code.ts:2-2" });
		const output = textOf(result);
		expect(output).toContain("function f() {");
		expect(output).toContain("⋮ }");
		expect(result.details?.displayContent?.text).toContain("⋮ }");
	});
});

test("proto documentation index includes cached line-count hints", async () => {
	await withReadSession(async (_session, read) => {
		const result = await read.execute("proto-list", { path: "proto://" });
		const output = textOf(result);
		expect(output).toContain("# Documentation");
		expect(output).toMatch(/- \[.+\]\(proto:\/\/[^)]+\) \(\d+ lines\)/);
	});
});
