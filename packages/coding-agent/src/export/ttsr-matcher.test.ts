import { expect, test } from "bun:test";
import {
	compileLegacyProgram,
	compileMatchProgram,
	evaluateProgram,
	MatchContext,
	type MatchEvidence,
	type MatchInput,
	matchProgram,
	mayMatch,
	prepareProgram,
	type RuleMatchSpec,
} from "./ttsr-matcher";

async function run(spec: RuleMatchSpec, input: MatchInput): Promise<MatchEvidence | undefined> {
	const { program, errors } = compileMatchProgram(spec, "test-rule");
	expect(errors).toEqual([]);
	if (!program) throw new Error("program did not compile");
	const ctx = new MatchContext(input);
	await prepareProgram(program, ctx);
	return evaluateProgram(program, ctx);
}

const TS_FILE = ["// cast it as any when stuck", 'const note = "as any";', "const real = value as any;"].join("\n");

test("a regex constrained to code ignores the same text in comments and strings", async () => {
	const spec = { regex: "\\bas any\\b", in: "code" };
	const evidence = await run(spec, { text: TS_FILE, source: "tool", lang: "ts", filePaths: ["src/a.ts"] });
	expect(evidence?.snippets).toEqual([{ line: 3, text: "const real = value as any;" }]);

	const commentOnly = ["// cast as any", 'const s = "as any";'].join("\n");
	expect(await run(spec, { text: commentOnly, source: "tool", lang: "ts", filePaths: ["src/a.ts"] })).toBeUndefined();
});

test("an unclassifiable buffer fails a region-constrained condition closed", async () => {
	const evidence = await run({ regex: "\\bas any\\b", in: "code" }, { text: TS_FILE, source: "tool" });
	expect(evidence).toBeUndefined();
	// …while the same condition without `in:` still matches the raw buffer.
	expect(await run({ regex: "\\bas any\\b" }, { text: TS_FILE, source: "tool" })).toBeDefined();
});

test("all/not expresses an escape hatch that suppresses the rule", async () => {
	const spec = {
		all: [{ regex: "\\bas any\\b", in: "code" }, { not: { regex: "@ts-expect-error|biome-ignore" } }],
	};
	const input = { text: TS_FILE, source: "tool", lang: "ts", filePaths: ["src/a.ts"] } satisfies MatchInput;
	expect(await run(spec, input)).toBeDefined();
	expect(await run(spec, { ...input, text: `// biome-ignore lint: needed\n${TS_FILE}` })).toBeUndefined();
});

test("count only fires once the buffer holds enough distinct matches", async () => {
	const spec = { regex: "CHECKLIST", count: 3 };
	expect(await run(spec, { text: "CHECKLIST a\nCHECKLIST b", source: "text" })).toBeUndefined();
	const evidence = await run(spec, { text: "CHECKLIST a\nCHECKLIST b\nCHECKLIST c", source: "text" });
	expect(evidence?.snippets).toHaveLength(3);
});

test("a lang test routes the same rule to ast on known languages and regex elsewhere", async () => {
	const spec = {
		any: [
			{ all: [{ lang: ["ts", "tsx"] }, { ast: "$X as any" }] },
			{ all: [{ not: { lang: ["ts", "tsx"] } }, { regex: "\\bas any\\b" }] },
		],
	};
	const tsHit = await run(spec, { text: TS_FILE, source: "tool", lang: "ts", filePaths: ["a.ts"] });
	expect(tsHit?.snippets).toEqual([{ line: 3, text: "const real = value as any;" }]);
	// Python buffer: the ast branch cannot apply, the regex branch still does.
	const pyText = 'code = "const x = v as any;"';
	expect(await run(spec, { text: pyText, source: "tool", lang: "py", filePaths: ["cell.0.py"] })).toBeDefined();
	// A ts buffer whose only occurrences are a comment and a string matches neither branch.
	const benign = ["// as any", 'const s = "as any";'].join("\n");
	expect(await run(spec, { text: benign, source: "tool", lang: "ts", filePaths: ["a.ts"] })).toBeUndefined();
});

test("notHas keeps only ast matches that lack an inner condition", async () => {
	const spec = { ast: "try { $$$B } catch ($E) { $$$H }", notHas: { regex: "logger\\.|console\\." } };
	const source = [
		"try { risky(); } catch (error) { logger.error(error); }",
		"try { other(); } catch (error) { }",
	].join("\n");
	const evidence = await run(spec, { text: source, source: "tool", lang: "ts", filePaths: ["a.ts"] });
	expect(evidence?.snippets).toEqual([{ line: 2, text: "try { other(); } catch (error) { }" }]);
});

test("inside restricts a regex to spans of an ast match", async () => {
	const source = ["function keep() {\n\tconst v = value as any;\n}", "const outside = other as any;"].join("\n");
	const spec = { regex: "\\bas any\\b", inside: { ast: "function $N() { $$$B }" } };
	const evidence = await run(spec, { text: source, source: "tool", lang: "ts", filePaths: ["a.ts"] });
	expect(evidence?.snippets).toEqual([{ line: 2, text: "const v = value as any;" }]);
});

test("where constrains ast metavariables", async () => {
	const source = ["function getName() { return this.name; }", "function computeTotal() { return this.total; }"].join(
		"\n",
	);
	const spec = { ast: "function $NAME() { return $EXPR; }", where: { NAME: "^get" } };
	const evidence = await run(spec, { text: source, source: "tool", lang: "ts", filePaths: ["a.ts"] });
	expect(evidence?.snippets).toEqual([{ line: 1, text: "function getName() { return this.name; }" }]);
});

test("path narrows a condition to matching files", async () => {
	const spec = { all: [{ path: "**/*.test.ts" }, { regex: "vi\\.useFakeTimers" }] };
	const text = "vi.useFakeTimers();";
	expect(await run(spec, { text, source: "tool", lang: "ts", filePaths: ["src/a.test.ts"] })).toBeDefined();
	expect(await run(spec, { text, source: "tool", lang: "ts", filePaths: ["src/a.ts"] })).toBeUndefined();
});

test("prose conditions separate fenced code from assistant prose", async () => {
	const text = ["I will avoid `as any` here.", "", "```ts", "const v = x as any;", "```"].join("\n");
	const mention = await run({ regex: "as any", in: "prose" }, { text, source: "text" });
	expect(mention?.snippets).toEqual([{ line: 1, text: "I will avoid `as any` here." }]);
	const inCode = await run({ regex: "as any", in: "code" }, { text, source: "text" });
	expect(inCode?.snippets).toEqual([{ line: 4, text: "const v = x as any;" }]);
});

test("evidence line numbers survive multi-byte characters ahead of an ast match", async () => {
	const source = ['const label = "héllo — wörld";', "const real = value as any;"].join("\n");
	const evidence = await run({ ast: "$X as any" }, { text: source, source: "tool", lang: "ts", filePaths: ["a.ts"] });
	expect(evidence?.snippets).toEqual([{ line: 2, text: "const real = value as any;" }]);
});

test("legacy condition and astCondition compile into one any-branch program", async () => {
	const { program, errors } = compileLegacyProgram(["\\bas any\\b"], ["$X!"]);
	expect(errors).toEqual([]);
	expect(program?.needsAst).toBe(true);
	const ctx = new MatchContext({ text: "const a = b as any;", source: "tool", lang: "ts", filePaths: ["a.ts"] });
	await prepareProgram(program!, ctx);
	expect(evaluateProgram(program!, ctx)).toBeDefined();
});

test("a legacy program with only invalid regexes reports the error and yields nothing", () => {
	const { program, errors } = compileLegacyProgram(["(unclosed"], undefined);
	expect(program).toBeUndefined();
	expect(errors.join(" ")).toContain("invalid regex");
});

test("compile rejects malformed expressions with actionable errors", () => {
	expect(compileMatchProgram({ regexp: "x" }, "r").errors[0]).toContain("needs one of");
	expect(compileMatchProgram({ regex: "x", ast: "y" }, "r").errors[0]).toContain("conflicting keys");
	expect(compileMatchProgram({ regex: "x", nope: 1 }, "r").errors[0]).toContain('unknown key "nope"');
	expect(compileMatchProgram({ lang: "ts", count: 2 }, "r").errors[0]).toContain("only applies to regex/ast");
	expect(compileMatchProgram({ regex: "x", has: { lang: "ts" } }, "r").errors[0]).toContain("needs a regex/ast");
	expect(compileMatchProgram({ all: [] }, "r").errors[0]).toContain("at least one condition");
	expect(compileMatchProgram({ if: { lang: "ts" } }, "r").errors[0]).toContain("needs a then: branch");
	expect(compileMatchProgram({ regex: "x", else: { regex: "y" } }, "r").errors[0]).toContain("only applies to if");
	expect(compileMatchProgram({ did: {} }, "r").errors[0]).toContain("needs one of tool, path, args");
	expect(compileMatchProgram({ did: { ran: "bash" } }, "r").errors[0]).toContain('unknown key "ran"');
	expect(compileMatchProgram({ did: { tool: "read", within: 0 } }, "r").errors[0]).toContain("positive integer");
});

test("the scan prefilter rejects buffers that cannot match and passes the rest", () => {
	const { program } = compileMatchProgram({ all: [{ lang: "ts" }, { regex: "useFakeTimers\\(" }] }, "r");
	expect(mayMatch(program!, "const x = 1;")).toBe(false);
	expect(mayMatch(program!, "vi.useFakeTimers();")).toBe(true);
	const { program: broad } = compileMatchProgram({ regex: "(?i)checklist" }, "r");
	expect(mayMatch(broad!, "anything")).toBe(true);
});

test("an unresolved ast leaf never decides a match by itself", async () => {
	const source = "const bad = value as any;";
	const input = { text: source, source: "tool", lang: "ts", filePaths: ["a.ts"] } satisfies MatchInput;
	// Same programs, evaluated without prepareProgram (the regex-only fast path).
	const raw = (spec: RuleMatchSpec) => {
		const { program, errors } = compileMatchProgram(spec, "test-rule");
		expect(errors).toEqual([]);
		return evaluateProgram(program!, new MatchContext(input));
	};
	// `not` over an unresolved ast leaf must not read as "absent".
	expect(raw({ all: [{ regex: "value" }, { not: { ast: "$X as any" } }] })).toBeUndefined();
	// An already-satisfied regex branch still decides an `any`.
	expect(raw({ any: [{ regex: "value" }, { ast: "$X as any" }] })).toBeDefined();
	// A bare ast condition is simply not proven yet.
	expect(raw({ ast: "$X as any" })).toBeUndefined();
	// Once resolved, absence is knowable and the `not` branch matches.
	expect(await run({ all: [{ regex: "value" }, { not: { ast: "$X!" } }] }, input)).toBeDefined();
});

test("in accepts a list of regions, which keeps code and literals but drops comments", async () => {
	const cell = ["# never write as any in a cell", 'SCRIPT = "const a = v as any;"', "marker = 'as any'"].join("\n");
	const spec = { regex: "\\bas any\\b", in: ["code", "string"] };
	const evidence = await run(spec, { text: cell, source: "tool", lang: "py", filePaths: ["cell.0.py"] });
	expect(evidence?.snippets.map(snippet => snippet.line)).toEqual([2, 3]);
	expect(compileMatchProgram({ regex: "x", in: ["code", "nonsense"] }, "r").errors[0]).toContain('got "nonsense"');
});

test("the prefilter never rejects a buffer the program would match", () => {
	const alternation = compileMatchProgram(
		{ regex: "(?m)(?:(?::|\\bas\\b|=|<|,|\\||&|\\?|\\bextends)\\s*)any\\b" },
		"r",
	).program!;
	// "extends" and "as" sit inside an alternation, so neither is required; "any" is.
	expect(alternation.literals).toEqual(["any"]);
	expect(mayMatch(alternation, "const v = value as any;")).toBe(true);
	expect(mayMatch(alternation, "const v = value as unknown;")).toBe(false);

	const optional = compileMatchProgram({ regex: "colou?r" }, "r").program!;
	expect(mayMatch(optional, "color: red")).toBe(true);

	const topLevelAlternation = compileMatchProgram({ regex: "foo|bar" }, "r").program!;
	expect(topLevelAlternation.literals).toEqual([]);
	expect(mayMatch(topLevelAlternation, "bar")).toBe(true);
});

test("a language-gated ast rule never parses a buffer of another language", async () => {
	const { program } = compileMatchProgram(
		{ all: [{ lang: ["go"] }, { ast: "for $I := 0; $I < $N; $I++ { $$$B }" }] },
		"r",
	);
	const ctx = new MatchContext({
		text: "for (let i = 0; i < n; i++) {}",
		source: "tool",
		lang: "ts",
		filePaths: ["a.ts"],
	});
	expect(await matchProgram(program!, ctx)).toBeUndefined();
	// The lang test already decided it: no AST leaf was ever requested.
	expect(ctx.needsAstResolution()).toBe(false);

	const goCtx = new MatchContext({
		text: "for i := 0; i < n; i++ { use(i) }",
		source: "tool",
		lang: "go",
		filePaths: ["a.go"],
	});
	expect(await matchProgram(program!, goCtx)).toBeDefined();
});

test("a path leaf matches whichever spelling the tool call used", async () => {
	const spec = { path: "src/**/*.ts" };
	const input = { text: "x", source: "tool", cwd: "/repo" } satisfies MatchInput;
	for (const filePath of ["src/a.ts", "./src/a.ts", "/repo/src/a.ts"]) {
		expect(await run(spec, { ...input, filePaths: [filePath] })).toBeDefined();
	}
	expect(await run(spec, { ...input, filePaths: ["/elsewhere/src/a.ts"] })).toBeUndefined();
});

test("outside: cwd fires on a write that escapes the workspace and stays quiet inside it", async () => {
	const spec = { path: { outside: "cwd" } };
	const input = { text: "x", source: "tool", cwd: "/repo" } satisfies MatchInput;
	expect(await run(spec, { ...input, filePaths: ["/etc/hosts"] })).toBeDefined();
	expect(await run(spec, { ...input, filePaths: ["../sibling/a.ts"] })).toBeDefined();
	expect(await run(spec, { ...input, filePaths: ["src/a.ts"] })).toBeUndefined();
	expect(await run(spec, { ...input, filePaths: ["/repo"] })).toBeUndefined();
	// Fail closed: a call whose paths are unknown cannot be proven to escape.
	expect(await run(spec, input)).toBeUndefined();
	// A scheme URI has no filesystem location, so it neither escapes nor stays.
	expect(await run(spec, { ...input, filePaths: ["https://example.com/a.ts"] })).toBeUndefined();
});

test("outside accepts several allowed roots and fires only when the path escapes all of them", async () => {
	const spec = { path: { outside: ["cwd", "/tmp"] } };
	const input = { text: "x", source: "tool", cwd: "/repo" } satisfies MatchInput;
	expect(await run(spec, { ...input, filePaths: ["/tmp/scratch.ts"] })).toBeUndefined();
	expect(await run(spec, { ...input, filePaths: ["/var/log/a.ts"] })).toBeDefined();
});

test("one target path must satisfy every path predicate, not one each", async () => {
	const spec = { path: { glob: "**/*.md", under: "docs" } };
	const input = { text: "x", source: "tool", cwd: "/repo" } satisfies MatchInput;
	expect(await run(spec, { ...input, filePaths: ["docs/guide.md"] })).toBeDefined();
	expect(await run(spec, { ...input, filePaths: ["docs/guide.txt", "notes/guide.md"] })).toBeUndefined();
});

test("a path regex tests the written spelling and the resolved absolute path", async () => {
	const input = { text: "x", source: "tool", cwd: "/repo" } satisfies MatchInput;
	expect(await run({ path: { regex: "\\.gen\\.ts$" } }, { ...input, filePaths: ["src/api.gen.ts"] })).toBeDefined();
	expect(await run({ path: { regex: "^/repo/src/" } }, { ...input, filePaths: ["src/api.ts"] })).toBeDefined();
	expect(await run({ path: { regex: "^/repo/src/" } }, { ...input, filePaths: ["docs/api.ts"] })).toBeUndefined();
});

test("path mappings reject unknown keys and empty predicate sets", () => {
	expect(compileMatchProgram({ path: { glob: "*.ts", inside: "x" } }, "r").errors.join(" ")).toContain("unknown key");
	expect(compileMatchProgram({ path: {} }, "r").errors.join(" ")).toContain("needs one of");
});

test("an llm leaf stays unknown until a judge answers it", async () => {
	const { program } = compileMatchProgram({ llm: "Does this hold a literal table?" }, "r");
	expect(program?.needsJudge).toBe(true);
	const asked: string[] = [];
	const ctx = new MatchContext({
		text: "const m = new Map([['a', 1]]);",
		source: "tool",
		judge: async request => {
			asked.push(request.question);
			return true;
		},
	});
	// The synchronous pass can neither fire the rule nor rule it out.
	expect(evaluateProgram(program!, ctx)).toBeUndefined();
	expect(ctx.needsJudgeResolution()).toBe(true);
	expect(asked).toEqual([]);

	expect(await matchProgram(program!, ctx)).toBeDefined();
	expect(asked).toEqual(["Does this hold a literal table?"]);
	// The verdict is cached, so a re-evaluation costs nothing.
	expect(await matchProgram(program!, ctx)).toBeDefined();
	expect(asked).toHaveLength(1);
});

test("a judge is only asked once the cheaper conditions in the rule have matched", async () => {
	const { program } = compileMatchProgram(
		{ all: [{ llm: "Is this a literal table?" }, { regex: "new Map\\b" }, { lang: ["ts"] }] },
		"r",
	);
	let asked = 0;
	const judge = async () => {
		asked++;
		return true;
	};
	const miss = new MatchContext({ text: "const s = new Set();", source: "tool", lang: "ts", judge });
	expect(await matchProgram(program!, miss)).toBeUndefined();
	expect(asked).toBe(0);

	const wrongLang = new MatchContext({ text: "const m = new Map();", source: "tool", lang: "go", judge });
	expect(await matchProgram(program!, wrongLang)).toBeUndefined();
	expect(asked).toBe(0);

	const hit = new MatchContext({ text: "const m = new Map();", source: "tool", lang: "ts", judge });
	expect(await matchProgram(program!, hit)).toBeDefined();
	expect(asked).toBe(1);
});

test("an any branch that already matched never consults its judge", async () => {
	const { program } = compileMatchProgram({ any: [{ llm: "Is this suspicious?" }, { regex: "CHECKLIST" }] }, "r");
	let asked = 0;
	const ctx = new MatchContext({
		text: "CHECKLIST: finish",
		source: "text",
		judge: async () => {
			asked++;
			return true;
		},
	});
	expect(await matchProgram(program!, ctx)).toBeDefined();
	expect(asked).toBe(0);
});

test("without a judge an llm leaf settles as no match instead of blocking the program", async () => {
	const { program } = compileMatchProgram(
		{ all: [{ regex: "CHECKLIST" }, { llm: "Is this a real CHECKLIST?" }] },
		"r",
	);
	const ctx = new MatchContext({ text: "CHECKLIST: finish", source: "text" });
	expect(await matchProgram(program!, ctx)).toBeUndefined();
	expect(await prepareProgram(program!, ctx).then(() => evaluateProgram(program!, ctx))).toBeUndefined();
});

test("llm leaves carry a model role chain and reject model: on other leaves", () => {
	const { program } = compileMatchProgram({ llm: "Is it?", model: "smol" }, "r");
	expect(program?.description).toBe('llm "Is it?" (smol)');
	expect(compileMatchProgram({ llm: "Is it?" }, "r").program?.description).toBe('llm "Is it?" (tiny→smol)');
	expect(compileMatchProgram({ regex: "x", model: "smol" }, "r").errors.join(" ")).toContain("only applies to llm");
});

test("if applies one branch or the other, and quotes only the branch it took", async () => {
	const spec = { if: { lang: "ts" }, then: { regex: "\\bas any\\b" }, else: { regex: "interface\\{\\}" } };
	const ts = { text: "const real = value as any;", source: "tool", lang: "ts" } satisfies MatchInput;
	const go = { text: "func handle(v interface{}) {}", source: "tool", lang: "go" } satisfies MatchInput;
	expect((await run(spec, ts))?.snippets).toEqual([{ line: 1, text: "const real = value as any;" }]);
	expect((await run(spec, go))?.snippets).toEqual([{ line: 1, text: "func handle(v interface{}) {}" }]);
	// Neither branch applies under the other's guard.
	expect(await run(spec, { ...ts, text: go.text })).toBeUndefined();
	expect(await run(spec, { ...go, text: ts.text })).toBeUndefined();
});

test("a failed guard skips its branch, so the judge behind it is never asked", async () => {
	const { program } = compileMatchProgram(
		{ if: { path: { outside: "cwd" } }, then: { llm: "Is this writing a secret?" } },
		"r",
	);
	let asked = 0;
	const judge = async () => {
		asked++;
		return true;
	};
	const input = { text: "token = load()", source: "tool", cwd: "/repo", judge } satisfies MatchInput;
	const inside = new MatchContext({ ...input, filePaths: ["src/a.ts"] });
	expect(await matchProgram(program!, inside)).toBeUndefined();
	expect(asked).toBe(0);

	const escaped = new MatchContext({ ...input, filePaths: ["/etc/secrets.ts"] });
	expect(await matchProgram(program!, escaped)).toBeDefined();
	expect(asked).toBe(1);
});

test("a judged guard reveals the ast leaf in its branch once the verdict is in", async () => {
	const { program } = compileMatchProgram({ if: { llm: "Is this a test file?" }, then: { ast: "$X as any" } }, "r");
	const input = { text: "const bad = value as any;", source: "tool", lang: "ts" } satisfies MatchInput;
	const yes = new MatchContext({ ...input, judge: async () => true });
	// An unresolved guard leaves the branch unreachable, so nothing decides synchronously.
	expect(evaluateProgram(program!, yes)).toBeUndefined();
	// The judge settles the guard, which is what exposes the branch's ast leaf to the next round.
	expect(await matchProgram(program!, yes)).toBeDefined();

	const no = new MatchContext({ ...input, judge: async () => false });
	expect(await matchProgram(program!, no)).toBeUndefined();
});

test("the prefilter keeps buffers either branch of an if/else could match", () => {
	const branching = compileMatchProgram(
		{ if: { lang: "go" }, then: { regex: "interface\\{\\}" }, else: { regex: "\\bas any\\b" } },
		"r",
	).program!;
	expect(mayMatch(branching, "func f(v interface{}) {}")).toBe(true);
	expect(mayMatch(branching, "const v = value as any;")).toBe(true);
	expect(mayMatch(branching, "const v = 1;")).toBe(false);
	// Without an else branch, only what the branch requires can match.
	const guarded = compileMatchProgram({ if: { lang: "go" }, then: { regex: "interface\\{\\}" } }, "r").program!;
	expect(mayMatch(guarded, "const v = value as any;")).toBe(false);
	expect(mayMatch(guarded, "func f(v interface{}) {}")).toBe(true);
});

const PLOT = { text: "import matplotlib.pyplot as plt", source: "tool", lang: "py", cwd: "/repo" } satisfies MatchInput;

test("did keeps a rule quiet for an agent that already read the skill", async () => {
	// A skill is read as `skill://viz`; its files as `skill://viz/<file>`.
	const skill = ["skill://viz", "skill://viz/**"];
	const spec = {
		all: [{ path: "**/*.py" }, { regex: "import matplotlib" }, { not: { did: { tool: "read", path: skill } } }],
	};
	const input = { ...PLOT, filePaths: ["charts/plot.py"] };
	// Nothing read yet, so the rule has something to say.
	expect(await run(spec, input)).toBeDefined();
	// …and it still does after a read of some other skill.
	expect(await run(spec, { ...input, history: () => [{ name: "read", paths: ["skill://tables"] }] })).toBeDefined();
	// Once the skill itself has been read, the rule goes quiet.
	expect(await run(spec, { ...input, history: () => [{ name: "read", paths: ["skill://viz"] }] })).toBeUndefined();
	expect(
		await run(spec, { ...input, history: () => [{ name: "read", paths: ["skill://viz/examples.md"] }] }),
	).toBeUndefined();
	// A different tool naming the same path is a different act.
	expect(await run(spec, { ...input, history: () => [{ name: "grep", paths: ["skill://viz"] }] })).toBeDefined();
});

test("a did gate spares the judge on buffers the session already handled", async () => {
	const { program } = compileMatchProgram(
		{
			all: [
				{ llm: "Does this plot need the house style?" },
				{ not: { did: { tool: "read", path: "skill://viz" } } },
			],
		},
		"r",
	);
	let asked = 0;
	const judge = async () => {
		asked++;
		return true;
	};
	const read = new MatchContext({ ...PLOT, judge, history: () => [{ name: "read", paths: ["skill://viz"] }] });
	expect(await matchProgram(program!, read)).toBeUndefined();
	expect(asked).toBe(0);

	const skipped = new MatchContext({ ...PLOT, judge });
	expect(await matchProgram(program!, skipped)).toBeDefined();
	expect(asked).toBe(1);
});

test("did tests the arguments a call was made with, and within bounds how far back it looks", async () => {
	const history = () => [
		{ name: "bash", args: JSON.stringify({ command: "bun test packages/coding-agent" }) },
		{ name: "read", paths: ["docs/plan.md"] },
		{ name: "edit", paths: ["src/a.ts"] },
	];
	const input = { text: "x", source: "text", cwd: "/repo", history } satisfies MatchInput;
	expect(await run({ did: { tool: "bash", args: "\\bbun test\\b" } }, input)).toBeDefined();
	expect(await run({ did: { tool: "bash", args: "bun run release" } }, input)).toBeUndefined();
	// The docs read is the second of three calls, so a two-call window still sees it.
	expect(await run({ did: { path: { under: "docs" }, within: 2 } }, input)).toBeDefined();
	expect(await run({ did: { path: { under: "docs" }, within: 1 } }, input)).toBeUndefined();
});

test("without a tracked history a did test reports that the session did nothing", async () => {
	const input = { text: "x", source: "text" } satisfies MatchInput;
	expect(await run({ did: "read" }, input)).toBeUndefined();
	// Which is what makes a `not: { did: … }` rule fire in `proto ttsr test` and bulk scans.
	expect(await run({ not: { did: "read" } }, input)).toBeDefined();
});
