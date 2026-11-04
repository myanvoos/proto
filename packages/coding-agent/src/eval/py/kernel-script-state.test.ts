import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import { SessionManager } from "../../session/session-manager";
import {
	activateSessionStateRestore,
	captureSessionState,
	prepareSessionStateRestore,
} from "../../session/state-manifest";
import type { Tool, ToolSession } from "../../tools";
import { BashTool } from "../../tools/bash";
import { disposeKernelSessionsByOwner } from "./executor";
import { dispatchPythonHarnessRequest } from "./harness-dispatch";
import type { PythonHarnessContext } from "./harness-types";

test("a named script can fork its closures and aliases without retaining an internal file handle", async () => {
	using directory = TempDir.createSync("@python-script-state-");
	const source = `script:${crypto.randomUUID()}`;
	const destination = `script:${crypto.randomUUID()}`;
	const manager = SessionManager.create(directory.path(), directory.join("sessions"));
	const settings = await Settings.loadReadOnly({ cwd: directory.path(), agentDir: directory.path(), inMemory: true });
	const context = (owner: string): PythonHarnessContext => {
		const session: ToolSession = {
			cwd: directory.path(),
			hasUI: false,
			settings,
			getSessionFile: () => manager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
			getSessionId: () => owner,
			getEvalSessionId: () => owner,
			getEvalKernelOwnerId: () => owner,
		};
		const bash: Tool = new BashTool(session);
		session.getToolForEvalBridge = name => (name === "bash" ? bash : undefined);
		session.getEvalBridgeToolNames = () => ["bash"];
		return {
			session,
			runId: crypto.randomUUID(),
			lane: "main",
			cwd: directory.path(),
			signal: new AbortController().signal,
			toolCallId: crypto.randomUUID(),
		};
	};
	try {
		await Bun.write(directory.join("analysis.py"), "values = [41]\nalias = values\nanswer = lambda: values[0] + 1\n");
		expect(
			await dispatchPythonHarnessRequest(context(source), "kernel.exec", { name: "script", file: "analysis.py" }),
		).toMatchObject({ exitCode: 0 });
		const boundary = manager.appendMessage({ role: "user", content: "script boundary", timestamp: 0 });
		await captureSessionState(manager, source);
		const prepared = await prepareSessionStateRestore(manager, source, boundary);
		activateSessionStateRestore(prepared, destination, destination);
		expect(
			await dispatchPythonHarnessRequest(context(destination), "kernel.run", {
				name: "script",
				code: "assert alias is values\nvalues[0] = 51\nprint(answer())",
			}),
		).toMatchObject({ exitCode: 0, output: expect.stringContaining("52") });
		expect(
			await dispatchPythonHarnessRequest(context(source), "kernel.run", {
				name: "script",
				code: "assert alias is values\nprint(answer())",
			}),
		).toMatchObject({ exitCode: 0, output: expect.stringContaining("42") });
	} finally {
		await Promise.all([disposeKernelSessionsByOwner(source), disposeKernelSessionsByOwner(destination)]);
		await manager.close();
	}
}, 30_000);
