import { expect, spyOn, test } from "bun:test";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../config/settings";
import * as bashExecutor from "../exec/bash-executor";
import { BashRunner, type BashRunnerHost } from "./bash-runner";
import { SessionManager } from "./session-manager";

test("idle BashRunner disposal does not close shell sessions", async () => {
	const sessionManager = SessionManager.inMemory();
	const host: BashRunnerHost = {
		agent: {} as Agent,
		sessionManager,
		settings: Settings.isolated({}),
		extensionRunner: () => undefined,
		isStreaming: () => false,
	};
	const runner = new BashRunner(host);
	const disposeSpy = spyOn(bashExecutor, "disposeBashSessions");
	try {
		await runner.dispose();
		expect(disposeSpy).not.toHaveBeenCalled();
	} finally {
		disposeSpy.mockRestore();
		await sessionManager.close();
	}
});
