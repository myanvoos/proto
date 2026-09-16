import { expect, test } from "bun:test";
import { classifyRegions, type RegionKind, regionModeFor, spanRegionKind } from "./ttsr-regions";

function kindOf(source: string, lang: string, needle: string, occurrence = 0): RegionKind | undefined {
	const regions = classifyRegions(source, { kind: "code", lang });
	if (!regions) throw new Error(`no profile for ${lang}`);
	let index = -1;
	for (let seen = 0; seen <= occurrence; seen++) index = source.indexOf(needle, index + 1);
	if (index < 0) throw new Error(`needle ${needle} not found`);
	return spanRegionKind(regions, index, index + needle.length, "code");
}

test("typescript separates a real cast from the same words in a comment or string", () => {
	const source = ["// use as any here", 'const a = "cast as any";', "const b = value as any;"].join("\n");
	expect(kindOf(source, "ts", "as any", 0)).toBe("comment");
	expect(kindOf(source, "ts", "as any", 1)).toBe("string");
	expect(kindOf(source, "ts", "as any", 2)).toBe("code");
});

test("a regex literal holding a quote does not swallow the code after it", () => {
	const source = ["const re = /['\"]/;", "const b = value as any;"].join("\n");
	expect(kindOf(source, "ts", "as any")).toBe("code");
	expect(kindOf(source, "ts", "['\"]")).toBe("string");
});

test("division after an identifier is not a regex literal", () => {
	const source = ["const ratio = total / count;", 'const note = "as any";'].join("\n");
	expect(kindOf(source, "ts", "as any")).toBe("string");
});

test("template literals and their escapes classify as string", () => {
	const source = ["const t = `a $" + "{x} as any \\` still`;", "const c = value as any;"].join("\n");
	expect(kindOf(source, "ts", "as any", 0)).toBe("string");
	expect(kindOf(source, "ts", "as any", 1)).toBe("code");
});

test("rust lifetimes stay code while char and raw strings stay string", () => {
	const source = [
		"fn f<'a>(x: &'a str) -> &'a str {",
		'    let raw = r#"unwrap() here"#;',
		"    let c = 'x';",
		"    x.unwrap()",
		"}",
	].join("\n");
	expect(kindOf(source, "rs", "&'a str", 0)).toBe("code");
	expect(kindOf(source, "rs", "unwrap() here")).toBe("string");
	expect(kindOf(source, "rs", "x.unwrap()")).toBe("code");
});

test("rust block comments nest", () => {
	const source = ["/* outer /* inner */ still comment unwrap() */", "let v = value.unwrap();"].join("\n");
	expect(kindOf(source, "rs", "unwrap()", 0)).toBe("comment");
	expect(kindOf(source, "rs", "unwrap()", 1)).toBe("code");
});

test("python triple quotes and prefixed strings cover their body", () => {
	const source = [
		'doc = """',
		"def fake(): pass",
		'"""',
		"# def fake(): pass",
		"r = r'\\d+ def fake(): pass'",
		"def real(): pass",
	].join("\n");
	expect(kindOf(source, "py", "def fake(): pass", 0)).toBe("string");
	expect(kindOf(source, "py", "def fake(): pass", 1)).toBe("comment");
	expect(kindOf(source, "py", "def fake(): pass", 2)).toBe("string");
	expect(kindOf(source, "py", "def real(): pass")).toBe("code");
});

test("shell treats # as a comment only at a word boundary", () => {
	const source = ["url=http://host/a#frag", "echo hi # trailing note"].join("\n");
	expect(kindOf(source, "sh", "#frag")).toBe("code");
	expect(kindOf(source, "sh", "# trailing note")).toBe("comment");
});

test("markdown prose counts fenced blocks as code and inline spans as prose", () => {
	const source = [
		"Never write as any in code.",
		"",
		"```ts",
		"const a = value as any;",
		"```",
		"",
		"Inline `as any` too.",
	].join("\n");
	const regions = classifyRegions(source, { kind: "prose" });
	expect(regions).toBeDefined();
	const at = (needle: string, occurrence: number) => {
		let index = -1;
		for (let seen = 0; seen <= occurrence; seen++) index = source.indexOf(needle, index + 1);
		return spanRegionKind(regions!, index, index + needle.length, "prose");
	};
	expect(at("as any", 0)).toBe("prose");
	expect(at("as any", 1)).toBe("code");
	expect(at("as any", 2)).toBe("prose");
});

test("an unterminated fence keeps the rest of the buffer in code", () => {
	const source = ["text", "```ts", "const a = value as any;"].join("\n");
	const regions = classifyRegions(source, { kind: "prose" })!;
	const index = source.indexOf("as any");
	expect(spanRegionKind(regions, index, index + 6, "prose")).toBe("code");
});

test("a span straddling two kinds resolves to no single kind", () => {
	const source = 'const a = "x"; // note';
	const regions = classifyRegions(source, { kind: "code", lang: "ts" })!;
	expect(spanRegionKind(regions, 10, source.length, "code")).toBeUndefined();
});

test("region mode follows the stream source and only known languages classify", () => {
	expect(regionModeFor("text", undefined)).toEqual({ kind: "prose" });
	expect(regionModeFor("thinking", "ts")).toEqual({ kind: "prose" });
	expect(regionModeFor("tool", "md")).toEqual({ kind: "prose" });
	expect(regionModeFor("tool", "ts")).toEqual({ kind: "code", lang: "ts" });
	expect(regionModeFor("tool", undefined)).toBeUndefined();
	expect(regionModeFor("tool", "unknownlang")).toBeUndefined();
	expect(classifyRegions("whatever", { kind: "code", lang: "unknownlang" })).toBeUndefined();
});
