import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeKernelSessionsByOwner, executePython } from "./executor";

test("native redirect_stdout retains captured bindings while emitted output stays bounded", async () => {
	using tempDir = TempDir.createSync("@python-kernel-capture-bounds-");
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const options = {
		cwd: tempDir.path(),
		sessionId: `test-session:${crypto.randomUUID()}`,
		kernelOwnerId: ownerId,
		timeoutMs: 30_000,
	};
	try {
		const small = await executePython(
			"import io, contextlib\ncaptured = io.StringIO()\nwith contextlib.redirect_stdout(captured):\n    print('first')\n    print('second')\ncaptured_small = captured.getvalue()",
			options,
		);
		expect(small.exitCode, small.output).toBe(0);
		expect(small.output).toBe("");
		const smallBinding = await executePython("print(len(captured_small), repr(captured_small))", options);
		expect(smallBinding.output).toContain("13 'first\\nsecond\\n'");

		const large = await executePython("print('x' * 1_100_000)\nprint('tail-marker')", options);
		expect(large.exitCode, large.output).toBe(0);
		expect(large.truncated).toBe(true);
		expect(large.totalBytes).toBeGreaterThan(1_100_000);
		expect(large.outputBytes).toBeLessThan(large.totalBytes);
		expect(large.output).toContain("tail-marker");

		const lines = await executePython("print('row\\n' * 100_005, end='')", options);
		expect(lines.exitCode).toBe(0);
		expect(lines.totalLines).toBeGreaterThanOrEqual(100_005);
		expect(lines.truncated).toBe(true);
		expect(lines.outputLines).toBeLessThan(lines.totalLines);
	} finally {
		await disposeKernelSessionsByOwner(ownerId);
	}
}, 120_000);

test("defs metadata prunes deleted names without losing live definitions", async () => {
	using tempDir = TempDir.createSync("@python-kernel-defs-prune-");
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const options = {
		cwd: tempDir.path(),
		sessionId: `test-session:${crypto.randomUUID()}`,
		kernelOwnerId: ownerId,
		timeoutMs: 30_000,
	};
	try {
		await executePython(
			"import proto_harness as harness\n" + "transient_for_defs = 1\ndef live_for_defs():\n    return 2",
			options,
		);
		await executePython("import proto_harness as harness\n" + "del transient_for_defs", options);
		const result = await executePython(
			"import proto_harness as harness\n" +
				"print('transient_for_defs' in harness.defs(), 'live_for_defs' in harness.defs())",
			options,
		);
		expect(result.output).toContain("False True");
	} finally {
		await disposeKernelSessionsByOwner(ownerId);
	}
}, 120_000);

test("request queues reject count and byte overflow", async () => {
	const runner = `${import.meta.dir}/runner.py`;
	const script = `import runpy\nns = runpy.run_path(${JSON.stringify(runner)})\nQ = ns['_BoundedRequestQueue']\nq = Q()\nassert q.put_nowait({'id': 'one'}, 1)\nfor i in range(ns['_REQUEST_QUEUE_MAX_COUNT'] - 1):\n    assert q.put_nowait({'id': str(i)}, 1)\nassert not q.put_nowait({'id': 'overflow'}, 1)\nq2 = Q()\nassert q2.put_nowait({'id': 'large'}, ns['_REQUEST_QUEUE_MAX_BYTES'])\nassert not q2.put_nowait({'id': 'overflow'}, 1)\nerrors = []\nns['_emit_queue_limit_error'].__globals__['_emit_error'] = lambda rid, exc: errors.append((rid, str(exc)))\nns['_emit_queue_limit_error']({'id': 'too-large'})\nassert errors == [('too-large', f"Request queue limit exceeded (max {ns['_REQUEST_QUEUE_MAX_COUNT']} queued requests and {ns['_REQUEST_QUEUE_MAX_BYTES']} bytes)")]\nprint('queue limits enforced')\n`;
	const proc = Bun.spawn(["python3", "-c", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toContain("queue limits enforced");
});
