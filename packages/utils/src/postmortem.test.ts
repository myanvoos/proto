import { expect, test } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { TempDir } from "./temp";

test("quit drains large piped stdout before exiting successfully", async () => {
	await using fixture = await TempDir.create("@proto-stdout-drain-");
	const source = path.join(import.meta.dir, "postmortem.ts");
	const script = fixture.join("writer.ts");
	await Bun.write(
		script,
		`
import { quit } from ${JSON.stringify(source)};
process.stdout.write("界x".repeat(2 * 1024 * 1024));
await quit(0);
`,
	);
	const result = await $`${process.execPath} ${script}`.quiet().nothrow();
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	expect(result.stdout.byteLength).toBe(8 * 1024 * 1024);
	expect(result.text()).toBe("界x".repeat(2 * 1024 * 1024));
}, 15_000);
