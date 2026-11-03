import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import { DEFAULT_MAX_BYTES } from "../session/streaming-output";
import type { ToolSession } from ".";
import { formatOutputNotice, wrapToolWithMetaNotice } from "./output-meta";
import { ReadTool } from "./read";

type SettingsKey = string;

const settingsValues: Record<SettingsKey, unknown> = {
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
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

function readSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: {
			get: (key: SettingsKey) => settingsValues[key],
			getShellConfig: () => ({ env: {} }),
			getStorage: () => null,
		},
		hasUI: false,
		canPromptUser: false,
		skills: [],
		additionalDirectories: [],
		getSessionFile: () => null,
		getSessionId: () => "read-regressions",
		getImageAttachments: () => [],
		getArtifactsDir: () => null,
		getActiveModel: () => undefined,
		isToolActive: () => false,
	} as unknown as ToolSession;
}

async function withReadSession(run: (read: ReadTool, root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-regressions-"));
	try {
		await run(new ReadTool(readSession(root)), root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

for (const source of ["buffered", "bridge"] as const) {
	test(`${source} empty reads report zero addressable lines`, async () => {
		await withReadSession(async (diskRead, root) => {
			await Bun.write(path.join(root, "empty.txt"), "");
			const session = readSession(root);
			session.getClientBridge = () => ({
				capabilities: { readTextFile: true },
				readTextFile: async ({ path: file }) => fs.readFile(file, "utf8"),
			});
			const read = source === "bridge" ? new ReadTool(session) : diskRead;

			for (const selector of [":2", "", ":raw", ":2:raw"]) {
				const result = await read.execute(`empty-${source}-${selector}`, { path: `empty.txt${selector}` });
				const line = selector.startsWith(":2") ? 2 : 1;
				expect(textOf(result)).toBe(
					selector === ":raw" ? "" : `Line ${line} is beyond end of file (0 lines total). The file is empty.`,
				);
				expect(result.details?.totalLines).toBe(0);
				expect(result.details?.displayContent).toBeUndefined();
			}

			for (const selector of [":1-1,3-3", ":1-1,3-3:raw"]) {
				const result = await read.execute(`empty-ranges-${source}-${selector}`, { path: `empty.txt${selector}` });
				expect(textOf(result)).toBe(
					selector.endsWith(":raw")
						? ""
						: "[Range 1-1 is beyond end of file (0 lines total); skipped]\n[Range 3-3 is beyond end of file (0 lines total); skipped]",
				);
			}
		});
	});
}

test("newline-only files retain their addressable blank lines", async () => {
	await withReadSession(async (read, root) => {
		for (const count of [1, 2]) {
			const file = `blank-${count}.txt`;
			await Bun.write(path.join(root, file), "\n".repeat(count));
			const result = await read.execute(`blank-${count}`, { path: file });
			expect(result.details?.totalLines).toBe(count);
			expect(result.details?.displayContent?.lineNumbers).toEqual(Array.from({ length: count }, (_, i) => i + 1));
			const raw = await read.execute(`blank-raw-${count}`, { path: `${file}:raw` });
			expect(textOf(raw)).toBe("\n".repeat(count));
		}
	});
});

test("multi-range reads surface the same truncation boundary as single-range reads", async () => {
	await withReadSession(async (read, root) => {
		const lines = Array.from(
			{ length: 50_000 },
			(_, index) => `${String(index + 1).padStart(5, "0")}-${"x".repeat(100)}`,
		);
		const file = path.join(root, "large.txt");
		await Bun.write(file, `${lines.join("\n")}\n`);

		const result = await read.execute("multi-range-truncation", { path: "large.txt:1-4000,49999-50000" });
		const text = textOf(result);

		const single = await read.execute("single-page-boundary", { path: "large.txt:1-4000" });
		const end = single.details?.displayContent?.lineNumbers?.filter((line): line is number => line !== null).at(-1);
		if (end === undefined) throw new Error("expected bounded first page");
		expect(text).toContain("0001-");
		expect(text).toContain(`${String(end).padStart(5, "0")}-`);
		expect(text).not.toContain(`${String(end + 1).padStart(5, "0")}-`);
		expect(text).toContain(`Use :${end + 1} to continue`);
		expect(text).toContain("49999-");
		expect(result.details?.meta?.truncation?.shownRange).toEqual({ start: 1, end });

		const controller = new AbortController();
		controller.abort();
		await expect(
			read.execute("multi-range-abort", { path: "large.txt:1-4000,49999-50000" }, controller.signal),
		).rejects.toThrow();

		const wideLines = Array.from({ length: 5_000 }, (_, index) => `${index + 1}-${"w".repeat(1_000)}`);
		await Bun.write(path.join(root, "wide.txt"), `${wideLines.join("\n")}\n`);
		const wideResult = await read.execute("multi-range-byte-truncation", { path: "wide.txt:1-5000,4999-5000" });
		expect(wideResult.details?.truncation?.truncated).toBe(true);
		expect(wideResult.details?.truncation?.truncatedBy).toBe("bytes");
	});
});

test("compressed archive routing uses every registered format", async () => {
	await withReadSession(async (read, root) => {
		const fixtures = {
			bz2: "425a68393141592653593817a124000004c180001036e7cc002000314c0000d4da81a7a9a7a8881b4c679026263ce9522d8c6c9f8bb9229c28481c0bd09200",
			xz: "fd377a585a000004e6d6b4460200210116000000742fe5a301001e616c7068610a626574610a67616d6d610a64656c74610a657073696c6f6e0a0000eabb46832248144f0001371fea18893d1fb6f37d010000000004595a",
		};
		for (const [extension, hex] of Object.entries(fixtures)) {
			await Bun.write(path.join(root, `lines.txt.${extension}`), Buffer.from(hex, "hex"));
			expect(textOf(await read.execute(`list-${extension}`, { path: `lines.txt.${extension}` }))).toContain(
				"lines.txt",
			);
			const text = textOf(
				await read.execute(`read-${extension}`, { path: `lines.txt.${extension}:lines.txt:2-3:raw` }),
			);
			expect(text).toStartWith("beta\ngamma");
			expect(text).not.toContain("alpha");
			expect(text).not.toContain("delta");
		}
	});
});

test("large single-range reads honor an already-aborted signal", async () => {
	await withReadSession(async (read, root) => {
		const file = path.join(root, "large.txt");
		await Bun.write(file, `${"x".repeat(4 * 1024 * 1024)}\nsecond\n`);
		const controller = new AbortController();
		controller.abort();

		await expect(read.execute("aborted-large-read", { path: "large.txt:2-2" }, controller.signal)).rejects.toThrow();
	});
});

test("a file that only goes non-UTF-8 past the sniff window still reads, lossily", async () => {
	await withReadSession(async (read, root) => {
		// Binary detection is the header sniff only. A mostly-text file with a stray
		// invalid byte far into it stays readable — refusing it outright would make
		// logs and partially-corrupt files unreadable, which is worse than U+FFFD.
		const file = path.join(root, "invalid.txt");
		const prefix = Buffer.from(`${"a".repeat(9_000)}\n`);
		await Bun.write(file, Buffer.concat([prefix, Buffer.from([0xff, 0xfe]), Buffer.from("\n")]));

		const text = textOf(await read.execute("invalid-utf8", { path: "invalid.txt:2-2" }));
		expect(text).not.toContain("Cannot read binary file");
		expect(text).toContain("\ufffd");
	});
});

test("':raw' reads a binary file verbatim instead of refusing it", async () => {
	await withReadSession(async (read, root) => {
		const file = path.join(root, "binary.bin");
		await Bun.write(file, Buffer.from([0x00, 0x01, 0x02, 0x03]));

		expect(textOf(await read.execute("binary-plain", { path: "binary.bin" }))).toContain("Cannot read binary file");
		expect(textOf(await read.execute("binary-raw", { path: "binary.bin:raw" }))).not.toContain(
			"Cannot read binary file",
		);
	});
});

test("CRLF line endings are normalized before non-raw content reaches the model", async () => {
	await withReadSession(async (read, root) => {
		await Bun.write(path.join(root, "crlf.txt"), "first\r\nsecond\r\nlast");
		const result = await read.execute("crlf-read", { path: "crlf.txt:1-3" });
		expect(textOf(result)).toBe("first\nsecond\nlast");
	});
});

test("oversized first lines report the delivered partial preview against the full line", async () => {
	await withReadSession(async (read, root) => {
		await Bun.write(path.join(root, "long-line.txt"), `${"x".repeat(DEFAULT_MAX_BYTES + 1)}\nnext\n`);
		const result = await read.execute("long-first-line", { path: "long-line.txt:1-2" });
		const notice = formatOutputNotice(result.details?.meta);
		const text = textOf(result);

		expect(text.length).toBe(DEFAULT_MAX_BYTES);
		expect(result.details?.truncation?.outputBytes).toBe(DEFAULT_MAX_BYTES);
		expect(result.details?.truncation?.totalBytes).toBe(DEFAULT_MAX_BYTES + 1);
		expect(result.details?.meta?.truncation?.partialLine).toBe(true);
		expect(result.details?.meta?.truncation?.nextOffset).toBeUndefined();
		expect(notice).toContain("Showing line 1 (partial, 50.0KB of 50.0KB) of 2");
		expect(notice).not.toContain("0B");
		expect(notice).not.toContain("lines 1-0");
		expect(result.details?.truncation && "content" in result.details.truncation).toBe(false);

		const multi = await read.execute("long-first-line-multi", { path: "long-line.txt:1-2,2-2" });
		expect(multi.details?.truncation?.firstLineExceedsLimit).toBe(true);
		expect(multi.details?.truncation?.totalBytes).toBe(DEFAULT_MAX_BYTES + 1);
	});
});

test("spilling oversized results keeps text and image blocks interleaved", async () => {
	const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
	const content: Array<TextContent | ImageContent> = [
		{ type: "text", text: `before ${"x".repeat(8_000)}` },
		image,
		{ type: "text", text: "after" },
	];
	const tool: AgentTool = {
		name: "interleave",
		label: "Interleave",
		description: "test",
		parameters: {} as AgentTool["parameters"],
		strict: true,
		execute: async (): Promise<AgentToolResult> => ({ content }),
	};
	const settings = {
		get: (key: SettingsKey) =>
			({
				"tools.artifactSpillThreshold": 1,
				"tools.artifactTailBytes": 1,
				"tools.artifactTailLines": 100,
				"tools.artifactHeadBytes": 0,
			})[key],
	};
	const wrapped = wrapToolWithMetaNotice(tool);
	const result = await wrapped.execute("interleave", {}, undefined, undefined, {
		settings,
		sessionManager: { saveArtifact: async () => "artifact-1" },
	} as unknown as AgentToolContext);

	expect(result.content[0]?.type).toBe("text");
	expect(result.content[1]).toEqual(image);
	const trailingText = result.content[2];
	expect(trailingText?.type).toBe("text");
	if (trailingText?.type === "text") expect(trailingText.text).toContain("Showing");
});

test("capped child directories show only their inline marker, not an unactionable limit= notice", async () => {
	await withReadSession(async (read, root) => {
		const child = path.join(root, "child");
		await fs.mkdir(child);
		for (let i = 1; i <= 40; i++) await Bun.write(path.join(child, `c-${i}.txt`), "");

		const result = await wrapToolWithMetaNotice(read).execute("dir-capped", { path: "." });
		const text = textOf(result);
		expect(text).toContain("… 28 more");
		expect(text).not.toContain("limit reached");
		expect(result.details?.meta?.limits).toBeUndefined();

		const sliced = textOf(await wrapToolWithMetaNotice(read).execute("dir-capped-slice", { path: ".:1-3" }));
		expect(sliced).not.toContain("limit reached");

		const expanded = textOf(await read.execute("dir-child", { path: "child" }));
		expect(expanded).toContain("c-40.txt");
		expect(expanded).not.toContain("more");
	});
});

for (const source of ["buffered", "bridge"] as const) {
	test(`${source} code range reads return exactly the selected lines, mark structural anchors, and footer the requested range`, async () => {
		await withReadSession(async (diskRead, root) => {
			const session = readSession(root);
			session.getClientBridge = () => ({
				capabilities: { readTextFile: true },
				readTextFile: async ({ path: file }) => fs.readFile(file, "utf8"),
			});
			const read = source === "bridge" ? new ReadTool(session) : diskRead;
			await Bun.write(
				path.join(root, "sample.ts"),
				[
					"export interface Point { x: number; y: number }",
					"export function dist(a: Point, b: Point): number {",
					"  return Math.hypot(a.x - b.x, a.y - b.y);",
					"}",
					"export class Grid {",
					"  constructor(public w: number, public h: number) {}",
					"  cells(): number {",
					"    return this.w * this.h;",
					"  }",
					"}",
				].join("\n"),
			);

			const wrapped = wrapToolWithMetaNotice(read);
			const ranged = await wrapped.execute(`code-range-${source}`, { path: "sample.ts:1-3" });
			expect(textOf(ranged)).toStartWith(
				[
					"export interface Point { x: number; y: number }",
					"export function dist(a: Point, b: Point): number {",
					"  return Math.hypot(a.x - b.x, a.y - b.y);",
					"⋮ }",
					"",
				].join("\n"),
			);
			expect(textOf(ranged)).not.toContain("class Grid");
			expect(ranged.details?.displayContent?.lineNumbers).toEqual([1, 2, 3, 4]);
			expect(textOf(ranged)).toMatch(/\n\n\[(Showing lines 1-3 of 10|7 more lines in file)\. Use :4 to continue\]$/);

			const tail = await wrapped.execute(`code-range-tail-${source}`, { path: "sample.ts:6-6" });
			expect(textOf(tail)).toStartWith(
				["⋮ export class Grid {", "  constructor(public w: number, public h: number) {}", "…", "⋮ }", ""].join(
					"\n",
				),
			);
			expect(tail.details?.displayContent?.lineNumbers).toEqual([5, 6, null, 10]);
			expect(textOf(tail)).toMatch(/\n\n\[(Showing lines 6-6 of 10|4 more lines in file)\. Use :7 to continue\]$/);

			const raw = await read.execute(`code-range-raw-${source}`, { path: "sample.ts:2-3:raw" });
			expect(textOf(raw)).toBe(
				"export function dist(a: Point, b: Point): number {\n  return Math.hypot(a.x - b.x, a.y - b.y);",
			);
		});
	});
}

test("bounded reads of large files do not report partial scans as line totals", async () => {
	await withReadSession(async (read, root) => {
		const lines = Array.from({ length: 80_000 }, (_, i) => `line ${i} ${"z".repeat(60)}`);
		await Bun.write(path.join(root, "big.txt"), lines.join("\n"));
		const result = await read.execute("big", { path: "big.txt:100-150" });
		const text = textOf(result);
		expect(text).toContain("line 149 ");
		expect(text).toContain("not scanned to EOF). Use :151 to continue]");
		expect(result.details?.meta?.truncation).toBeUndefined();
		expect(result.details?.totalLines).toBeUndefined();
	});
});

test("a FIFO with a SQLite name is refused instead of blocking the SQLite sniff", async () => {
	await withReadSession(async (read, root) => {
		const fifoPath = path.join(root, "pipe.db");
		expect((await Bun.$`mkfifo ${fifoPath}`.nothrow()).exitCode).toBe(0);
		await expect(read.execute("read-fifo-db", { path: fifoPath })).rejects.toThrow(/FIFO/);
	});
}, 5000);

test("JSON tool reads preserve output selectors and in-memory artifact queries", async () => {
	await withReadSession(async (read, root) => {
		await Bun.write(path.join(root, "response"), '{"items":[1,2,3]}');
		expect(textOf(await read.execute("json-file", { path: "response?q=.items[]:2-2:raw" }))).toBe("2");
		const session = readSession(root);
		session.sessionManager = {
			getArtifactContent: (id: string) => (id === "7" ? '{"items":[1,2,3]}' : null),
		} as unknown as NonNullable<ToolSession["sessionManager"]>;
		const virtual = new ReadTool(session);
		expect(textOf(await virtual.execute("json-artifact", { path: "artifact://7?q=.items[1]:raw" }))).toBe("2");
		session.sessionManager = { getArtifactContent: () => "one\ntwo\nthree\n" } as unknown as NonNullable<
			ToolSession["sessionManager"]
		>;
		expect(textOf(await virtual.execute("page-artifact", { path: "artifact://7:2-2:raw" }))).toBe("two");
	});
});

test("tail lists merge repeated selector colons without dropping explicit ranges", async () => {
	await withReadSession(async (read, root) => {
		await Bun.write(path.join(root, "lines.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
		const output = textOf(await read.execute("tail-list", { path: "lines.txt:1-1,:-2:raw" }));
		expect(output).toBe("one\nfive\nsix");
		expect(textOf(await read.execute("tail", { path: "lines.txt:-2:raw" }))).toBe("five\nsix");
		await Bun.write(path.join(root, "lines.txt:1-1,"), "literal\nsecond\n");
		expect(textOf(await read.execute("literal-tail", { path: "lines.txt:1-1,:-1:raw" }))).toBe("second");
	});
});

test("column-capped pages charge shown widths and name the raw recovery cap", async () => {
	await withReadSession(async (_read, root) => {
		const session = readSession(root);
		const base = session.settings.get.bind(session.settings);
		session.settings = {
			...session.settings,
			get: (key: string) => (key === "tools.outputMaxColumns" ? 80 : base(key as never)),
		} as ToolSession["settings"];
		const read = new ReadTool(session);
		const lines = ["head", "W".repeat(80_000), "requested", "end", "F".repeat(4 * 1024 * 1024)];
		await Bun.write(path.join(root, "wide.txt"), `${lines.join("\n")}\n`);
		const first = textOf(await read.execute("cut-page", { path: "wide.txt:1-4" }));
		expect(first).toContain("requested");
		expect(first).toContain(`${"W".repeat(80)}…`);
		expect(first).toContain("Use :raw:2-2 to read line 2 uncut, byte-capped at 50.0KB");
		const ranges = textOf(await read.execute("cut-ranges", { path: "wide.txt:1-2,4-4" }));
		expect(ranges).toContain(`${"W".repeat(80)}…`);
		expect(ranges).toContain("end");
	});
});

test("oversized preceding block context cannot consume a selected source line", async () => {
	await withReadSession(async (read, root) => {
		await Bun.write(
			path.join(root, "context.ts"),
			`function outer(${"x".repeat(80_000)}) {\n const selected = 42;\n}\n`,
		);
		const result = await read.execute("context-priority", { path: "context.ts:2-2" });
		expect(textOf(result)).toContain("const selected = 42");
	});
});

test("archive member reads see same-size in-place rewrites and preserve open raw ranges", async () => {
	await withReadSession(async (read, root) => {
		const file = path.join(root, "members.zip");
		await writeArchive(file, "zip", [["first.txt", "one\ntwo\nthree\n"]]);
		expect(textOf(await read.execute("archive-before", { path: "members.zip:first.txt:1-1,3-:raw" }))).toBe(
			"one\nthree\n",
		);
		await writeArchive(file, "zip", [["other.txt", "four\nfive\nsix\n"]]);
		const listed = textOf(await read.execute("archive-after", { path: "members.zip" }));
		expect(listed).toContain("other.txt");
		expect(listed).not.toContain("first.txt");
		expect(textOf(await read.execute("archive-tail", { path: "members.zip:other.txt:-2:raw" }))).toBe("five\nsix");
	});
});

test("pages capped by the configured spill threshold preserve every shown row", async () => {
	await withReadSession(async (_read, root) => {
		const session = readSession(root);
		const base = session.settings.get.bind(session.settings);
		session.settings = {
			...session.settings,
			get: (key: string) => (key === "tools.artifactSpillThreshold" ? 1 : base(key as never)),
		} as ToolSession["settings"];
		const read = new ReadTool(session);
		await Bun.write(
			path.join(root, "rows.txt"),
			Array.from({ length: 100 }, (_, i) => `row-${i + 1}: ${"x".repeat(100)}`).join("\n"),
		);
		const result = await read.execute("bounded-page", { path: "rows.txt:1-100" });
		expect(result.details?.meta?.pagedSource).toBe(true);
		const end = result.details?.meta?.truncation?.shownRange?.end;
		if (end === undefined) throw new Error("expected page continuation");
		for (let i = 1; i <= end; i++) expect(textOf(result)).toContain(`row-${i}: ${"x".repeat(100)}`);
		expect(textOf(result)).not.toContain(`row-${end + 1}:`);
		expect(result.details?.meta?.truncation?.nextOffset).toBe(end + 1);
	});
});

test("local and file-backed artifact URIs retain JSON queries through path promotion", async () => {
	await withReadSession(async (_read, root) => {
		const session = readSession(root);
		session.localProtocolOptions = { getArtifactsDir: () => root };
		await Bun.write(path.join(root, "local", "data.json"), '{"answer":42}');
		await Bun.write(path.join(root, "12.json"), '{"answer":84}');
		const unregister = registerArtifactsDir(root);
		try {
			const read = new ReadTool(session);
			expect(textOf(await read.execute("local-json", { path: "local://data.json?q=.answer:raw" }))).toBe("42");
			expect(textOf(await read.execute("artifact-json", { path: "artifact://12?q=.answer:raw" }))).toBe("84");
		} finally {
			unregister();
		}
	});
});

test("PDF archive members are converted as documents instead of rejected as binary", async () => {
	await withReadSession(async (read, root) => {
		const stream = "BT /F1 12 Tf 72 720 Td (Archive member text) Tj ET";
		const objects = [
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
			"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		];
		let pdf = "%PDF-1.4\n";
		const offsets = [0];
		for (const [i, object] of objects.entries()) {
			offsets.push(Buffer.byteLength(pdf));
			pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
		}
		const xref = Buffer.byteLength(pdf);
		pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
			.slice(1)
			.map(offset => `${String(offset).padStart(10, "0")} 00000 n `)
			.join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
		await writeArchive(path.join(root, "documents.zip"), "zip", [["nested/report.pdf", pdf]]);
		const result = await read.execute("pdf-member", { path: "documents.zip:nested/report.pdf" });
		expect(textOf(result)).toContain("Archive member text");
		expect(textOf(result)).not.toContain("binary archive entry");
		expect(result.details?.resolvedPath).toBe(`${path.join(root, "documents.zip")}:nested/report.pdf`);
	});
});

test("an overlong explicit path list fans out after literal-file admission fails", async () => {
	await withReadSession(async (read, root) => {
		await Bun.write(path.join(root, "item.txt"), "listed value");
		const result = await read.execute("long-list", {
			path: Array.from({ length: 40 }, () => "item.txt:1-1").join(";"),
		});
		expect(result.details?.displayReadTargets).toHaveLength(40);
		expect(textOf(result)).toContain("listed value");
	});
});
