import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeKernelSessionsByOwner, executePython } from "./executor";

test("%%capture preserves small output and binding while bounding large output", async () => {
	using tempDir = TempDir.createSync("@python-kernel-capture-bounds-");
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const options = {
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		sessionId: `test-session:${crypto.randomUUID()}`,
		kernelOwnerId: ownerId,
		kernelMode: "session" as const,
		timeoutMs: 30_000,
	};
	try {
		const small = await executePython("%%capture captured_small\nprint('first')\nprint('second')", options);
		expect(small.output).toContain("first\\nsecond\\n");
		const smallBinding = await executePython("print(len(captured_small), repr(captured_small))", options);
		expect(smallBinding.output).toContain("13 'first\\nsecond\\n'");

		await executePython("%%capture captured_large\nprint('x' * 1_100_000)\nprint('not retained')", options);
		const largeBinding = await executePython(
			"print(len(captured_large) <= 1048576 + 150, captured_large.endswith('remaining output discarded]\\n'), 'not retained' not in captured_large)",
			options,
		);
		expect(largeBinding.output).toContain("True True True");

		await executePython("%%capture captured_lines\nprint('row\\n' * 3005, end='')", options);
		const lineBinding = await executePython(
			"print(captured_lines.count('row'), captured_lines.endswith('remaining output discarded]\\n'))",
			options,
		);
		expect(lineBinding.output).toContain("3000 True");
	} finally {
		await disposeKernelSessionsByOwner(ownerId);
	}
}, 120_000);

test("defs metadata prunes deleted names without losing live definitions", async () => {
	using tempDir = TempDir.createSync("@python-kernel-defs-prune-");
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const options = {
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		sessionId: `test-session:${crypto.randomUUID()}`,
		kernelOwnerId: ownerId,
		kernelMode: "session" as const,
		timeoutMs: 30_000,
	};
	try {
		await executePython("transient_for_defs = 1\ndef live_for_defs():\n    return 2", options);
		await executePython("del transient_for_defs", options);
		const result = await executePython("print('transient_for_defs' in defs(), 'live_for_defs' in defs())", options);
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
