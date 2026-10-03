import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Print mode exits the process on lost durability, so the run happens in a child process against a session double.
const printModeEntry = path.resolve(import.meta.dir, "print-mode.ts");
const settingsEntry = path.resolve(import.meta.dir, "..", "config", "settings.ts");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-print-persistence-"));
afterAll(() => fs.rm(root, { recursive: true, force: true }));

async function runFixture(recovered: boolean): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const fixture = path.join(root, `fixture-${recovered ? "recovered" : "latched"}.ts`);
	await fs.writeFile(
		fixture,
		`import { Settings } from ${JSON.stringify(settingsEntry)};
import { runPrintMode } from ${JSON.stringify(printModeEntry)};
await Settings.init({ inMemory: true });
const failure = new Error("disk full\\nsecond line");
let onPersistenceError = () => {};
const session = {
	extensionRunner: undefined,
	skillWarnings: [],
	orchestratorParent: undefined,
	sessionManager: {
		getHeader: () => undefined,
		getPersistenceUnavailable: () => undefined,
		onPersistenceError(cb) { onPersistenceError = cb; return () => {}; },
	},
	subscribe() {},
	setTextOutputCommitted() {},
	async prompt() { onPersistenceError(failure); },
	prepareForHeadlessAdvisorDrain() {},
	getLastAssistantMessage: () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ANSWER" }] }),
	deadlineExceeded: () => false,
	async waitForAdvisorCatchup() {},
	async dispose() { if (!${recovered}) throw failure; },
};
await runPrintMode(session, { mode: "text", initialMessage: "hi" });
process.stdout.write("RETURNED\\n");
`,
	);
	const child = Bun.spawn([process.execPath, fixture], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

test("a store failure still latched at dispose reports lost durability and exits 1", async () => {
	const result = await runFixture(false);

	expect(result.stdout).toContain("ANSWER");
	expect(result.stdout).not.toContain("RETURNED");
	expect(result.stderr).toContain("Session persistence failed: disk full second line. Writes are retried");
	expect(result.stderr).toContain("Session persistence is still failing at shutdown: disk full second line.");
	expect(result.stderr).not.toContain("Uncaught");
	expect(result.exitCode).toBe(1);
});

test("a store failure that recovered before dispose only warns", async () => {
	const result = await runFixture(true);

	expect(result.stderr).toContain("Session persistence failed: disk full second line.");
	expect(result.stderr).not.toContain("still failing at shutdown");
	expect(result.stdout).toContain("RETURNED");
	expect(result.exitCode).toBe(0);
});
