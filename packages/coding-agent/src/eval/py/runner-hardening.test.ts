import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { PythonKernel } from "./kernel";

test("shell-like syntax is rejected before any Python or shell side effects", async () => {
	using directory = TempDir.createSync("@python-native-syntax-");
	const kernel = await PythonKernel.start({ cwd: directory.path() });
	try {
		const output: string[] = [];
		const result = await kernel.execute(
			'open("must-not-run", "w").write("bad")\n!echo "unterminated\ntext = """\n!not_a_command\n%not_a_magic\n"""',
			{
				onChunk: text => {
					output.push(text);
				},
			},
		);
		expect(result.status).toBe("error");
		expect(output.join("")).toContain("SyntaxError");
		expect(await Bun.file(directory.join("must-not-run")).exists()).toBe(false);
	} finally {
		await kernel.shutdown();
	}
});

test("explicit rich display preserves large integers exactly while booleans remain booleans", async () => {
	using directory = TempDir.createSync("@python-display-integers-");
	const kernel = await PythonKernel.start({ cwd: directory.path() });
	const displays: unknown[] = [];
	try {
		const result = await kernel.execute(
			"import proto_harness as harness\nharness.display({'ids': [9007199254740993, -9007199254740993, 42, True]})",
			{
				onDisplay: output => {
					if (output.type === "json") displays.push(output.data);
				},
			},
		);
		expect(result.status).toBe("ok");
		expect(displays).toEqual([{ ids: ["9007199254740993", "-9007199254740993", 42, true] }]);
	} finally {
		await kernel.shutdown();
	}
});

test("pip magic is unsupported rather than bootstrapping or translating installer arguments", async () => {
	using directory = TempDir.createSync("@python-native-pip-");
	const kernel = await PythonKernel.start({ cwd: directory.path() });
	try {
		const result = await kernel.execute(
			'open("must-not-bootstrap", "w").write("bad")\n%pip --isolated --proxy install list',
		);
		expect(result).toMatchObject({ status: "error", error: { name: "SyntaxError" } });
		expect(await Bun.file(directory.join("must-not-bootstrap")).exists()).toBe(false);
	} finally {
		await kernel.shutdown();
	}
});

for (const shell of [false, true]) {
	test(`${shell ? "shell-wrapped" : "direct"} subprocess cancellation kills descendants before returning`, async () => {
		using directory = TempDir.createSync("@python-process-cancel-");
		const kernel = await PythonKernel.start({ cwd: directory.path() });
		const controller = new AbortController();
		const ready = Promise.withResolvers<void>();
		try {
			const result = kernel.execute(
				`import os, subprocess, sys, time
child = "import time; time.sleep(60)"
parent = "import subprocess, sys, time; child = subprocess.Popen([sys.executable, '-c', " + repr(child) + "]); open('child.pid', 'w').write(str(child.pid)); print('ready', flush=True); time.sleep(60)"
argv = [sys.executable, "-c", parent]
${shell ? 'import shlex; argv = ["/bin/sh", "-c", shlex.join(argv)]' : ""}
process = subprocess.Popen(argv)
while not os.path.exists("child.pid"):
    time.sleep(0.005)
print("ready", flush=True)
process.wait()`,
				{
					signal: controller.signal,
					onChunk: text => {
						if (text.includes("ready")) ready.resolve();
					},
				},
			);
			await Promise.race([
				ready.promise,
				result.then(outcome => {
					throw new Error(`Process exited before readiness: ${JSON.stringify(outcome)}`);
				}),
			]);
			controller.abort(new Error("cancel owned subprocess tree"));
			expect(await result).toMatchObject({ status: "error", cancelled: true });
			const pid = Number(await Bun.file(directory.join("child.pid")).text());
			const check = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "pipe" });
			const state = (await new Response(check.stdout).text()).trim();
			await check.exited;
			expect(state === "" || state.startsWith("Z"), `descendant ${pid} remained alive (${state})`).toBe(true);
		} finally {
			controller.abort();
			await kernel.shutdown();
		}
	}, 20_000);
}
