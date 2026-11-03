import { expect, test } from "bun:test";
import { runBunCli } from "./bun-cli";

test("the embedded Bun CLI runs even with no executable search path", async () => {
	const original = process.env.PATH;
	try {
		process.env.PATH = "";
		const result = await runBunCli(["--version"], import.meta.dir);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(Bun.version);
	} finally {
		if (original === undefined) delete process.env.PATH;
		else process.env.PATH = original;
	}
});
