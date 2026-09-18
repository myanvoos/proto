import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { KernelShellBridgeHandle } from "../eval/shell-bridge";
import * as shellBridge from "../eval/shell-bridge";
import type { ToolSession } from ".";
import { BashTool } from "./bash";
import { ToolAbortError } from "./tool-errors";

function stubSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: {
			get: (key: string) => {
				if (key === "async.enabled" || key === "bash.autoBackground.enabled") return false;
				return undefined;
			},
			getShellConfig: () => ({ env: {} }),
		},
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `bash-lifecycle-test:${cwd}`,
		getEvalKernelOwnerId: () => `bash-lifecycle-test:${process.pid}`,
	} as unknown as ToolSession;
}

afterEach(() => vi.restoreAllMocks());

test("aborting a foreground bash run disposes its kernel bridge exactly once", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-bridge-abort-"));
	const registered = Promise.withResolvers<void>();
	const register = shellBridge.registerKernelShellRun;
	let rawHandle: KernelShellBridgeHandle | undefined;
	let disposeCalls = 0;
	spyOn(shellBridge, "registerKernelShellRun").mockImplementation((session, onStatusEvent, completionContext) => {
		const handle = register(session, onStatusEvent, completionContext);
		rawHandle = handle;
		registered.resolve();
		return {
			...handle,
			dispose: () => {
				disposeCalls++;
				handle.dispose();
			},
		};
	});

	try {
		const controller = new AbortController();
		const execution = new BashTool(stubSession(dir)).execute(
			"abort-bridge",
			{ command: "sleep 30", timeout: 0 },
			controller.signal,
		);
		await registered.promise;
		controller.abort();
		await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
		expect(disposeCalls).toBe(1);
	} finally {
		rawHandle?.dispose();
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 10_000);
