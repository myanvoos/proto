import { expect, test } from "bun:test";
import { ptree } from "@oh-my-pi/pi-utils";
import { checkPythonKernelAvailability, PythonKernel } from "./kernel";
import { stagePythonRuntimeAssets } from "./runtime-assets";

test("Python completion identities reset on reused request IDs and remain distinct within parallel work", async () => {
	const invocations: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			const body = (await request.json()) as { name: string; args: { _completionInvocationId: string } };
			if (body.name === "__concurrency__") return Response.json({ value: { limit: 2 } });
			if (body.name !== "__completion__")
				return Response.json({ error: { message: "Unexpected operation" } }, { status: 400 });
			invocations.push(body.args._completionInvocationId);
			return Response.json({ value: { text: "answer" } });
		},
	});
	const kernel = await PythonKernel.start({
		cwd: process.cwd(),
		env: {
			PI_PYTHON_HARNESS_URL: new URL("request", server.url).href,
			PI_PYTHON_HARNESS_TOKEN: "test-token",
		},
	});
	try {
		for (let run = 0; run < 2; run++) {
			invocations.length = 0;
			const result = await kernel.execute(
				"import proto_harness as harness\n" +
					'harness.parallel([lambda: harness.completion("first"), lambda: harness.completion("second")])',
				{
					id: "reused-request",
				},
			);
			expect(result.status).toBe("ok");
			expect(invocations.toSorted()).toEqual(["0", "1"]);
		}
	} finally {
		expect((await kernel.shutdown()).confirmed).toBe(true);
		await server.stop(true);
	}
}, 20_000);

test("retained completion work keeps its originating cell ordinal scope instead of stealing the next cell counter", async () => {
	const calls: { prompt: string; ordinal: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			const body = (await request.json()) as {
				name: string;
				args: { prompt: string; _completionInvocationId: string };
			};
			if (body.name !== "__completion__")
				return Response.json({ error: { message: "Unexpected operation" } }, { status: 400 });
			calls.push({ prompt: body.args.prompt, ordinal: body.args._completionInvocationId });
			return Response.json({ value: { text: "answer" } });
		},
	});
	const kernel = await PythonKernel.start({
		cwd: process.cwd(),
		env: {
			PI_PYTHON_HARNESS_URL: new URL("request", server.url).href,
			PI_PYTHON_HARNESS_TOKEN: "test-token",
		},
	});
	try {
		const first = await kernel.execute(`import asyncio
import proto_harness as harness
gate = asyncio.Event()
async def later():
    await gate.wait()
    return harness.completion("retained")
await asyncio.sleep(0)
background = harness.retain_task(asyncio.create_task(later()))
harness.completion("first")`);
		expect(first.status, JSON.stringify(first.error)).toBe("ok");
		const next = await kernel.execute(`harness.completion("second")
gate.set()
await background
harness.completion("second-tail")`);
		expect(next.status, JSON.stringify(next.error)).toBe("ok");
		expect(calls).toEqual([
			{ prompt: "first", ordinal: "0" },
			{ prompt: "second", ordinal: "0" },
			{ prompt: "retained", ordinal: "1" },
			{ prompt: "second-tail", ordinal: "1" },
		]);
	} finally {
		expect((await kernel.shutdown()).confirmed).toBe(true);
		await server.stop(true);
	}
}, 20_000);

test("native fresh completion calls share only their own process counter and restart from zero in the next process", async () => {
	const calls: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			const body = (await request.json()) as { name: string; args: { _completionInvocationId: string } };
			if (body.name === "__concurrency__") return Response.json({ value: { limit: 2 } });
			if (body.name !== "__completion__")
				return Response.json({ error: { message: "Unexpected operation" } }, { status: 400 });
			calls.push(body.args._completionInvocationId);
			return Response.json({ value: { text: "answer" } });
		},
	});
	const available = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!available.pythonPath) throw new Error(available.reason);
	const env = {
		...process.env,
		PYTHONPATH: await stagePythonRuntimeAssets(),
		PI_PYTHON_HARNESS_URL: new URL("request", server.url).href,
		PI_PYTHON_HARNESS_TOKEN: "test-token",
	};
	try {
		await ptree.exec(
			[
				available.pythonPath,
				"-c",
				'import proto_harness as harness; harness.parallel([lambda: harness.completion("one"), lambda: harness.completion("two")]); harness.completion("three")',
			],
			{ env, timeout: 15_000 },
		);
		expect(calls.toSorted()).toEqual(["0", "1", "2"]);
		calls.length = 0;
		await ptree.exec([available.pythonPath, "-c", 'import proto_harness as harness; harness.completion("one")'], {
			env,
			timeout: 15_000,
		});
		expect(calls).toEqual(["0"]);
	} finally {
		await server.stop(true);
	}
}, 30_000);
