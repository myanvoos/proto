import { expect, test, vi } from "bun:test";
import {
	findHeredocCompletionCalls,
	findLiteralCompletionCalls,
	LatestValueScheduler,
	parseStandaloneQuotedHeredoc,
	parseStreamedInputForCompletion,
	STREAMED_INPUT_OBSERVATION_INTERVAL_MS,
} from "./speculation";

test("finds literal Python completion calls in a quoted heredoc", () => {
	const command = `python <<'PY'\nanswer = completion("summarize", model="smol", system='brief')\nPY`;
	const calls = findHeredocCompletionCalls(command);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.args).toEqual({ prompt: "summarize", model: "smol", system: "brief" });
});

test("speculates on a pool model id, not just the role tiers", () => {
	const command = `python <<'PY'\nanswer = completion("summarize", model="openai-codex/gpt-5.6-sol")\nPY`;
	const calls = findHeredocCompletionCalls(command);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.args).toEqual({ prompt: "summarize", model: "openai-codex/gpt-5.6-sol" });
});

test("ignores completion-looking multiline string contents, including partial streams", () => {
	const prefix = ['answer = completion("before")', 'payload = """', 'completion("hidden")'].join("\n");
	const code = `${prefix}\n"""\nanswer = completion("after")`;
	const calls = findHeredocCompletionCalls(`python <<'PY'\n${code}\nPY`);
	expect(calls.map(call => call.args.prompt)).toEqual(["before", "after"]);

	const partial = parseStreamedInputForCompletion(JSON.stringify({ command: `python <<'PY'\n${prefix}` }));
	expect(partial.calls.map(call => call.args.prompt)).toEqual(["before"]);
});

test("does not confuse bitshifts, strings, or comments with completion calls", () => {
	const code = [
		"shifted = 1 << SHIFT",
		`text = 'completion("in string")'`,
		'# completion("in comment")',
		'answer = completion("visible")',
	].join("\n");
	expect(findLiteralCompletionCalls("python", code).map(call => call.args.prompt)).toEqual(["visible"]);
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

test("every kernel-routed interpreter name selects its cell language", () => {
	const body = `completion("x")`;
	for (const [executable, language] of [
		["python3", "python"],
		["node", "js"],
		["nodejs", "js"],
		["bun", "js"],
	] as const) {
		expect(parseStandaloneQuotedHeredoc(`${executable} <<'EOF'\n${body}\nEOF`)?.language).toBe(language);
	}
	expect(parseStandaloneQuotedHeredoc(`deno <<'EOF'\n${body}\nEOF`)).toBeUndefined();
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

test("coalesces streamed prefixes and drains the final value deterministically", async () => {
	const seen: string[] = [];
	const scheduler = new LatestValueScheduler<string>(
		value => {
			seen.push(value);
		},
		{ delayMs: 60_000 },
	);
	try {
		scheduler.enqueue("prefix-1");
		scheduler.enqueue("prefix-2");
		scheduler.enqueue("final-prefix");
		expect(seen).toEqual([]);
		await scheduler.flush();
		expect(seen).toEqual(["final-prefix"]);

		scheduler.enqueue("next-prefix");
		await scheduler.flush();
		expect(seen).toEqual(["final-prefix", "next-prefix"]);

		scheduler.enqueue("cancelled-prefix");
		scheduler.cancel();
		await scheduler.flush();
		expect(seen).toEqual(["final-prefix", "next-prefix"]);
	} finally {
		scheduler.cancel();
	}
});

test("runs the latest streamed value at a bounded cadence", async () => {
	vi.useFakeTimers();
	const seen: string[] = [];
	const scheduler = new LatestValueScheduler<string>(value => {
		seen.push(value);
	});
	try {
		scheduler.enqueue("first");
		scheduler.enqueue("latest");
		vi.advanceTimersByTime(STREAMED_INPUT_OBSERVATION_INTERVAL_MS - 1);
		expect(seen).toEqual([]);
		vi.advanceTimersByTime(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(seen).toEqual(["latest"]);
	} finally {
		scheduler.cancel();
		vi.useRealTimers();
	}
});

test("retains a newer value when an in-flight streamed observation rejects", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const seen: string[] = [];
	const scheduler = new LatestValueScheduler<string>(async value => {
		seen.push(value);
		if (value === "first") {
			started.resolve();
			await release.promise;
			throw new Error("first observation failed");
		}
	});
	try {
		scheduler.enqueue("first");
		const flushing = scheduler.flush();
		await started.promise;
		scheduler.enqueue("latest");
		release.resolve();
		await expect(flushing).rejects.toThrow("first observation failed");
		expect(seen).toEqual(["first", "latest"]);
	} finally {
		scheduler.cancel();
	}
});
