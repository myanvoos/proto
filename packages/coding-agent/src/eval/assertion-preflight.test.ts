import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	preflightKernelSource,
	preflightStreamedInput,
	resetStreamedAssertionPreflight,
	streamedAssertionPreflightCacheStats,
} from "./assertion-preflight";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	resetStreamedAssertionPreflight();
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function makeFixture(content: string): Promise<{ directory: string; file: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assertion-preflight-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "target.txt");
	await fs.writeFile(file, content, "utf8");
	return { directory, file };
}

function pythonCell(file: string): string {
	return [
		"from pathlib import Path",
		`p = Path(${JSON.stringify(file)})`,
		"text = p.read_text()",
		'old = "needle"',
		'new = "replacement"',
		"assert text.count(old) == 1",
	].join("\n");
}

function heredoc(code: string): string {
	return `python3 - <<'PY'\n${code}\nPY\n`;
}

test("finds the first failing Python count while JSON input is still streaming", async () => {
	const { directory, file } = await makeFixture("haystack\n");
	const cell = pythonCell(file);
	const command = heredoc(cell);
	const assertionEnd = command.indexOf("assert text.count(old) == 1") + "assert text.count(old) == 1".length;
	for (let end = 1; end <= assertionEnd; end += 7) {
		const partial = command.slice(0, end);
		const observed = await preflightStreamedInput("incremental-python", JSON.stringify({ command: partial }), {
			session: { cwd: directory },
		});
		expect(observed).toBeUndefined();
	}
	const failure = await preflightStreamedInput(
		"incremental-python",
		JSON.stringify({ command: command.slice(0, assertionEnd) }),
		{ session: { cwd: directory } },
	);
	if (!failure) throw new Error("expected the completed assertion prefix to fail");
	expect(failure.toolCallId).toBe("incremental-python");
	expect(failure.language).toBe("python");
	expect(failure.line).toBe(6);
	expect(failure.count).toBe(0);
	expect(failure.expected).toBe(1);
	expect(failure.message).toContain("count=0");
	expect(failure.message).toContain("expected=1");
	expect(failure.path).toBe(file);

	// The suffix is intentionally large and arrives only after the failure. The
	// preflight must stop at the first assertion rather than parse/evaluate it.
	const suffix = `\nreplacement = ${JSON.stringify("x".repeat(200_000))}\n`;
	const withSuffix = await preflightStreamedInput(
		"incremental-python",
		JSON.stringify({ command: command.slice(0, assertionEnd) + suffix }),
		{ session: { cwd: directory } },
	);
	expect(withSuffix?.count).toBe(0);
	expect(await fs.readFile(file, "utf8")).toBe("haystack\n");
});

test("does not treat nested metadata.command as the bash argument", async () => {
	const { directory, file } = await makeFixture("haystack\n");
	const command = heredoc(pythonCell(file));
	const nested = JSON.stringify({ metadata: { command } });
	expect(await preflightStreamedInput("nested-command", nested, { session: { cwd: directory } })).toBeUndefined();
});

test("never resolves a relative literal against the evaluator process cwd", async () => {
	const source = [
		"from pathlib import Path",
		' text = Path("target.txt").read_text()',
		'old = "missing"',
		"assert text.count(old) == 1",
	].join("\n");
	expect(await preflightKernelSource(source, { cwd: "." })).toBeUndefined();
});

test("supports a source-local Path variable and explicit builtins.open, but not inherited names", async () => {
	const { directory, file } = await makeFixture("needle\n");
	const passing = await preflightKernelSource(pythonCell(file), { cwd: directory });
	expect(passing).toBeUndefined();

	const failingWithOpen = [
		"from builtins import open",
		`text = open(${JSON.stringify(file)}, "r").read()`,
		'old = "missing"',
		"assert text.count(old) == 1",
	].join("\n");
	const failure = await preflightKernelSource(failingWithOpen, { cwd: directory });
	expect(failure?.count).toBe(0);
	expect(failure?.path).toBe(file);

	const inherited = [
		`text = Path(${JSON.stringify(file)}).read_text()`,
		'old = "missing"',
		"assert text.count(old) == 1",
	].join("\n");
	expect(await preflightKernelSource(inherited, { cwd: directory })).toBeUndefined();
});

test("fails open for unsafe dependencies, control flow, dynamic paths, and writes", async () => {
	const { directory, file } = await makeFixture("needle\n");
	const cases = [
		[
			"from pathlib import Path",
			"if True:",
			`    text = Path(${JSON.stringify(file)}).read_text()`,
			'    old = "missing"',
			"    assert text.count(old) == 1",
		],
		[
			"from pathlib import Path",
			`p = Path(${JSON.stringify(file)})`,
			"text = p.read_text()",
			"old = get_old_value()",
			"assert text.count(old) == 1",
		],
		[
			"from pathlib import Path",
			`Path(${JSON.stringify(file)}).write_text("changed")`,
			'assert "changed" == "changed"',
		],
		["import subprocess", 'subprocess.run(["true"])', "assert text.count(old) == 1"],
	];
	for (const lines of cases) expect(await preflightKernelSource(lines.join("\n"), { cwd: directory })).toBeUndefined();
	expect(await fs.readFile(file, "utf8")).toBe("needle\n");
});

test("does not evaluate incomplete strings/assertions or stale cached observations", async () => {
	const { directory, file } = await makeFixture("haystack\n");
	const complete = pythonCell(file);
	const incompleteString = complete.replace('old = "needle"', 'old = "needle');
	expect(await preflightKernelSource(incompleteString, { cwd: directory })).toBeUndefined();
	await fs.writeFile(file, "needle\n", "utf8");
	expect(await preflightKernelSource(`${complete}\nassert text.count(old) ==`, { cwd: directory })).toBeUndefined();
	await fs.writeFile(file, "haystack\n", "utf8");

	const raw = JSON.stringify({ command: heredoc(complete) });
	const first = await preflightStreamedInput("stale-python", raw, { session: { cwd: directory } });
	expect(first?.count).toBe(0);
	await fs.writeFile(file, "needle\n", "utf8");
	const afterMutation = await preflightStreamedInput("stale-python", raw, { session: { cwd: directory } });
	expect(afterMutation).toBeUndefined();
});

test("keeps an earlier proven failure visible past trailing incomplete literals", async () => {
	const { directory, file } = await makeFixture("haystack\n");
	const tripleQuote = '"'.repeat(3);
	const python = `${pythonCell(file)}\ntrailing = ${tripleQuote}\n${Array.from({ length: 60 }, (_, index) => `suffix-${index}`).join("\n")}`;
	const directPython = await preflightKernelSource(python, { cwd: directory });
	expect(directPython?.line).toBe(6);
	expect(directPython?.count).toBe(0);
	const streamedPython = await preflightStreamedInput(
		"trailing-python",
		JSON.stringify({ command: heredoc(python) }),
		{ session: { cwd: directory } },
	);
	expect(streamedPython?.line).toBe(6);

	const js = [
		'const fs = require("node:fs");',
		`const text = fs.readFileSync(${JSON.stringify(file)}, "utf8");`,
		'const old = "missing";',
		"console.assert(text.split(old).length - 1 === 1);",
		`const trailing = "${"z".repeat(60_000)}`,
	].join("\n");
	const directJs = await preflightKernelSource(js, { language: "js", cwd: directory });
	expect(directJs?.line).toBe(4);
	expect(directJs?.count).toBe(0);
	const streamedJs = await preflightStreamedInput(
		"trailing-js",
		JSON.stringify({ command: `node - <<'JS'\n${js}\nJS\n` }),
		{ session: { cwd: directory } },
	);
	expect(streamedJs?.line).toBe(4);
});

test("supports the explicit node:fs/readFileSync JavaScript count shape", async () => {
	const { directory, file } = await makeFixture("haystack\n");
	const source = [
		'const fs = require("node:fs");',
		`const text = fs.readFileSync(${JSON.stringify(file)}, "utf8");`,
		'const old = "missing";',
		"console.assert(text.split(old).length - 1 === 1);",
	].join("\n");
	const failure = await preflightKernelSource(source, { language: "js", cwd: directory });
	expect(failure?.language).toBe("js");
	expect(failure?.line).toBe(4);
	expect(failure?.count).toBe(0);
	expect(failure?.expected).toBe(1);

	const unsafe = source.replace('require("node:fs")', 'require("node:child_process")');
	expect(await preflightKernelSource(unsafe, { language: "js", cwd: directory })).toBeUndefined();
});

test("rejects non-regular files and bounded/binary reads", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assertion-preflight-files-"));
	temporaryDirectories.push(directory);
	const binary = path.join(directory, "binary");
	await fs.writeFile(binary, Buffer.from([0, 1, 2]));
	const source = pythonCell(binary);
	expect(await preflightKernelSource(source, { cwd: directory })).toBeUndefined();
	expect(await preflightKernelSource(source, { cwd: directory, maxFileBytes: 1 })).toBeUndefined();
});

test("bounds the streamed failure cache by bytes (1 MiB source stress)", async () => {
	const { directory, file } = await makeFixture("haystack\n");
	const base = pythonCell(file);
	const command = heredoc(`${base}\n# ${"é".repeat(1024 * 1024 - base.length - 10)}`);
	const raw = JSON.stringify({ command });
	const options = { session: { cwd: directory }, sessionKey: "cache-stress" };

	for (let index = 0; index < 40; index++) {
		const failure = await preflightStreamedInput(`cache-${index}`, raw, options);
		expect(failure?.count).toBe(0);
	}

	const stats = streamedAssertionPreflightCacheStats();
	expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
	expect(stats.entries).toBeLessThan(40);

	// The oldest entry was evicted, so a miss recomputes with the caller's
	// smaller file-read limit instead of returning stale cached output.
	const recomputed = await preflightStreamedInput("cache-0", raw, {
		...options,
		maxFileBytes: 1,
	});
	expect(recomputed).toBeUndefined();
});
