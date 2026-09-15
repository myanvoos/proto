import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

function makeBash(cwd: string): BashTool {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "kernel.assertPreflight.enabled": true, "kernel.speculation.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	return new BashTool(session);
}

test("an in-flight assertion preflight survives newer deltas and reports on the older observation", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bash-assert-preflight-"));
	try {
		fs.writeFileSync(path.join(cwd, "anchor.txt"), "old\nold\n", "utf8");
		const bash = makeBash(cwd);
		const toolCallId = "streamed-assert";
		const head = [
			"python - <<'PY'",
			"from pathlib import Path",
			'text = Path("anchor.txt").read_text()',
			'assert text.count("old") == 1',
			"",
		].join("\n");
		const raw = `{"command":${JSON.stringify(`${head}payload = '''\n${"x".repeat(4_000)}\n'''\nPY\n`)}}`;
		const provenPrefix = raw.slice(0, `{"command":${JSON.stringify(head)}`.length - 1);

		const earlier = bash.observeStreamedInput(toolCallId, provenPrefix);
		// Start the queued preflight now; it is mid file-read when the next delta lands.
		await bash.flushStreamedInput(toolCallId);
		const later = bash.observeStreamedInput(toolCallId, raw.slice(0, provenPrefix.length + 512));

		const failure = await earlier;
		expect(failure?.toolCallId).toBe(toolCallId);
		expect(failure?.message).toContain("count=2");
		// Every extension of the proven prefix reports the same failure.
		expect((await later)?.message).toBe(failure?.message);
		bash.cancelStreamedInput(toolCallId);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("cancelling a streamed call discards its in-flight preflight result", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bash-assert-preflight-cancel-"));
	try {
		fs.writeFileSync(path.join(cwd, "anchor.txt"), "old\nold\n", "utf8");
		const bash = makeBash(cwd);
		const toolCallId = "cancelled-assert";
		const command = `python - <<'PY'\nfrom pathlib import Path\ntext = Path("anchor.txt").read_text()\nassert text.count("old") == 1\n`;
		const observation = bash.observeStreamedInput(toolCallId, `{"command":${JSON.stringify(command).slice(0, -1)}`);
		await bash.flushStreamedInput(toolCallId);
		bash.cancelStreamedInput(toolCallId);
		expect(await observation).toBeUndefined();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
