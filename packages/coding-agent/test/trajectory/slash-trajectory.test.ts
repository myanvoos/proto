import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const T0 = Date.UTC(2026, 7, 27, 12, 0, 0);

function fakeSessionManager() {
	return {
		getHeader: () => ({ id: "sess-test", title: "Test session", cwd: process.cwd() }),
		getBranch: () => [
			{
				id: "e1",
				parentId: null,
				timestamp: new Date(T0).toISOString(),
				type: "message",
				message: { role: "user", content: "hello world", timestamp: T0 },
			},
		],
		getCwd: () => process.cwd(),
	} as unknown as SessionManager;
}

function createHarness(overrides?: Partial<Record<string, unknown>>) {
	const editorSetText = vi.fn();
	const ctx = {
		editor: { setText: editorSetText },
		sessionManager: fakeSessionManager(),
		showTrajectoryView: vi.fn(),
		presentCommandOutput: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		...overrides,
	} as unknown as InteractiveModeContext;
	return { editorSetText, ctx, runtime: { ctx } };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/trajectory slash command", () => {
	it("is registered in the builtin registry with export subcommands", () => {
		const spec = lookupBuiltinSlashCommand("trajectory");
		expect(spec).toBeDefined();
		expect(spec?.subcommands?.map(sub => sub.name)).toEqual(["view", "stats", "export"]);
	});

	it("opens the fullscreen ledger on bare invocation and clears the editor", async () => {
		const harness = createHarness();
		const result = await executeBuiltinSlashCommand("/trajectory", harness.runtime);
		expect(harness.ctx.showTrajectoryView).toHaveBeenCalledTimes(1);
		expect(harness.editorSetText).toHaveBeenCalledWith("");
		expect(result).toBe(true);
	});

	it("routes `view` args to the fullscreen ledger too", async () => {
		const harness = createHarness();
		await executeBuiltinSlashCommand("/trajectory view", harness.runtime);
		expect(harness.ctx.showTrajectoryView).toHaveBeenCalledTimes(1);
		expect(harness.ctx.presentCommandOutput).not.toHaveBeenCalled();
	});

	it("prints an inline stats panel for `stats`", async () => {
		const harness = createHarness();
		await executeBuiltinSlashCommand("/trajectory stats", harness.runtime);
		expect(harness.ctx.showTrajectoryView).not.toHaveBeenCalled();
		expect(harness.ctx.presentCommandOutput).toHaveBeenCalledTimes(1);
		const [component] = (harness.ctx.presentCommandOutput as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(component).toBeDefined();
	});

	it("writes a prime-rl episode file with reward to a custom path", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trajectory-export-"));
		const target = path.join(dir, "episode.jsonl");
		try {
			const harness = createHarness();
			await executeBuiltinSlashCommand(`/trajectory export prime-rl ${target} --reward 0.5`, harness.runtime);

			const payload = fs.readFileSync(target, "utf8");
			const parsed = JSON.parse(payload.trimEnd()) as {
				env: { id: string };
				traces: Array<{ rewards: Record<string, { score: number }> }>;
			};
			expect(parsed.env.id).toBe("proto");
			expect(parsed.traces[0].rewards.manual?.score).toBe(0.5);
			expect(harness.ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining(target));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects unknown export kinds via showError", async () => {
		const harness = createHarness();
		await executeBuiltinSlashCommand("/trajectory export parquet", harness.runtime);
		expect(harness.ctx.showError).toHaveBeenCalledWith(expect.stringContaining("otel"));
	});
});
