import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { type Tool as AiTool, toolWireSchema } from "@oh-my-pi/pi-ai";
import {
	formatCliUsageSynopsis,
	formatXdevCliCommand,
	parseXdevCliArgs,
	XdevUsageError,
	xdevFlagSpecs,
} from "./xdev-cli";

function schemaOf(parameters: unknown): Record<string, unknown> {
	const tool = {
		name: "probe",
		label: "Probe",
		description: "probe",
		parameters,
		execute: async () => ({ content: [] }),
	} as unknown as AiTool;
	return toolWireSchema(tool) as Record<string, unknown>;
}

const richSchema = schemaOf(
	type({
		value: type("string").describe("the value"),
		"count?": type("number > 0"),
		"ids?": type("string[]"),
		"flag?": type("boolean"),
		"mode?": type("'fast' | 'slow'"),
		"deep?": type({ nested: "string" }),
		"nums?": type("number[]"),
	}),
);

function parse(argv: string[], schema = richSchema, stdin?: string) {
	return parseXdevCliArgs(schema, argv, { deviceName: "probe", stdin });
}

describe("parseXdevCliArgs", () => {
	test("maps long flags to schema properties with type parsing", () => {
		expect(parse(["--value", "hello", "--count", "3"])).toEqual({
			args: { value: "hello", count: 3 },
			viaJson: false,
		});
	});

	test("supports --flag=value and bare boolean flags", () => {
		expect(parse(["--value=hi", "--flag"])).toEqual({ args: { value: "hi", flag: true }, viaJson: false });
		expect(parse(["--value=hi", "--no-flag"])).toEqual({ args: { value: "hi", flag: false }, viaJson: false });
		expect(parse(["--value=hi", "--flag=false"])).toEqual({ args: { value: "hi", flag: false }, viaJson: false });
	});

	test("validates enum values with did-you-mean hints", () => {
		expect(parse(["--value=hi", "--mode", "fast"]).args).toEqual({ value: "hi", mode: "fast" });
		expect(() => parse(["--value=hi", "--mode", "fase"])).toThrow(/did you mean 'fast'/);
		expect(() => parse(["--value=hi", "--mode", "nope"])).toThrow(/expects one of 'fast' \| 'slow'/);
	});

	test("rejects numbers that do not parse", () => {
		expect(() => parse(["--value=hi", "--count", "abc"])).toThrow(/expects a number/);
	});

	test("string arrays accept repeated flags and comma splitting", () => {
		expect(parse(["--value=hi", "--ids", "a", "--ids", "b"]).args).toEqual({ value: "hi", ids: ["a", "b"] });
		expect(parse(["--value=hi", "--ids", "a,b,c"]).args).toEqual({ value: "hi", ids: ["a", "b", "c"] });
	});

	test("number arrays parse entries", () => {
		expect(parse(["--value=hi", "--nums", "1,2"]).args).toEqual({ value: "hi", nums: [1, 2] });
	});

	test("object properties take JSON payloads across multiple tokens", () => {
		expect(parse(["--value=hi", "--deep", '{"nested":', '"x"}']).args).toEqual({
			value: "hi",
			deep: { nested: "x" },
		});
		expect(() => parse(["--value=hi", "--deep", "not-json"])).toThrow(/valid JSON/);
	});

	test("unknown flags fail with usage guidance and did-you-mean", () => {
		expect(() => parse(["--vale", "x"])).toThrow(/unknown flag --vale \(did you mean --value\?\)/);
		expect(() => parse(["--zzz", "x"])).toThrow(/unknown flag --zzz/);
	});

	test("missing flag values fail with usage guidance", () => {
		expect(() => parse(["--value"])).toThrow(/--value needs a value/);
	});

	test("-- stops flag parsing so dash-leading values stay positional", () => {
		expect(parse(["--", "--value"])).toEqual({ args: { value: "--value" }, viaJson: false });
	});

	test("positionals fill scalar properties in device order", () => {
		expect(parse(["hello"])).toEqual({ args: { value: "hello" }, viaJson: false });
		expect(parse(["hello", "3"])).toEqual({ args: { value: "hello", count: 3 }, viaJson: false });
		expect(parse(["--count", "3", "hello"]).args).toEqual({ value: "hello", count: 3 });
	});

	test("too many positionals fail with guidance", () => {
		expect(() => parse(["a", "3", "true", "fast", "extra"])).toThrow(/unexpected positional/);
	});

	test("single JSON object positional stays the legacy form", () => {
		expect(parse(['{"value":"legacy"}'])).toEqual({ args: { value: "legacy" }, viaJson: true });
	});

	test("JSON object mixed with flags or extra positionals is rejected", () => {
		expect(() => parse(['{"value":"x"}', "extra"])).toThrow(/only positional argument/);
		expect(() => parse(["--flag", '{"value":"x"}'])).toThrow(/only positional argument/);
	});

	test("--json accepts inline and multi-token JSON", () => {
		expect(parse(["--json", '{"value":"raw"}'])).toEqual({ args: { value: "raw" }, viaJson: true });
		expect(parse(["--json", '{"value":', '"raw"}'])).toEqual({ args: { value: "raw" }, viaJson: true });
		expect(() => parse(["--json", "nope"])).toThrow(/--json is not a valid JSON object/);
	});

	test("- reads a flag value from stdin", () => {
		expect(parse(["--value", "-"], richSchema, "from stdin\n")).toEqual({
			args: { value: "from stdin\n" },
			viaJson: false,
		});
		expect(parse(["--json", "-"], richSchema, '{"value":"sj"}')).toEqual({ args: { value: "sj" }, viaJson: true });
		expect(() => parse(["--json", "-"], richSchema, "not json")).toThrow(/not a valid JSON object/);
	});

	test("bare stdin maps to JSON object, or plain text for a single string device", () => {
		expect(parse([], richSchema, '{"value":"piped"}')).toEqual({ args: { value: "piped" }, viaJson: true });
		const pathSchema = schemaOf(type({ path: "string" }));
		expect(parseXdevCliArgs(pathSchema, [], { deviceName: "read", stdin: "src/file.ts\n" }).args).toEqual({
			path: "src/file.ts\n",
		});
	});

	test("jsonOnly devices accept only single JSON object args", () => {
		const opts = { deviceName: "mcp__srv__tool", jsonOnly: true };
		expect(parseXdevCliArgs(richSchema, ['{"value":"ok"}'], opts)).toEqual({
			args: { value: "ok" },
			viaJson: true,
		});
		expect(() => parseXdevCliArgs(richSchema, ["--value", "ok"], opts)).toThrow(/MCP devices take a single JSON/);
		expect(() => parseXdevCliArgs(richSchema, ["a", "b"], opts)).toThrow(/MCP devices take a single JSON/);
	});

	test("empty argv yields empty args for schemas without positionals", () => {
		expect(parse([])).toEqual({ args: {}, viaJson: false });
	});
});

describe("xdevFlagSpecs", () => {
	test("degrades non-scalar arrays and mixed enums to json payloads", () => {
		const specs = xdevFlagSpecs(richSchema);
		const deep = specs.find(spec => spec.name === "deep");
		expect(deep?.type).toBe("json");
		const ids = specs.find(spec => spec.name === "ids");
		expect(ids).toMatchObject({ type: "array", items: "string" });
		const nums = specs.find(spec => spec.name === "nums");
		expect(nums).toMatchObject({ type: "array", items: "number" });
		const value = specs.find(spec => spec.name === "value");
		expect(value).toMatchObject({ required: true, type: "string" });
	});
});

describe("formatXdevCliCommand", () => {
	test("round-trips simple args into shell-safe CLI form", () => {
		expect(formatXdevCliCommand("browser", { action: "run", name: "main", count: 2, flag: false })).toBe(
			"xd browser --action run --name main --count 2 --no-flag",
		);
	});

	test("quotes values with spaces and special characters", () => {
		expect(formatXdevCliCommand("read", { path: "my file.txt" })).toBe("xd read --path 'my file.txt'");
		expect(formatXdevCliCommand("read", { path: "it's" })).toBe("xd read --path 'it'\\''s'");
	});

	test("truncates long values for display", () => {
		const rendered = formatXdevCliCommand("read", { path: "x".repeat(200) });
		expect(rendered.length).toBeLessThan(160);
		expect(rendered.endsWith("…'")).toBe(true);
	});
});

describe("formatCliUsageSynopsis", () => {
	test("renders required props positionally and optionals as flags", () => {
		const synopsis = formatCliUsageSynopsis("probe", richSchema);
		expect(synopsis).toBe(
			"xd probe <value> [<count>] [<flag>] [<fast|slow>] [--ids <ids…>] [--deep <deep>] [--nums <nums…>]",
		);
		expect(synopsis).toContain("[<flag>]");
		expect(synopsis).toContain("[<fast|slow>]");
	});

	test("empty schema renders bare invocation", () => {
		expect(formatCliUsageSynopsis("list", schemaOf(type({})))).toBe("xd list");
	});
});
