import { expect, test } from "bun:test";
import { ThinkingLoopDetector, thinkingLoopDetail } from "./thinking-loop";

const CHUNK_SIZES = [1, 2, 3, 5, 7, 13, 16, 31, 64, 97, 128, 129, 256, 512, 1024, 4096, 1_000_000];

/** Feeds `text` through a fresh detector in fixed-size chunks. */
function detect(text: string, chunk: number): string | null {
	const detector = new ThinkingLoopDetector(false);
	for (let i = 0; i < text.length; i += chunk) {
		const hit = detector.push(text.slice(i, i + chunk));
		if (hit) return hit;
	}
	return detector.flush();
}

/** The verdict must be a function of the text alone, never of the chunking. */
function verdicts(text: string): Set<string> {
	return new Set(CHUNK_SIZES.map(chunk => detect(text, chunk) ?? "(none)"));
}

const ASSERT_LINE = "  expect(parseHeader(input)).toEqual(expectedHeader);\n";
const CSV_ROW = "2026-09-23T12:00:00Z,worker-7,heartbeat,ok,0,0,0\n";

test.each([
	[
		"six identical assertion lines",
		`Repeated block:\n\n\`\`\`ts\n${ASSERT_LINE.repeat(6)}\`\`\`\n\nThat is the duplication.\n`,
	],
	["twenty identical assertion lines", `\`\`\`ts\n${ASSERT_LINE.repeat(20)}\`\`\`\n`],
	["six identical csv rows", `Rows:\n\n\`\`\`csv\n${CSV_ROW.repeat(6)}\`\`\`\n\nend\n`],
	["a long padded token", `Paragraph with a long repeated token: ${"A".repeat(240)} and the text continues.\n`],
	["a rule of dashes", `Banner:\n\n${"=".repeat(300)}\n\ndone\n`],
])("keeps legitimate repetition: %s", (_name, text) => {
	expect(verdicts(text)).toEqual(new Set(["(none)"]));
});

test.each([
	["a repeated sentence", `Let me think. ${"I need to check the file again. ".repeat(200)}`],
	["a repeated short cycle", `start ${"abcdefgh".repeat(400)}`],
	["degenerate single-token output", `思考: ${"了".repeat(2000)}`],
	["forty identical csv rows", `Rows:\n\n\`\`\`csv\n${CSV_ROW.repeat(40)}\`\`\`\n`],
])("still flags a runaway loop: %s", (_name, text) => {
	const seen = verdicts(text);
	expect(seen.size).toBe(1);
	expect([...seen][0]).toMatch(/^repeated an exact \d+-character cycle \d+× back-to-back$/);
});

test("varied prose is never flagged", () => {
	const prose = Array.from(
		{ length: 120 },
		(_, i) =>
			`Paragraph ${i} explores option ${(i * 7) % 13} against budget ${(i * 31) % 97} with note ${(i * 3) % 29}.`,
	).join(" ");
	expect(verdicts(prose)).toEqual(new Set(["(none)"]));
});

test("the same loop is reported identically however the stream is chunked", () => {
	// Chunk boundaries used to decide the outcome outright: the scan ran every
	// 128 characters of *delta*, so a cycle was caught or missed depending on
	// where the provider happened to split the stream.
	const text = `prefix ${"repeat this exact clause. ".repeat(120)}`;
	const perChunk = CHUNK_SIZES.map(chunk => detect(text, chunk));
	expect(new Set(perChunk).size).toBe(1);
	expect(perChunk[0]).not.toBeNull();
});

test("a loop is detected even when unrelated text follows it", () => {
	const text = `${"stuck on the same clause. ".repeat(120)}\n\nand then something else entirely happened.\n`;
	expect(verdicts(text).size).toBe(1);
	expect([...verdicts(text)][0]).toMatch(/repeated an exact/);
});

test("thinkingLoopDetail recovers the detector's wording from a guarded turn", () => {
	const detail = "repeated an exact 54-character cycle 5× back-to-back";
	const errorMessage = `Thinking loop detected: the model repeated near-identical content (${detail}). Treating as a stream stall and retrying.`;
	expect(thinkingLoopDetail(errorMessage)).toBe(detail);
});

test("thinkingLoopDetail ignores unrelated failures", () => {
	expect(thinkingLoopDetail("500 upstream exploded (type=server_error)")).toBeUndefined();
	expect(thinkingLoopDetail(undefined)).toBeUndefined();
});
