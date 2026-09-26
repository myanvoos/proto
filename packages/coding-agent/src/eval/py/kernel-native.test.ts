import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { checkPythonKernelAvailability, type KernelExecuteOptions, PythonKernel } from "./kernel";

const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
const kernelTest = availability.ok ? test : test.skip;

async function run(kernel: PythonKernel, code: string, options?: KernelExecuteOptions): Promise<string> {
	const chunks: string[] = [];
	const result = await kernel.execute(code, { ...options, onChunk: text => void chunks.push(text) });
	expect(result.status, chunks.join("")).toBe("ok");
	return chunks.join("");
}

kernelTest("ordinary code has native main-thread asyncio and a real persistent __main__ module", async () => {
	using dir = TempDir.createSync("@python-native-main-");
	const kernel = await PythonKernel.start({ cwd: dir.path() });
	try {
		const code = `import asyncio, pickle, signal, sys, threading
import __main__
assert __main__.__dict__ is globals()
assert threading.current_thread() is threading.main_thread()
assert sys.argv == ["-c"]
assert "__file__" not in globals()
try:
    asyncio.get_running_loop()
except RuntimeError:
    pass
else:
    raise AssertionError("ordinary code ran inside the host event loop")
def native_function():
    return 42
def native_annotations(value: int) -> str:
    return str(value)
assert native_annotations.__annotations__ == {"value": int, "return": str}
class NativeClass:
    pass
assert pickle.loads(pickle.dumps(native_function)) is native_function
assert type(pickle.loads(pickle.dumps(NativeClass()))) is NativeClass
async def native_async():
    await asyncio.sleep(0)
    return native_function()
native_value = eval("asyncio.run(native_async())")
assert native_value == 42
signal.signal(signal.SIGUSR1, lambda *_: None)
print("native-main-ok")`;
		const native = Bun.spawn([kernel.interpreter!, "-c", code], { cwd: dir.path(), stdout: "pipe", stderr: "pipe" });
		const [nativeOutput, nativeError, nativeExit] = await Promise.all([
			new Response(native.stdout).text(),
			new Response(native.stderr).text(),
			native.exited,
		]);
		expect(nativeExit, nativeError).toBe(0);
		expect(await run(kernel, code)).toBe(nativeOutput);
		expect(
			await run(kernel, "assert __main__.native_value == 42; print(pickle.loads(pickle.dumps(native_function))())"),
		).toBe("42\n");
		expect(await run(kernel, "await asyncio.sleep(0); print(native_value)")).toBe("42\n");
		expect(await run(kernel, "print(asyncio.run(native_async()))")).toBe("42\n");
	} finally {
		await kernel.shutdown();
	}
});

kernelTest("program input is native fd0 for Python and inheriting subprocesses", async () => {
	using dir = TempDir.createSync("@python-native-stdin-");
	const kernel = await PythonKernel.start({ cwd: dir.path() });
	try {
		const payload = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 256));
		const stdin = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(payload);
				controller.close();
			},
		});
		const result = await run(
			kernel,
			`import os, subprocess, sys
assert sys.stdin.fileno() == 0
assert sys.__stdin__ is sys.stdin
assert sys.stdin.buffer.raw.fileno() == 0
assert sys.stdin.name == "<stdin>" and sys.stdin.errors == "strict"
assert not sys.stdin.isatty()
first = os.read(0, 1)
child = subprocess.run([sys.executable, "-c", "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"], stdout=subprocess.PIPE, check=True)
assert first + child.stdout == bytes(range(256)) * 781 + bytes(range(64))
assert sys.stdin.buffer.read() == b""
print("native-stdin-ok")`,
			{ stdin },
		);
		expect(result).toBe("native-stdin-ok\n");
		expect(await run(kernel, 'assert os.read(0, 1) == b""; assert sys.stdin.read() == ""; print("eof")')).toBe(
			"eof\n",
		);
	} finally {
		await kernel.shutdown();
	}
});

kernelTest("invocation metadata replaces argv and __file__ without losing the user module", async () => {
	using dir = TempDir.createSync("@python-native-invocation-");
	using scripts = TempDir.createSync("@python-native-source-");
	const kernel = await PythonKernel.start({ cwd: dir.path() });
	try {
		const filename = `${scripts.path()}/native-script.py`;
		const output = await run(
			kernel,
			`import __main__, json, sys
assert __main__.__dict__ is globals()
assert __spec__ is None and __package__ is None
assert sys.path[0] == __import__("os").path.dirname(__file__)
print(json.dumps([sys.argv, __file__]))`,
			{ invocation: { argv: [filename, "space argument", "-x"], filename } },
		);
		expect(JSON.parse(output)).toEqual([[filename, "space argument", "-x"], filename]);
		expect(
			await run(
				kernel,
				'assert __file__ == "<stdin>" and __cached__ is None; assert __loader__.__name__ == "BuiltinImporter"; print(sys.argv)',
				{ invocation: { argv: ["-", "arg"], filename: "<stdin>" } },
			),
		).toBe("['-', 'arg']\n");
		expect(
			await run(kernel, 'assert __file__ == "<stdin>"; print(sys.argv)', { invocation: { argv: ["", "arg"] } }),
		).toBe("['', 'arg']\n");
		const failed = await kernel.execute('raise RuntimeError("invoked")', {
			invocation: { argv: [filename], filename },
		});
		expect(failed.error?.traceback.join("\n")).toContain(`File "${filename}", line 1`);
		expect(await run(kernel, 'assert "__file__" not in globals(); print(sys.argv)')).toBe("['-c']\n");
	} finally {
		await kernel.shutdown();
	}
});

kernelTest("completion drains owned asyncio descendants and preserves native explicit thread joins", async () => {
	using dir = TempDir.createSync("@python-native-completion-");
	const kernel = await PythonKernel.start({ cwd: dir.path() });
	try {
		expect(
			await run(
				kernel,
				`import asyncio
async def grandchild():
    await asyncio.sleep(0)
    print("grandchild")
async def child():
    await asyncio.sleep(0)
    asyncio.create_task(grandchild())
    print("child")
asyncio.create_task(child())
await asyncio.sleep(0)
print("body")`,
			),
		).toBe("body\nchild\ngrandchild\n");
		expect(
			await run(
				kernel,
				`import threading
release_thread = threading.Event()
def worker():
    release_thread.wait()
    print("thread-finished")
thread = threading.Thread(target=worker)
thread.start()
print("thread-started")
release_thread.set()
thread.join()`,
			),
		).toBe("thread-started\nthread-finished\n");
		expect(await run(kernel, 'assert not thread.is_alive(); print("settled")')).toBe("settled\n");
	} finally {
		await kernel.shutdown();
	}
});

kernelTest("retained asyncio tasks and native runtime threads keep output ownership across cells", async () => {
	using dir = TempDir.createSync("@python-native-retention-");
	const kernel = await PythonKernel.start({ cwd: dir.path() });
	const first: string[] = [];
	try {
		const started = await kernel.execute(
			`import asyncio, threading
async_gate = asyncio.Event()
thread_gate = threading.Event()
async def retained_async():
    await asyncio.sleep(0)
    retain_task(asyncio.current_task())
    await async_gate.wait()
    print("retained-async")
def retained_thread():
    thread_gate.wait()
    print("retained-thread")
retained = asyncio.create_task(retained_async())
thread = threading.Thread(target=retained_thread)
thread.start()
await asyncio.sleep(0)
print("retained-ready")`,
			{ onChunk: text => void first.push(text) },
		);
		expect(started.status, first.join("")).toBe("ok");
		expect(first.join("")).toBe("retained-ready\n");
		expect(await kernel.isBusy()).toBe(false); // Retention does not disable the host idle-reap policy.
		expect(
			await run(
				kernel,
				`thread_gate.set()
thread.join()
async_gate.set()
await retained
print("released")`,
			),
		).toBe("released\n");
		expect(first.join("")).toContain("retained-thread\n");
		expect(first.join("")).toContain("retained-async\n");
	} finally {
		await kernel.shutdown();
	}
});

kernelTest(
	"SIGINT interrupts ordinary code and asyncio.run on the main thread without losing state",
	async () => {
		using dir = TempDir.createSync("@python-native-interrupt-");
		const kernel = await PythonKernel.start({ cwd: dir.path() });
		try {
			for (const body of [
				"while True:\n    pass",
				"async def blocked():\n    await asyncio.Event().wait()\nasyncio.run(blocked())",
				"async def busy_task():\n    print('task-ready', flush=True)\n    while True:\n        pass\nasyncio.create_task(busy_task())\nawait asyncio.sleep(60)",
			]) {
				const controller = new AbortController();
				const ready = Promise.withResolvers<void>();
				const marker = body.includes("busy_task") ? "task-ready" : "interrupt-ready";
				const result = kernel.execute(
					`import asyncio\nnative_survivor = 42\nprint("interrupt-ready", flush=True)\n${body}`,
					{
						signal: controller.signal,
						onChunk: text => {
							if (text.includes(marker)) ready.resolve();
						},
					},
				);
				await Promise.race([
					ready.promise,
					result.then(outcome => {
						throw new Error(`Cell exited before readiness: ${JSON.stringify(outcome)}`);
					}),
				]);
				controller.abort();
				expect(await result).toMatchObject({ status: "error", cancelled: true });
				expect(await run(kernel, "print(native_survivor)")).toBe("42\n");
			}
		} finally {
			await kernel.shutdown();
		}
	},
	15_000,
);

kernelTest("unconsumed native stdin does not block completion and atexit remains process-lifetime", async () => {
	using dir = TempDir.createSync("@python-native-shutdown-");
	const kernel = await PythonKernel.start({ cwd: dir.path() });
	const marker = `${dir.path()}/atexit.txt`;
	try {
		const stdin = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(1_000_000));
				controller.close();
			},
		});
		expect(
			await run(
				kernel,
				`import atexit
from pathlib import Path
def at_shutdown():
    Path(${JSON.stringify(marker)}).write_text("native-exit")
atexit.register(at_shutdown)
print("cell-complete")`,
				{ stdin },
			),
		).toBe("cell-complete\n");
		expect(await Bun.file(marker).exists()).toBe(false);
		expect(await run(kernel, 'print("next-cell")')).toBe("next-cell\n");
		expect(await Bun.file(marker).exists()).toBe(false);
		expect((await kernel.shutdown()).confirmed).toBe(true);
		expect(await Bun.file(marker).text()).toBe("native-exit");
	} finally {
		if (kernel.isAlive()) await kernel.shutdown();
	}
});

kernelTest("awaited task failures stay handled and child SystemExit does not strand a request", async () => {
	using dir = TempDir.createSync("@python-native-task-failure-");
	const kernel = await PythonKernel.start({ cwd: dir.path() });
	try {
		expect(
			await run(
				kernel,
				`import asyncio
async def fail():
    raise ValueError("handled")
failed_task = asyncio.create_task(fail())
try:
    await failed_task
except ValueError:
    print("caught")`,
			),
		).toBe("caught\n");
		const exiting = await kernel.execute(`async def exit_child():
    raise SystemExit(7)
asyncio.create_task(exit_child())
await asyncio.sleep(60)`);
		expect(exiting).toMatchObject({ status: "error", exitCode: 7, cancelled: false });
		expect(await run(kernel, 'print("after-child-exit")')).toBe("after-child-exit\n");
	} finally {
		await kernel.shutdown();
	}
});

kernelTest("filesystem receipts are sideband and never contaminate binary program output", async () => {
	using dir = TempDir.createSync("@python-native-sideband-");
	const kernel = await PythonKernel.start({ cwd: dir.path() });
	try {
		const stdout: Uint8Array[] = [];
		const stderr: Uint8Array[] = [];
		const notes: string[] = [];
		const result = await kernel.execute(
			`import sys
from pathlib import Path
Path("created.txt").write_text("native")
sys.stdout.buffer.write(b"\\x00\\xffnative\\n")`,
			{
				onBytes: (bytes, stream) => {
					(stream === "stdout" ? stdout : stderr).push(bytes);
				},
				onDisplay: output => {
					if (output.type === "status" && output.event.op === "note") notes.push(String(output.event.text));
				},
			},
		);
		expect(result.status).toBe("ok");
		expect(Buffer.concat(stdout)).toEqual(Buffer.from([0, 255, ...Buffer.from("native\n")]));
		expect(Buffer.concat(stderr)).toHaveLength(0);
		expect(notes.join("")).toContain("<kernel> note: created created.txt");
	} finally {
		await kernel.shutdown();
	}
});

kernelTest("thread pools reuse native workers across cells and shut down only with the interpreter", async () => {
	using dir = TempDir.createSync("@python-native-executor-");
	const kernel = await PythonKernel.start({ cwd: dir.path() });
	try {
		expect(
			await run(
				kernel,
				`from concurrent.futures import ThreadPoolExecutor
import atexit, threading
pool = ThreadPoolExecutor(max_workers=1)
pool_worker = pool.submit(threading.current_thread).result()
print(pool.submit(lambda: 21 * 2).result())`,
			),
		).toBe("42\n");
		expect(await run(kernel, "print(pool.submit(lambda: 6 * 7).result())")).toBe("42\n");
		const marker = `${dir.path()}/pool-shutdown.txt`;
		await run(
			kernel,
			`from pathlib import Path
def after_pool_shutdown():
    assert not pool_worker.is_alive()
    Path(${JSON.stringify(marker)}).write_text("pool-stopped")
atexit.register(after_pool_shutdown)`,
		);
		expect(await Bun.file(marker).exists()).toBe(false);
		expect((await kernel.shutdown()).confirmed).toBe(true);
		expect(await Bun.file(marker).text()).toBe("pool-stopped");
	} finally {
		if (kernel.isAlive()) await kernel.shutdown();
	}
});

kernelTest("completion is published only after native stream cleanup and request retirement", async () => {
	if (process.platform === "win32") return;
	using dir = TempDir.createSync("@python-native-completion-barrier-");
	const kernel = await PythonKernel.start({ cwd: dir.path() });
	let pid: number | undefined;
	let settled = false;
	const cleanupEntered = Promise.withResolvers<void>();
	try {
		const execution = kernel
			.execute(
				`import os, signal, sys, threading
cleanup_entered = threading.Event()
cleanup_release = threading.Event()
signal.signal(signal.SIGUSR1, lambda *_: cleanup_release.set())
def report_cleanup():
    cleanup_entered.wait()
    print("cleanup-entered", os.getpid(), flush=True)
threading.Thread(target=report_cleanup).start()
original_stdin_close = sys.stdin.close
def close_stdin():
    cleanup_entered.set()
    cleanup_release.wait()
    original_stdin_close()
sys.stdin.close = close_stdin`,
				{
					onChunk: text => {
						const match = /cleanup-entered (\d+)/.exec(text);
						if (match) {
							pid = Number(match[1]);
							cleanupEntered.resolve();
						}
					},
				},
			)
			.then(result => {
				settled = true;
				return result;
			});
		await cleanupEntered.promise;
		try {
			// A real protocol round trip is the barrier: no scheduling delay or polling.
			expect((await kernel.requestStatus(10_000))?.busy).toBe(1);
			expect(settled).toBe(false);
		} finally {
			process.kill(pid!, "SIGUSR1");
			await execution;
		}
		expect((await execution).status).toBe("ok");
		expect((await kernel.requestStatus(10_000))?.busy).toBe(0);
	} finally {
		await kernel.shutdown();
	}
});
