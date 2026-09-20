/**
 * Recall is the recovery path for everything compaction folds away, so its failure modes are
 * silent: a query that mentions a file returning nothing, one dumped tool result flooding the
 * model's context, or a session file too large to read at all. These pin the bounds.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	buildPreCompactionOutputData,
	capRecallBlocks,
	expandEntryFile,
	loadAllMessages,
	PRE_COMPACTION_OUTPUT_TYPE,
	retainedEntryIdsAfterCompaction,
	searchEntries,
} from "../../vendor/pi-blackhole/index.js";

interface Rendered {
	index: number;
	id: string;
	role: string;
	summary: string;
}

function rendered(index: number, role: string, summary: string): Rendered {
	return { index, id: `e${index}`, role, summary };
}

function message(role: string, text: string): Record<string, unknown> {
	return { role, content: [{ type: "text", text }] };
}

describe("recall search", () => {
	test("a sentence naming a dotted file still ranks the entries that mention it", () => {
		const entries = [
			rendered(0, "assistant", "rewrote the parser entrypoint"),
			rendered(1, "assistant", "observer.ts now advances the cursor"),
		];
		const messages = [
			message("assistant", "rewrote the parser entrypoint"),
			message("assistant", "observer.ts now advances the cursor"),
		];

		const hits = searchEntries(entries, messages, "let me check what observer.ts does");

		expect(hits.map(hit => hit.index)).toEqual([1]);
	});

	test("a dotted term matches literally instead of wildcarding the dot", () => {
		const entries = [rendered(0, "assistant", "observerXts was never a file")];
		const messages = [message("assistant", "observerXts was never a file")];

		expect(searchEntries(entries, messages, "observer.ts")).toHaveLength(0);
	});

	test("operator terms keep their regex meaning", () => {
		const entries = [rendered(0, "assistant", "the auth flow failed"), rendered(1, "assistant", "unrelated")];
		const messages = [message("assistant", "the auth flow failed"), message("assistant", "unrelated")];

		const hits = searchEntries(entries, messages, "login|auth");

		expect(hits.map(hit => hit.index)).toEqual([0]);
	});

	test("one enormous line is clipped around the match instead of returned whole", () => {
		const noise = "x".repeat(20_000);
		const line = `${noise} needle ${noise}`;
		const entries = [rendered(0, "toolResult", line)];
		const messages = [message("toolResult", line)];

		const [hit] = searchEntries(entries, messages, "needle");

		expect(hit.snippet).toBeDefined();
		expect(hit.snippet).toContain("needle");
		expect(hit.snippet!.length).toBeLessThan(1_500);
		expect(hit.snippet).toContain("[truncated]");
	});
});

describe("recall response budget", () => {
	test("entries past the budget are dropped whole, with a footer naming the continuation", () => {
		const block = (index: number) => `#${index} [assistant] ${"body ".repeat(100)}`;

		const result = capRecallBlocks({
			header: "3 matches:",
			entryBlocks: [block(1), block(2), block(3)],
			budget: 1_200,
			continuation: "Use page:2.",
		});

		expect(result.capped).toBe(true);
		expect(result.omittedEntries).toBe(1);
		expect(result.text).toContain("#1 [assistant]");
		expect(result.text).toContain("1 of 3 entries omitted");
		expect(result.text).toContain("Use page:2.");
		// A dropped entry is never half-rendered.
		expect(result.text).not.toContain("#3 [assistant]");
	});

	test("a budget of zero opts out", () => {
		const result = capRecallBlocks({
			header: "header",
			entryBlocks: ["a".repeat(100_000)],
			budget: 0,
		});

		expect(result.capped).toBe(false);
		expect(result.text).toHaveLength("header".length + 2 + 100_000);
	});
});

describe("session file reading", () => {
	test("a session file pi has not written yet reads as empty history, not an error", () => {
		const result = loadAllMessages(path.join("/tmp", `missing-${Date.now()}.jsonl`), false);

		expect(result.rendered).toEqual([]);
		expect(result.rawMessages).toEqual([]);
	});

	test("entries split across read-chunk boundaries survive reassembly", async () => {
		await using dir = await TempDir.create();
		const sessionFile = path.join(dir.path(), "session.jsonl");
		// Each entry is far larger than one 64 KiB read, so every line crosses several chunks.
		const lines = [0, 1, 2].map(index =>
			JSON.stringify({
				id: `m${index}`,
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: `entry${index} ${"pad ".repeat(30_000)}` }] },
			}),
		);
		await Bun.write(sessionFile, `${lines.join("\n")}\n`);

		const result = loadAllMessages(sessionFile, true);

		expect(result.rendered.map(entry => entry.index)).toEqual([0, 1, 2]);
		expect(result.entryIds).toEqual(["m0", "m1", "m2"]);
		expect(result.rendered[2].summary).toContain("entry2");
	});
});

describe("#N:text drill-down", () => {
	test("pages an entry's own message text, which #N:path could never reach", async () => {
		await using dir = await TempDir.create();
		const sessionFile = path.join(dir.path(), "session.jsonl");
		const body = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
		await Bun.write(
			sessionFile,
			`${JSON.stringify({ id: "m0", type: "message", message: { role: "user", content: [{ type: "text", text: body }] } })}\n`,
		);

		const preview = expandEntryFile(sessionFile, 0, "text");
		const windowed = expandEntryFile(sessionFile, 0, "text", false, 30, 10);
		const full = expandEntryFile(sessionFile, 0, "text", true);

		expect(preview).toContain("line 29");
		expect(preview).not.toContain("line 30");
		expect(preview).toContain("#0:text:full");
		expect(windowed).toContain("lines 31-40 (of 80)");
		expect(windowed).toContain("line 39");
		expect(windowed).not.toContain("line 40");
		expect(full).toContain("line 79");
	});

	test("a bash entry drills into its command and output", async () => {
		await using dir = await TempDir.create();
		const sessionFile = path.join(dir.path(), "session.jsonl");
		await Bun.write(
			sessionFile,
			`${JSON.stringify({ id: "m0", type: "message", message: { role: "bashExecution", command: "bun test", output: "3 pass" } })}\n`,
		);

		const out = expandEntryFile(sessionFile, 0, "text", true);

		expect(out).toContain("$ bun test");
		expect(out).toContain("3 pass");
	});
});

describe("pre-compaction output copy", () => {
	const compactionEntry = { id: "c1", firstKeptEntryId: "m3" };
	const branch = [
		{ id: "m0", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } },
		{
			id: "m1",
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "the answer you asked for" }] },
		},
		{ id: "m2", type: "message", message: { role: "user", content: [{ type: "text", text: "thanks" }] } },
		{ id: "m3", type: "message", message: { role: "assistant", content: [{ type: "text", text: "still visible" }] } },
		{ id: "c1", type: "compaction", summary: "folded", firstKeptEntryId: "m3" },
	];

	test("copies the newest assistant text the cut dropped, not one the tail still shows", () => {
		const retained = retainedEntryIdsAfterCompaction(branch, compactionEntry);
		const data = buildPreCompactionOutputData(branch, retained, compactionEntry);

		expect(retained.has("m3")).toBe(true);
		expect(data?.text).toBe("the answer you asked for");
		expect(data?.sourceEntryId).toBe("m1");
		expect(data?.compactionEntryId).toBe("c1");
		expect(data?.truncated).toBe(false);
		expect(PRE_COMPACTION_OUTPUT_TYPE).toBe("blackhole-pre-compaction-output");
	});

	test("an oversized copy is bounded and marked", () => {
		const huge = "y".repeat(40_000);
		const wide = [
			{ id: "m0", type: "message", message: { role: "assistant", content: [{ type: "text", text: huge }] } },
			{ id: "c1", type: "compaction", summary: "folded", firstKeptEntryId: "" },
		];

		const data = buildPreCompactionOutputData(wide, retainedEntryIdsAfterCompaction(wide, { id: "c1" }), {
			id: "c1",
		});

		expect(data?.truncated).toBe(true);
		expect(Buffer.byteLength(data!.text, "utf8")).toBeLessThanOrEqual(16 * 1024);
	});

	test("a compaction that dropped no assistant text copies nothing", () => {
		const onlyUser = [
			{ id: "m0", type: "message", message: { role: "user", content: [{ type: "text", text: "question" }] } },
			{ id: "c1", type: "compaction", summary: "folded", firstKeptEntryId: "" },
		];

		expect(
			buildPreCompactionOutputData(onlyUser, retainedEntryIdsAfterCompaction(onlyUser, { id: "c1" }), { id: "c1" }),
		).toBeUndefined();
	});
});
