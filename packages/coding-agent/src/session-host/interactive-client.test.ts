import { describe, expect, test } from "bun:test";
import { parseArgs } from "../cli/args";
import { interactiveHostArgs, interactiveHostRestartArgs } from "./interactive-client";

describe("interactive host selection handoff", () => {
	test("resumes the resolved transcript without repeating import, fork, cwd, or picker selection", () => {
		const forwarded = interactiveHostArgs(
			[
				"--fork",
				"source",
				"--resume=older",
				"--cwd",
				"/elsewhere",
				"--from-claude",
				"--continue",
				"--model",
				"test/model",
				"--trusted-extension",
				"/tmp/plugin.ts",
			],
			"/resolved/session.jsonl",
		);
		const parsed = parseArgs(forwarded);
		expect(parsed.resume).toBe("/resolved/session.jsonl");
		expect(parsed.fork).toBeUndefined();
		expect(parsed.cwd).toBeUndefined();
		expect(parsed.fromClaude).toBeUndefined();
		expect(parsed.continue).toBeUndefined();
		expect(parsed.model).toBe("test/model");
		expect(parsed.trustedExtensions).toEqual(["/tmp/plugin.ts"]);
	});

	test("does not strip a session-shaped token when it is another flag's value", () => {
		const parsed = parseArgs(
			interactiveHostArgs(
				["--append-system-prompt", "--resume", "--model=provider/model"],
				"/resolved/session.jsonl",
			),
		);
		expect(parsed.resume).toBe("/resolved/session.jsonl");
		expect(parsed.appendSystemPrompt).toBe("--resume");
		expect(parsed.model).toBe("provider/model");
	});

	test("preserves prompt text after the separator even when it resembles selection flags", () => {
		const parsed = parseArgs(
			interactiveHostArgs(["-r", "--", "--fork", "source", "--cwd=/prompt"], "/resolved/session.jsonl"),
		);
		expect(parsed.resume).toBe("/resolved/session.jsonl");
		expect(parsed.messages).toEqual(["--fork", "source", "--cwd=/prompt"]);
	});
});

describe("interactive restart argument capture", () => {
	test("restores persisted model and history without repeating startup selectors, messages, files, or separator text", () => {
		const parsed = parseArgs(
			interactiveHostRestartArgs(
				[
					"--resume",
					"/source.jsonl",
					"--provider",
					"original",
					"--model=initial",
					"--thinking",
					"high",
					"-m",
					"alias-model",
					"--config",
					"/config.json",
					"--trusted-extension",
					"/extension.ts",
					"--add-dir",
					"/workspace",
					"--no-skills",
					"initial submission",
					"@initial.txt",
					"--",
					"--model",
					"literal prompt",
				],
				"/active.jsonl",
			),
		);
		expect(parsed.resume).toBe("/active.jsonl");
		expect(parsed.provider).toBeUndefined();
		expect(parsed.model).toBeUndefined();
		expect(parsed.thinking).toBeUndefined();
		expect(parsed.messages).toEqual([]);
		expect(parsed.fileArgs).toEqual([]);
		expect(parsed.config).toEqual(["/config.json"]);
		expect(parsed.trustedExtensions).toEqual(["/extension.ts"]);
		expect(parsed.addDir).toEqual(["/workspace"]);
		expect(parsed.noSkills).toBe(true);
	});
	test("uses extension flag types so booleans never retain the following initial prompt as a value", () => {
		const flags = new Map<string, { type: "boolean" | "string" }>([
			["enable-audit", { type: "boolean" }],
			["audit-label", { type: "string" }],
		]);
		const parsed = parseArgs(
			interactiveHostRestartArgs(
				[
					"--enable-audit",
					"one-shot prompt",
					"--audit-label",
					"persistent label",
					"--unknown-toggle",
					"another prompt",
				],
				"/active.jsonl",
				flags,
			),
			flags,
		);
		expect(parsed.unknownFlags.get("enable-audit")).toBe(true);
		expect(parsed.unknownFlags.get("audit-label")).toBe("persistent label");
		expect(parsed.messages).toEqual([]);
		expect(parsed.unrecognizedFlags).toEqual([]);
	});
	test("preserves flag-shaped string values but removes boolean inline values that the parser treats as initial messages", () => {
		const flags = new Map<string, { type: "boolean" | "string" }>([
			["audit", { type: "boolean" }],
			["label", { type: "string" }],
		]);
		const parsed = parseArgs(
			interactiveHostRestartArgs(
				["--append-system-prompt", "--model", "--audit=false", "--label=--provider", "--no-skills=true"],
				"/active.jsonl",
				flags,
			),
			flags,
		);
		expect(parsed.appendSystemPrompt).toBe("--model");
		expect(parsed.unknownFlags.get("audit")).toBe(true);
		expect(parsed.unknownFlags.get("label")).toBe("--provider");
		expect(parsed.messages).toEqual([]);
	});
});
