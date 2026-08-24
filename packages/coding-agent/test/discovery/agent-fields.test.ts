import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";

describe("parseAgentFields", () => {
	test("parses legacy thinking key", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "medium",
		});

		expect(fields).toBeDefined();
		expect(fields?.thinkingLevel).toBe(Effort.Medium);
	});

	test("prefers thinking-level over legacy thinking", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "minimal",
			thinkingLevel: Effort.High,
		});

		expect(fields?.thinkingLevel).toBe(Effort.High);
	});
	test("treats the retired auto thinking selector as unset", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			thinkingLevel: "auto",
		});

		expect(fields?.thinkingLevel).toBeUndefined();
	});

	test("rejects unknown thinking selectors", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			thinkingLevel: "turbo",
		});

		expect(fields?.thinkingLevel).toBeUndefined();
	});

	test("lowercases and passes through tool names", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Read", "Bash"],
		});

		expect(fields?.tools).toEqual(["read", "bash", "yield"]);
	});

	test("keeps unknown tool names untouched for later discovery-time validation", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Search", "Find"],
		});

		expect(fields?.tools).toEqual(["Search", "Find", "yield"]);
	});

	test("parses autoloadSkills from array frontmatter", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: ["user-created-skill-a", "user-created-skill-b"],
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
	});

	test("parses autoloadSkills from CSV string", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: "user-created-skill-a, user-created-skill-b",
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
	});

	test("returns undefined autoloadSkills when field absent", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});

	test("returns undefined autoloadSkills for empty array", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: [],
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});

	test("parses readSummarize from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: false })?.readSummarize).toBe(false);
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: true })?.readSummarize).toBe(true);
	});

	test("parses readSummarize from string frontmatter", () => {
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: "false" })?.readSummarize).toBe(
			false,
		);
	});

	test("ignores invalid readSummarize values", () => {
		expect(
			parseAgentFields({ name: "scout", description: "desc", readSummarize: "nope" })?.readSummarize,
		).toBeUndefined();
	});

	test("returns undefined readSummarize when field absent", () => {
		expect(parseAgentFields({ name: "scout", description: "desc" })?.readSummarize).toBeUndefined();
	});
	test("parses prewalk from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: true })?.prewalk).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: false })?.prewalk).toBe(false);
	});

	test("parses prewalk boolean strings as booleans", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "true" })?.prewalk).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "false" })?.prewalk).toBe(false);
	});

	test("parses prewalk model pattern strings", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: " @smol " })?.prewalk).toBe("@smol");
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "openai/gpt-5-mini" })?.prewalk).toBe(
			"openai/gpt-5-mini",
		);
	});

	test("ignores empty and absent prewalk values", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "  " })?.prewalk).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc" })?.prewalk).toBeUndefined();
	});
	test("parses advisor from boolean frontmatter and boolean strings", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: true })?.advisor).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: false })?.advisor).toBe(false);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "true" })?.advisor).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "false" })?.advisor).toBe(false);
	});

	test("parses advisor model pattern strings and ignores empty/absent values", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: " moonshot/k3 " })?.advisor).toBe(
			"moonshot/k3",
		);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "@smol:high" })?.advisor).toBe(
			"@smol:high",
		);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "  " })?.advisor).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc" })?.advisor).toBeUndefined();
	});
});
