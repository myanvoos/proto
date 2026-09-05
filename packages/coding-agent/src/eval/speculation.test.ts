import { expect, test } from "bun:test";
import {
	findHeredocCompletionCalls,
	findLiteralCompletionCalls,
	parseStandaloneQuotedHeredoc,
	parseStreamedInputForCompletion,
} from "./speculation";

test("finds literal Python completion calls in a quoted heredoc", () => {
	const command = `python <<'PY'\nanswer = completion("summarize", model="smol", system='brief')\nPY`;
	const calls = findHeredocCompletionCalls(command);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.args).toEqual({ prompt: "summarize", model: "smol", system: "brief" });
});

test("finds literal JavaScript options and preserves duplicate ordinals", () => {
	const command = `node <<'JS'\nconst a = await completion("same", { model: "default" });\nconst b = await completion("same", { model: "default" });\nJS`;
	const calls = findHeredocCompletionCalls(command);
	expect(calls).toHaveLength(2);
	expect(calls[0]?.fingerprint).toBe(calls[1]?.fingerprint);
	expect(calls.map(call => call.index)).toEqual([0, 1]);
});

test("does not authorize shell chains, interpolated values, or control flow", () => {
	expect(findHeredocCompletionCalls(`python <<'PY'\ncompletion("x") && rm -rf /\nPY`)).toEqual([]);
	expect(findHeredocCompletionCalls(`python <<'PY'\ncompletion(prompt)\nPY`)).toEqual([]);
	expect(findHeredocCompletionCalls(`python <<'PY'\nif ready:\n  completion("x")\nPY`)).toEqual([]);
	expect(findHeredocCompletionCalls(`python <<PY\ncompletion("x")\nPY`)).toEqual([]);
});

test("rejects property access and completion rebinding", () => {
	expect(findLiteralCompletionCalls("js", `obj.completion("x")`)).toEqual([]);
	expect(findLiteralCompletionCalls("js", `completion = other\ncompletion("x")`)).toEqual([]);
});

test("partial body is inspectable without executing it", () => {
	const input = parseStreamedInputForCompletion(JSON.stringify({ command: `python <<'PY'\ncompletion("x")` }));
	expect(parseStandaloneQuotedHeredoc(input.input.command!)).toEqual({
		language: "python",
		code: `completion("x")`,
		closed: false,
	});
	expect(input.calls[0]?.args.prompt).toBe("x");
});

test("decodes incomplete outer JSON without losing completed fields", () => {
	const prompt = 'quote "and" ✓';
	const command = `python <<'PY'\na = completion(${JSON.stringify(prompt)})\nPY`;
	const raw = JSON.stringify({ cwd: "/tmp", command });
	const partial = parseStreamedInputForCompletion(raw.slice(0, -2));
	expect(partial.input.cwd).toBe("/tmp");
	expect(partial.calls.map(call => call.args.prompt)).toEqual([prompt]);
});

test("rejects nested and duplicate root command fields", () => {
	const command = `python <<'PY'\ncompletion("nested")\n`;
	expect(parseStreamedInputForCompletion(JSON.stringify({ metadata: { command } })).input.command).toBeUndefined();
	expect(parseStreamedInputForCompletion(`{"command":"a","command":"b"}`).input.command).toBeUndefined();
});

test("retains prior flags and environment while decoding a root command after nested metadata", () => {
	const raw = JSON.stringify({
		metadata: { command: "not the root command", values: [1, { nested: true }] },
		env: { LANG: "C" },
		pty: false,
		async: false,
		command: `python <<'PY'\ncompletion("root prompt")\n`,
	});
	const partial = parseStreamedInputForCompletion(raw.slice(0, -2));
	expect(partial.calls.map(call => call.args.prompt)).toEqual(["root prompt"]);
	expect(partial.input.env).toEqual({ LANG: "C" });
	expect(partial.input.pty).toBe(false);
	expect(partial.input.async).toBe(false);
});

test("does not speculate from non-object roots or malformed JSON string escapes", () => {
	const command = `python <<'PY'\ncompletion("nested")\n`;
	expect(parseStreamedInputForCompletion(JSON.stringify([{ command }])).calls).toEqual([]);
	expect(parseStreamedInputForCompletion(`prose ${JSON.stringify({ command })}`).calls).toEqual([]);
	expect(parseStreamedInputForCompletion('{"command":"bad\\q"}').calls).toEqual([]);
	expect(parseStreamedInputForCompletion('{"command":"raw\nnewline"}').calls).toEqual([]);
	expect(
		parseStreamedInputForCompletion(`{"pty":false,"pty":true,"command":${JSON.stringify(command)}}`).calls,
	).toEqual([]);
});

test("incomplete JSON unicode escapes cannot invent completion arguments", () => {
	const prefix = `python <<'PY'\ncompletion("unfinished `;
	const raw = `{"command":${JSON.stringify(prefix).slice(0, -1)}\\u27`;
	expect(parseStreamedInputForCompletion(raw).calls).toEqual([]);
	const suffix = JSON.stringify('13")\n').slice(1);
	const complete = parseStreamedInputForCompletion(`${raw}${suffix}}`);
	expect(complete.calls.map(call => call.args.prompt)).toEqual(["unfinished ✓"]);
});
