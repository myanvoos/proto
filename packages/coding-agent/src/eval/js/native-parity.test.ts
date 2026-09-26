import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import type { JsKernelRuntime } from "../kernel-environment";
import type { KernelInvocation } from "../types";
import { disposeVmContextsByOwner } from "./context-manager";
import { executeJs } from "./executor";

async function harness(runtime: JsKernelRuntime, cwd: string) {
	const owner = `native-parity:${runtime}:${crypto.randomUUID()}`;
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings: await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	return {
		async run(code: string, invocation?: KernelInvocation) {
			const streams = { stdout: "", stderr: "" };
			const result = await executeJs(code, {
				runtime,
				cwd,
				session,
				sessionId: owner,
				kernelOwnerId: owner,
				invocation,
				onStream: (text, stream) => {
					streams[stream] += text;
				},
			});
			return { ...result, ...streams };
		},
		async [Symbol.asyncDispose]() {
			await disposeVmContextsByOwner(owner);
		},
	};
}

for (const runtime of ["node", "bun"] as const) {
	test(`${runtime} preserves native lexical execution and callback completion`, async () => {
		using directory = TempDir.createSync("@js-native-parity-");
		await using kernel = await harness(runtime, directory.path());
		await Bun.write(directory.join("value.txt"), "read callback");
		const samples = [
			`const nativeConstant = 1; try { eval("nativeConstant = 2"); } catch (error) { console.log(error.name); } console.log(nativeConstant);`,
			`try { console.log(nativeTDZ); } catch (error) { console.log(error.name); } let nativeTDZ = 7; console.log(nativeTDZ);`,
			`try { console.log(typeof NativeLaterClass); } catch (error) { console.log(error.name); } class NativeLaterClass {}`,
			`var nativeVarTopology = 1; console.log(Object.hasOwn(globalThis, "nativeVarTopology"), this === globalThis, this === module.exports);`,
			`console.log(__filename, __dirname);`,
			`console.log(function () { return this; }() === undefined);`,
			`"use strict"; console.log(function () { return this; }() === undefined);`,
			`let nativeCounter = 1; const nativeRead = () => nativeCounter; nativeCounter++; console.log(nativeRead());`,
			`class NativeSelf { static instance = new NativeSelf(); static read() { return NativeSelf; } } const NativeOriginal = NativeSelf; NativeSelf = null; console.log(NativeOriginal.read() === NativeOriginal, NativeOriginal.instance instanceof NativeOriginal);`,
			`console.log((function () { "use strict"; return this; })() === undefined);`,
			`Promise.withResolvers().promise;`,
			`Promise.resolve().then(() => console.log("microtask"));`,
			`let nativeHidden = 3; console.log(Object.hasOwn(globalThis, "nativeHidden"));`,
			`console.log("%s:%d", "native", 42); console.error("stderr %s", "native");`,
			`console.log({ nested: { list: [1, 2, 3], text: "雪" }, value: undefined }); console.dir({ value: 7 }, { depth: 1 });`,
			`{ const limit = Error.stackTraceLimit; Error.stackTraceLimit = 0; console.error(new Error("native")); Error.stackTraceLimit = limit; }`,
			`console.group("group"); console.log("nested"); console.groupEnd(); console.count("count"); console.count("count"); console.countReset("count"); console.count("count");`,
			`console.table([{ native: 1 }, { native: 2 }]);`,
			`require("node:fs").writeSync(1, Buffer.from("descriptor bytes\\n")); require("node:fs").writeSync(2, Buffer.from("descriptor stderr\\n"));`,
			`require("node:child_process").spawn(process.execPath, ["-e", "process.stdout.write('child stdout\\n'); process.stderr.write('child stderr\\n')"], { stdio: "inherit" });`,

			// These are native-event-loop differentials in subprocesses, not host-clock waits.
			`setTimeout(() => { console.log("timer"); setImmediate(() => console.log("nested immediate")); }, 0);`,
			`require("node:fs").readFile("value.txt", "utf8", (error, text) => { if (error) throw error; console.log(text); });`,
		];
		for (const code of samples) {
			const native = Bun.spawn([runtime, "-e", code], { cwd: directory.path(), stdout: "pipe", stderr: "pipe" });
			const expected = await Promise.all([
				new Response(native.stdout).text(),
				new Response(native.stderr).text(),
				native.exited,
			]);
			const actual = await kernel.run(code);
			expect(actual.exitCode, code).toBe(expected[2]);
			expect(actual.stdout, code).toBe(expected[0]);
			expect(actual.stderr, code).toBe(expected[1]);
		}
	}, 30_000);

	test(`${runtime} keeps live lexical bindings, imports, and redeclaration scopes across cells`, async () => {
		using directory = TempDir.createSync("@js-live-bindings-");
		await using kernel = await harness(runtime, directory.path());
		await Bun.write(
			directory.join("live.mjs"),
			`export let current = 1; export function increment() { current++; } export function receiver() { return this; }`,
		);
		expect(
			(
				await kernel.run(
					`let currentValue = 1; const readValue = () => currentValue; const changeValue = () => ++currentValue; class SavedClass { static read() { return SavedClass; } }`,
				)
			).exitCode,
		).toBe(0);
		expect(
			(await kernel.run(`currentValue = 4; console.log(readValue(), changeValue(), currentValue);`)).output,
		).toBe("4 5 5\n");
		expect((await kernel.run(`let currentValue = 9; console.log(currentValue, readValue());`)).output).toBe("9 5\n");
		expect((await kernel.run(`const fixedValue = 2;`)).exitCode).toBe(0);
		expect((await kernel.run(`fixedValue = 3;`)).exitCode).toBe(1);
		expect((await kernel.run(`const fixedValue = 8; console.log(fixedValue);`)).output).toBe("8\n");
		expect(
			(
				await kernel.run(
					`import { current, increment, receiver } from "./live.mjs"; increment(); console.log(current, receiver() === undefined); const readImport = () => current;`,
				)
			).output,
		).toBe("2 true\n");
		expect((await kernel.run(`increment(); console.log(current, readImport());`)).output).toBe("3 3\n");
		expect((await kernel.run(`current = 4;`)).exitCode).toBe(1);
		expect(
			(await kernel.run(`let awaited = 5; await Promise.resolve(); awaited++; const readAwaited = () => awaited;`))
				.exitCode,
		).toBe(0);
		expect(
			(await kernel.run(`awaited++; console.log(readAwaited(), SavedClass.read() === SavedClass);`)).output,
		).toBe("7 true\n");
		expect(
			(
				await kernel.run(
					`let restoredLive = 42; const readRestored = () => restoredLive; await saveState("live.json", ["restoredLive"]); restoredLive = 0; await loadState("live.json", { collision: "overwrite" }); console.log(restoredLive, readRestored());`,
				)
			).output,
		).toBe("42 42\n");
		expect(
			(
				await kernel.run(
					`let restoreMutable = 4; const restoreFixed = 3; await saveState("readonly.json", ["restoreMutable", "restoreFixed"]); restoreMutable = 0; try { await loadState("readonly.json", { collision: "overwrite" }); } catch (error) { console.log(/read-only/.test(error.message), restoreMutable); }`,
				)
			).output,
		).toBe("true 0\n");
	}, 30_000);

	test(`${runtime} separates native output from values and keeps invocation identity local to each cell`, async () => {
		using directory = TempDir.createSync("@js-native-identity-");
		await using kernel = await harness(runtime, directory.path());
		const first = await kernel.run(`process.stdout.write("bytes"); 42;`, {
			argv: ["selected-interpreter", "-", "雪", "--flag"],
		});
		expect(first.output).toBe("bytes");
		expect(first.displayOutputs).toContainEqual({ type: "text", text: "42\n" });
		expect(
			(
				await kernel.run(`console.log(JSON.stringify(process.argv));`, {
					argv: ["selected-interpreter", "-", "雪", "--flag"],
				})
			).output,
		).toBe('["selected-interpreter","-","雪","--flag"]\n');
		expect(
			(await kernel.run(`console.log(JSON.stringify(process.argv) === JSON.stringify([process.execPath]));`)).output,
		).toBe("true\n");
		const retained = await kernel.run(
			`const retainedInterval = retainTask(setInterval(() => {}, 100000)); console.log("retained");`,
		);
		expect(retained.output).toBe("retained\n");
		expect(
			(await kernel.run(`clearInterval(retainedInterval); console.log("cleared"); process.exit(7);`)).exitCode,
		).toBe(7);
		expect((await kernel.run(`console.log("alive");`)).output).toBe("alive\n");
		expect((await kernel.run(`process.exitCode = 23;`)).exitCode).toBe(23);
		expect((await kernel.run(`console.log("default exit");`)).exitCode).toBe(0);
		expect((await kernel.run(`console.log(process.execPath);`, { argv: ["selected-interpreter"] })).output).toBe(
			"selected-interpreter\n",
		);
		expect((await kernel.run(`console.log(process.execPath === process.argv[0]);`)).output).toBe("true\n");
	}, 30_000);
}
