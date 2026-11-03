import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { JsRuntime, type RuntimeHooks } from "./shared/runtime";

test("output reads published text verbatim and applies line windows, formats and JSON queries", async () => {
	using tmp = TempDir.createSync("@output-options-");
	const published = tmp.join("report.md");
	await Bun.write(published, "first\nsecond\nthird\nfourth\n");
	const runtime = new JsRuntime({ initialCwd: tmp.path(), sessionId: crypto.randomUUID() });
	const hooks: RuntimeHooks = {
		onText: () => {},
		onDisplay: () => {},
		callTool: async (_name, args) => {
			const { path } = args as { path: string };
			return {
				text: path.includes(":raw:") ? "first\n" : "annotated preview",
				details: { resolvedPath: published },
			};
		},
	};
	try {
		expect(await runtime.run('await output("worker")', undefined, hooks)).toBe("first\nsecond\nthird\nfourth\n");
		expect(await runtime.run('await output("worker", { offset: 2, limit: 2 })', undefined, hooks)).toBe(
			"second\nthird",
		);
		expect(
			await runtime.run('await output("worker", { format: "json", offset: 3, limit: 1 })', undefined, hooks),
		).toMatchObject({
			id: "worker",
			line_count: 4,
			content: "third",
			range: { start_line: 3, end_line: 3, total_lines: 4 },
		});
		await Bun.write(published, '{"items":[{"value":1},{"value":2}]}');
		hooks.callTool = async () => ({
			text: '{"items":[{"value":1},{"value":2}]}',
			details: { resolvedPath: published },
		});
		expect(await runtime.run('await output("worker", { query: ".items[-1].value" })', undefined, hooks)).toBe("2");
		await expect(
			runtime.run('await output("worker", { query: ".items", offset: 1 })', undefined, hooks),
		).rejects.toThrow("cannot be combined");
	} finally {
		runtime.dispose();
	}
});

test("output preserves superseded warnings but queries the unannotated published JSON", async () => {
	using tmp = TempDir.createSync("@output-superseded-");
	const published = tmp.join("report.md");
	await Bun.write(published, '{"answer":42}');
	const runtime = new JsRuntime({ initialCwd: tmp.path(), sessionId: crypto.randomUUID() });
	const warning = 'Superseded: worker is running a newer turn\n{"answer":42}';
	const hooks: RuntimeHooks = {
		onText: () => {},
		onDisplay: () => {},
		callTool: async () => ({ text: warning, details: { resolvedPath: published } }),
	};
	try {
		expect(await runtime.run('await output("worker")', undefined, hooks)).toBe(warning);
		expect(await runtime.run('await output("worker", { query: ".answer" })', undefined, hooks)).toBe("42");
	} finally {
		runtime.dispose();
	}
});

test("cancellation during compilation prevents evaluation and does not poison the next cell", async () => {
	using tmp = TempDir.createSync("@runtime-compile-cancel-");
	let started = 0;
	let effects = 0;
	const runtime = new JsRuntime({
		initialCwd: tmp.path(),
		sessionId: crypto.randomUUID(),
		extraGlobals: {
			recordEffect: () => {
				effects++;
			},
		},
	});
	const hooks: RuntimeHooks = { onText: () => {}, onDisplay: () => {}, callTool: async () => null };
	try {
		const controller = new AbortController();
		const cancelled = runtime.run("recordEffect()", undefined, hooks, {
			signal: controller.signal,
			onCodeStart: () => {
				started++;
			},
		});
		controller.abort(new Error("cancelled while compiling"));
		await expect(cancelled).rejects.toThrow("cancelled while compiling");
		expect(started).toBe(0);
		expect(effects).toBe(0);
		await runtime.run("recordEffect()", undefined, hooks, {
			onCodeStart: () => {
				started++;
			},
		});
		expect(started).toBe(1);
		expect(effects).toBe(1);
	} finally {
		runtime.dispose();
	}
});
