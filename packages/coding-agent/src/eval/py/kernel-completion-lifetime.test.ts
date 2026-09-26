import { expect, test } from "bun:test";
import { PythonKernel } from "./kernel";

test("Python completion identities reset on reused request IDs and remain distinct within parallel work", async () => {
	const invocations: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			const body = (await request.json()) as { completionInvocationId: string };
			invocations.push(body.completionInvocationId);
			return Response.json({ ok: true, value: { text: "answer" } });
		},
	});
	const kernel = await PythonKernel.start({
		cwd: process.cwd(),
		env: {
			PI_TOOL_BRIDGE_URL: server.url.href,
			PI_TOOL_BRIDGE_TOKEN: "test-token",
			PI_TOOL_BRIDGE_SESSION: "completion-lifetime",
		},
	});
	try {
		for (let run = 0; run < 2; run++) {
			invocations.length = 0;
			const result = await kernel.execute('parallel([lambda: completion("first"), lambda: completion("second")])', {
				id: "reused-request",
			});
			expect(result.status).toBe("ok");
			expect(invocations.toSorted()).toEqual(["0", "1"]);
		}
	} finally {
		await kernel.shutdown();
		await server.stop(true);
	}
}, 20_000);
