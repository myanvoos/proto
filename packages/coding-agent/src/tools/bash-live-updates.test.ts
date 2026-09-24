import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from ".";
import { BashTool, type BashToolDetails } from "./bash";

function stubSession(cwd: string): ToolSession {
	const settings: Record<string, unknown> = {};
	return {
		cwd,
		settings: { get: (key: string) => settings[key], getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `bash-live-updates-test:${cwd}`,
		getEvalKernelOwnerId: () => `bash-live-updates-test:${process.pid}`,
	} as unknown as ToolSession;
}

function textOf(result: AgentToolResult<BashToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

test("coalesces 100k kernel status events while flushing the exact final output", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bash-live-updates-"));
	try {
		const updates: AgentToolResult<BashToolDetails>[] = [];
		const bash = new BashTool(stubSession(cwd));
		const result = await bash.execute(
			"coalesced-live-updates",
			{
				command: `bun <<'JSEOF'
const emit = globalThis["__proto_" + "emit_status__"];
for (let i = 0; i < 100_000; i++) emit("agent", { id: "rate", status: "running", lastIntent: String(i) });
emit("write", { path: "first.txt", bytes: 1 });
emit("write", { path: "second.txt", bytes: 2 });
process.stdout.write("exact-final\\n");
JSEOF`,
			},
			undefined,
			update => updates.push(update),
		);

		expect(updates.length, "live updates are timer-coalesced instead of per status event").toBeLessThan(100);
		expect(updates.some(update => (update.details?.statusEvents?.length ?? 0) > 0)).toBe(true);
		expect(textOf(result)).toStartWith("exact-final\n");
		const finalStatusEvents = result.details?.statusEvents ?? [];
		expect(finalStatusEvents.filter(event => event.op === "write").map(event => event.path)).toEqual([
			"first.txt",
			"second.txt",
		]);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 60_000);
