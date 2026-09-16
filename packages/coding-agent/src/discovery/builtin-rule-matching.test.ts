import { expect, test } from "bun:test";
import type { Rule } from "../capability/rule";
import { TtsrManager, type TtsrMatchContext } from "../export/ttsr";
import { BUILTIN_RULE_SOURCES } from "./builtin-rules";
import { buildRuleFromMarkdown, createSourceMeta } from "./helpers";

function builtinRule(name: string): Rule {
	const source = BUILTIN_RULE_SOURCES.find(entry => entry.name === name);
	if (!source) throw new Error(`no bundled rule named ${name}`);
	const virtualPath = `builtin-defaults:${name}.md`;
	return buildRuleFromMarkdown(
		name,
		source.content,
		virtualPath,
		createSourceMeta("builtin-defaults", virtualPath, "user"),
		{
			ruleName: name,
		},
	);
}

/**
 * Run one buffer through the same two-phase path the session uses for a bash
 * tool call. Rules whose heuristic branch ends in an `llm:` gate get a stub
 * judge, so these cases test the lexical and structural gating around it;
 * `judgeGateDecidesTheHeuristicBranch` covers the gate itself.
 */
async function fires(ruleName: string, filePath: string, text: string, verdict = true): Promise<boolean> {
	const manager = new TtsrManager();
	expect(manager.addRule(builtinRule(ruleName))).toBe(true);
	const context: TtsrMatchContext = {
		source: "tool",
		toolName: "bash",
		filePaths: [filePath],
		streamKey: `toolcall:${filePath}`,
		settled: true,
		judge: async () => verdict,
	};
	if (manager.checkSnapshot(text, context).length > 0) return true;
	return (await manager.checkAsyncSnapshot(text, context)).length > 0;
}

test("ts-no-any reads TypeScript syntactically: type positions fire, comments and strings do not", async () => {
	expect(await fires("ts-no-any", "src/a.ts", "const root = el as any;")).toBe(true);
	expect(await fires("ts-no-any", "src/a.ts", "function readId(value: any) { return value.id; }")).toBe(true);
	expect(await fires("ts-no-any", "src/a.ts", "const map: Record<string, any> = {};")).toBe(true);
	expect(await fires("ts-no-any", "src/a.ts", "// never write value as any here\nconst ok: unknown = 1;")).toBe(false);
	expect(await fires("ts-no-any", "src/a.ts", 'const doc = "pass it as any string";')).toBe(false);
});

test("ts-no-any still catches TypeScript embedded in a kernel cell, but not a cell comment", async () => {
	expect(await fires("ts-no-any", "cell.0.py", 'src = "const root = el as any;"\nPath("a.ts").write_text(src)')).toBe(
		true,
	);
	expect(await fires("ts-no-any", "cell.0.py", "# reviewers keep asking for value as any\nrun()")).toBe(false);
});

test("ts-bare-catch fires on an underscore-bound handler, not on a used binding or the words in prose", async () => {
	expect(await fires("ts-bare-catch", "src/a.ts", "try { risky(); } catch (_error) { fallback(); }")).toBe(true);
	expect(await fires("ts-bare-catch", "src/a.ts", "try { risky(); } catch (error) { report(error); }")).toBe(false);
	expect(await fires("ts-bare-catch", "src/a.ts", "// prefer catch (_error) over a bare catch\nrun();")).toBe(false);
});

test("go-range-int fires on a Go counting loop and ignores the identical text in another language", async () => {
	expect(await fires("go-range-int", "main.go", "func main() {\n\tfor i := 0; i < n; i++ {\n\t\tuse(i)\n\t}\n}")).toBe(
		true,
	);
	expect(await fires("go-range-int", "cell.0.py", 'doc = "for i := 0; i < n; i++ { use(i) }"')).toBe(false);
});

test("rs-box-leak fires on real Rust code and not on a doc comment about it", async () => {
	expect(await fires("rs-box-leak", "src/lib.rs", "let state = Box::leak(Box::new(state));")).toBe(true);
	expect(
		await fires("rs-box-leak", "src/lib.rs", "// never reach for Box::leak here\nlet state = Arc::new(state);"),
	).toBe(false);
	expect(await fires("rs-box-leak", "src/lib.rs", 'let name = "Box::leak";')).toBe(false);
});

test("go-add-cleanup is code-only in Go and catches embedded source", async () => {
	expect(await fires("go-add-cleanup", "main.go", "runtime.SetFinalizer(obj, cleanup)")).toBe(true);
	expect(await fires("go-add-cleanup", "main.go", "// runtime.SetFinalizer(obj, cleanup)")).toBe(false);
	expect(await fires("go-add-cleanup", "cell.0.py", 'src = "runtime.SetFinalizer(obj, cleanup)"')).toBe(true);
});

test("go-bench-loop matches benchmark loops but not comments", async () => {
	const snippet = "func BenchmarkEncode(b *testing.B) { for i := 0; i < b.N; i++ { Encode(input) } }";
	expect(await fires("go-bench-loop", "bench_test.go", snippet)).toBe(true);
	expect(await fires("go-bench-loop", "bench_test.go", `// ${snippet}`)).toBe(false);
});

test("go-exp-promoted matches import strings but not comments", async () => {
	const snippet = 'import "golang.org/x/exp/slices"';
	expect(await fires("go-exp-promoted", "main.go", snippet)).toBe(true);
	expect(await fires("go-exp-promoted", "main.go", 'import "golang.org/x/exp/maps"')).toBe(true);
	expect(await fires("go-exp-promoted", "main.go", `// ${snippet}`)).toBe(false);
});

test("go-ioutil matches import strings but not comments", async () => {
	const snippet = 'import "io/ioutil"';
	expect(await fires("go-ioutil", "main.go", snippet)).toBe(true);
	expect(await fires("go-ioutil", "main.go", `// ${snippet}`)).toBe(false);
});

test("go-join-hostport is code-only in Go and catches embedded source", async () => {
	const snippet = 'fmt.Sprintf("%s:%d", host, port)';
	expect(await fires("go-join-hostport", "main.go", snippet)).toBe(true);
	expect(await fires("go-join-hostport", "main.go", `// ${snippet}`)).toBe(false);
	expect(await fires("go-join-hostport", "cell.0.py", `src = '${snippet}'`)).toBe(true);
});

test("go-new-expr matches pointer helpers but not comments", async () => {
	const snippet = "func boolPtr(v bool) *bool { return &v }";
	expect(await fires("go-new-expr", "ptr.go", snippet)).toBe(true);
	expect(await fires("go-new-expr", "ptr.go", `// ${snippet}`)).toBe(false);
});

test("go-rand-v2 matches the legacy import string but not comments", async () => {
	const snippet = 'import "math/rand"';
	expect(await fires("go-rand-v2", "main.go", snippet)).toBe(true);
	expect(await fires("go-rand-v2", "main.go", `// ${snippet}`)).toBe(false);
});

test("rs-future-prelude is code-only in Rust and catches embedded source", async () => {
	const snippet = "fn fetch() -> impl std::future::Future<Output = ()> { todo!() }";
	expect(await fires("rs-future-prelude", "src/lib.rs", snippet)).toBe(true);
	expect(await fires("rs-future-prelude", "src/lib.rs", `// ${snippet}`)).toBe(false);
	expect(await fires("rs-future-prelude", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("rs-lazylock is code-only in Rust and catches embedded source", async () => {
	const snippet = "use once_cell::sync::Lazy;";
	expect(await fires("rs-lazylock", "src/lib.rs", snippet)).toBe(true);
	expect(await fires("rs-lazylock", "src/lib.rs", `// ${snippet}`)).toBe(false);
	expect(await fires("rs-lazylock", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("rs-match-ergonomics is code-only in Rust and catches embedded source", async () => {
	const snippet = "match value { Some(ref item) => item, None => {} }";
	expect(await fires("rs-match-ergonomics", "src/lib.rs", snippet)).toBe(true);
	expect(await fires("rs-match-ergonomics", "src/lib.rs", `// ${snippet}`)).toBe(false);
	expect(await fires("rs-match-ergonomics", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("rs-parking-lot is code-only in Rust and catches embedded source", async () => {
	const snippet = "let guard = data.lock().unwrap();";
	expect(await fires("rs-parking-lot", "src/lib.rs", snippet)).toBe(true);
	expect(await fires("rs-parking-lot", "src/lib.rs", `// ${snippet}`)).toBe(false);
	expect(await fires("rs-parking-lot", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("rs-result-type is code-only in Rust and catches embedded source", async () => {
	const snippet = "type Result<T> = std::result::Result<T, Error>;";
	expect(await fires("rs-result-type", "src/lib.rs", snippet)).toBe(true);
	expect(await fires("rs-result-type", "src/lib.rs", `// ${snippet}`)).toBe(false);
	expect(await fires("rs-result-type", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("ts-import-type is code-only in TypeScript and catches embedded source", async () => {
	const snippet = 'type Client = import("sdk").Client;';
	expect(await fires("ts-import-type", "src/client.ts", snippet)).toBe(true);
	expect(await fires("ts-import-type", "src/client.ts", `// ${snippet}`)).toBe(false);
	expect(await fires("ts-import-type", "cell.0.py", `src = '${snippet}'`)).toBe(true);
});

test("ts-no-deprecated-leftovers intentionally matches deprecation comments", async () => {
	expect(await fires("ts-no-deprecated-leftovers", "src/api.ts", "/** @deprecated Use loadSettings instead. */")).toBe(
		true,
	);
	expect(await fires("ts-no-deprecated-leftovers", "src/api.ts", "// old API marker without a deprecated tag")).toBe(
		false,
	);
});

test("ts-no-dynamic-import is code-only in TypeScript and catches embedded source", async () => {
	const snippet = 'const plugin = await import("./plugin");';
	expect(await fires("ts-no-dynamic-import", "src/load.ts", snippet)).toBe(true);
	expect(await fires("ts-no-dynamic-import", "src/load.ts", `// ${snippet}`)).toBe(false);
	expect(await fires("ts-no-dynamic-import", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("ts-no-inline-cast-access matches inline assertions but not comments", async () => {
	const snippet = "const content = (value as { content: unknown }).content;";
	expect(await fires("ts-no-inline-cast-access", "src/read.ts", snippet)).toBe(true);
	expect(await fires("ts-no-inline-cast-access", "src/read.ts", `// ${snippet}`)).toBe(false);
});

test("ts-no-local-is-record is code-only in TypeScript and catches embedded source", async () => {
	const snippet = "function isRecord(value: unknown): value is Record<string, unknown> { return true; }";
	expect(await fires("ts-no-local-is-record", "src/types.ts", snippet)).toBe(true);
	expect(await fires("ts-no-local-is-record", "src/types.ts", `// ${snippet}`)).toBe(false);
	expect(await fires("ts-no-local-is-record", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("ts-no-return-type is code-only in TypeScript and catches embedded source", async () => {
	const snippet = "type Value = ReturnType<typeof load>;";
	expect(await fires("ts-no-return-type", "src/types.ts", snippet)).toBe(true);
	expect(await fires("ts-no-return-type", "src/types.ts", `// ${snippet}`)).toBe(false);
	expect(await fires("ts-no-return-type", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("ts-no-test-timers is code-only in TypeScript and catches embedded source", async () => {
	const snippet = "await setTimeout(resolve, 100);";
	expect(await fires("ts-no-test-timers", "src/test.ts", snippet)).toBe(true);
	expect(await fires("ts-no-test-timers", "src/test.ts", `// ${snippet}`)).toBe(false);
	expect(await fires("ts-no-test-timers", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("ts-no-tiny-functions is code-only in TypeScript and catches embedded source", async () => {
	const snippet = "function double(value: number) { return value * 2; }";
	expect(await fires("ts-no-tiny-functions", "src/math.ts", snippet)).toBe(true);
	expect(await fires("ts-no-tiny-functions", "src/math.ts", `// ${snippet}`)).toBe(false);
	expect(await fires("ts-no-tiny-functions", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
	// An expression-bodied arrow is the other half of the rule…
	expect(await fires("ts-no-tiny-functions", "src/math.ts", "const double = (v: number) => v * 2;")).toBe(true);
	// …but a block-bodied arrow is an ordinary function, not a one-expression wrapper.
	expect(
		await fires(
			"ts-no-tiny-functions",
			"src/math.ts",
			"const run = (v: number) => {\n\tlog(v);\n\treturn v * 2;\n};",
		),
	).toBe(false);
});

test("ts-promise-with-resolvers is code-only in TypeScript and catches embedded source", async () => {
	const snippet = "return new Promise(resolve => resolve());";
	expect(await fires("ts-promise-with-resolvers", "src/task.ts", snippet)).toBe(true);
	expect(await fires("ts-promise-with-resolvers", "src/task.ts", `// ${snippet}`)).toBe(false);
	expect(await fires("ts-promise-with-resolvers", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("ts-redundant-clear-guard matches timer guards but not comments", async () => {
	const snippet = "if (timer) clearTimeout(timer);";
	expect(await fires("ts-redundant-clear-guard", "src/timers.ts", snippet)).toBe(true);
	expect(await fires("ts-redundant-clear-guard", "src/timers.ts", `// ${snippet}`)).toBe(false);
});

test("ts-set-map is code-only in TypeScript and catches embedded source", async () => {
	const snippet = "const values = new Set<string>();";
	expect(await fires("ts-set-map", "src/values.ts", snippet)).toBe(true);
	expect(await fires("ts-set-map", "src/values.ts", `// ${snippet}`)).toBe(false);
	expect(await fires("ts-set-map", "cell.0.py", `src = ${JSON.stringify(snippet)}`)).toBe(true);
});

test("every bundled rule registers with a compiled condition", () => {
	const manager = new TtsrManager();
	const registered: string[] = [];
	for (const source of BUILTIN_RULE_SOURCES) {
		const rule = builtinRule(source.name);
		if (rule.match === undefined && !rule.condition && !rule.astCondition) continue;
		expect(manager.addRule(rule)).toBe(true);
		registered.push(source.name);
	}
	expect(registered.length).toBeGreaterThan(0);
	for (const entry of manager.getEntries()) {
		expect(entry.program.description.length).toBeGreaterThan(0);
	}
});

test("the judge gate decides the heuristic branch that reads another language's buffer", async () => {
	const embedded = 'src = "const root = el as any;"\nPath("a.ts").write_text(src)';
	expect(await fires("ts-no-any", "cell.0.py", embedded, true)).toBe(true);
	// A buffer that only discusses the construct is what the judge is there to reject.
	expect(await fires("ts-no-any", "cell.0.py", embedded, false)).toBe(false);
	// The syntactic branch on real TypeScript never consults a judge.
	expect(await fires("ts-no-any", "src/a.ts", "const root = el as any;", false)).toBe(true);
});
