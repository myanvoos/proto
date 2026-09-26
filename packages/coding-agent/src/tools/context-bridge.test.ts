import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { AsyncJobManager } from "../async";
import type { KeybindingsManager } from "../config/keybindings";
import { Settings } from "../config/settings";
import { disposeEvalArtifacts } from "../eval/artifact-values";
import { disposeSessionExecutionEvents } from "../eval/execution-events";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { disposeBashSessions } from "../exec/bash-executor";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { Theme } from "../modes/theme/theme";
import { ArtifactManager } from "../session/artifacts";
import { createTools, type Tool, type ToolSession } from ".";
import { handleContextControl } from "./context";

// Real BashTool → shell bridge → kernel cell → tool.context bridge; the origin is whatever dispatch assigns.
interface Harness {
	session: ToolSession;
	bash: Tool;
}

let mounted: Component | undefined;
afterEach(() => {
	mounted?.dispose?.();
	mounted = undefined;
});

/** A UI that mounts the real PTY overlay component headlessly; the overlay completes when its process exits. */
function headlessUi(): ExtensionUIContext {
	async function custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => Component | Promise<Component>,
	): Promise<T> {
		const completion = Promise.withResolvers<T>();
		const tui = { terminal: { rows: 24, columns: 80 }, requestRender: () => {} } as unknown as TUI;
		mounted = await factory(tui, {} as Theme, {} as KeybindingsManager, completion.resolve);
		return await completion.promise;
	}
	return { custom } as unknown as ExtensionUIContext;
}

async function fixture(
	run: (bash: (lane: string, command: string) => Promise<string>, harness: Harness) => Promise<void>,
) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "context-bridge-"));
	const owner = `context-bridge:${crypto.randomUUID()}`;
	const artifacts = new ArtifactManager(path.join(cwd, "artifacts"));
	const jobs = new AsyncJobManager({});
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"tools.xdev": false,
			"bash.direnv": "off",
		}),
		getSessionId: () => owner,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactsDir: () => artifacts.dir,
		getArtifactManager: () => artifacts,
		allocateOutputArtifact: kind => artifacts.allocatePath(kind),
		asyncJobManager: jobs,
	};
	try {
		await createTools(session, ["bash", "context"]);
		const tools: Map<string, Tool> = session.toolRegistry!;
		session.getToolByName = name => tools.get(name);
		session.getToolForEvalBridge = name => tools.get(name);
		session.getEvalBridgeToolNames = () => [...tools.keys()];
		const bash = tools.get("bash")!;
		await run(
			async (lane, command) => {
				const result = await bash.execute("context-bridge", { lane, command, timeout: 60 });
				return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			},
			{ session, bash },
		);
	} finally {
		await disposeSessionExecutionEvents(session);
		await jobs.dispose();
		await Promise.all([
			disposeBashSessions(owner),
			disposeKernelSessionsByOwner(owner),
			disposeVmContextsByOwner(owner),
		]);
		disposeEvalArtifacts(session);
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

const cells = {
	python: {
		seed: "marker = 41",
		read: 'print("marker=" + str(globals().get("marker")))',
		control: (args: string) =>
			`try:\n    tool.context(${args})\n    print("CONTROL ACCEPTED")\nexcept Exception as error:\n    print("CONTROL REJECTED:", error)`,
	},
	bun: {
		seed: "var marker = 41",
		read: 'console.log("marker=" + (typeof marker === "undefined" ? "None" : marker))',
		control: (args: string) =>
			`try { await tool.context(${args}); console.log("CONTROL ACCEPTED"); } catch (error) { console.log("CONTROL REJECTED:", error.message); }`,
	},
} as const;

for (const language of ["python", "bun"] as const) {
	const cell = cells[language];
	const command = (code: string) => `${language} <<'CELL'\n${code}\nCELL`;
	test(`a ${language} cell cannot reset or close its own lane or kernel; another lane's cell can`, async () => {
		await fixture(async bash => {
			await bash("work", "export SHELL_MARKER=kept");
			expect(await bash("work", command(cell.seed))).not.toContain("Error");
			const own = [
				`{"resource": "lane", "op": "reset", "lane": "work"}`,
				`{"resource": "lane", "op": "close", "lane": "work", "force": True}`,
				`{"resource": "kernel", "op": "reset", "language": "${language}", "lane": "work"}`,
				`{"resource": "kernel", "op": "close", "language": "${language}", "lane": "work", "force": True}`,
			].map(args => (language === "python" ? args : args.replace("True", "true")));
			for (const args of own) {
				const output = await bash("work", command(cell.control(args)));
				expect(output).toContain("CONTROL REJECTED:");
				expect(output).toMatch(/Cannot (reset|close) (lane work|the \w+ kernel of lane work)/);
			}
			// Rejected before mutation: heap, shell and generation survive with no state-loss notice.
			const kept = await bash("work", `printf 'shell=%s\\n' "$SHELL_MARKER"; ${command(cell.read)}`);
			expect(kept).toContain("marker=41");
			expect(kept).toContain("shell=kept");
			expect(kept).not.toContain("state lost");

			const outer = await bash(
				"control",
				command(cell.control(`{"resource": "lane", "op": "reset", "lane": "work"}`)),
			);
			expect(outer).toContain("CONTROL ACCEPTED");
			const reset = await bash("work", `printf 'shell=%s\\n' "$SHELL_MARKER"; ${command(cell.read)}`);
			expect(reset).toContain("marker=None");
			expect(reset).toContain("shell=\n");
			expect(reset).toContain("<shell> state lost: lane work was reset by context control");
		});
	}, 60_000);
}

test("an interactive PTY command waits its turn in the lane FIFO and never runs once a lane reset cancels it", async () => {
	await fixture(async (_run, { session, bash }) => {
		const cwd = session.cwd;
		const ptyContext = { hasUI: true, ui: headlessUi() } as never;
		const running = Promise.withResolvers<void>();
		const blocker = bash.execute(
			"blocker",
			{ lane: "work", command: "echo RUNNING; sleep 30", timeout: 60 },
			undefined,
			update => {
				if (update.content.some(block => block.type === "text" && block.text.includes("RUNNING")))
					running.resolve();
			},
		);
		await running.promise;
		const pty = bash
			.execute(
				"pty",
				{ lane: "work", pty: true, command: "touch pty-ran", timeout: 60 },
				undefined,
				undefined,
				ptyContext,
			)
			.then(
				result => ({ ok: true as const, result }),
				(error: unknown) => ({ ok: false as const, error: String(error) }),
			);
		const inspected = await handleContextControl(session, { resource: "lane", op: "inspect", lane: "work" });
		expect(inspected).toMatchObject({ lane: { state: "busy", queued: 1 } });

		const reset = await handleContextControl(session, { resource: "lane", op: "reset", lane: "work" });
		expect(reset).toMatchObject({ cancelled: { active: 1, queued: 1 } });
		const outcome = await pty;
		expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("lane work was reset") });
		await blocker.catch(() => undefined);
		expect(await Bun.file(path.join(cwd, "pty-ran")).exists()).toBe(false);

		// A PTY command issued afterwards runs on the fresh lane.
		const after = await bash.execute(
			"pty-after",
			{ lane: "work", pty: true, command: "touch pty-after", timeout: 60 },
			undefined,
			undefined,
			ptyContext,
		);
		expect(after.isError).not.toBe(true);
		// Proves the call took the interactive PTY path rather than the non-PTY fallback.
		expect(JSON.stringify(after.content)).not.toContain("pty requested but unavailable");
		expect(await Bun.file(path.join(cwd, "pty-after")).exists()).toBe(true);
	});
}, 60_000);
