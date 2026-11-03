import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../config/settings";
import { SessionMaintenance, type SessionMaintenanceHost } from "./session-maintenance";
import { SessionManager } from "./session-manager";

test("automatic compaction blocks without a model call when fixed context alone exceeds the recovery band", async () => {
	const bundled = getBundledModel("openai", "gpt-5");
	if (!bundled) throw new Error("Expected bundled openai/gpt-5");
	const model = { ...bundled, contextWindow: 100_000 };
	const agent = new Agent({ initialState: { model } });
	const notices: string[] = [];
	const host: Partial<SessionMaintenanceHost> = {
		agent,
		sessionManager: SessionManager.inMemory(),
		model: () => model,
		settings: Settings.isolated({ "compaction.enabled": true, "compaction.thresholdPercent": 50 }),
		nonMessageTokenSource: () => ({ systemPrompt: ["fixed context ".repeat(100_000)] }),
		emitNotice: (_level, message) => {
			notices.push(message);
		},
	};
	const maintenance = new SessionMaintenance(host as SessionMaintenanceHost);
	for (let attempt = 0; attempt < 2; attempt++) {
		expect(await maintenance.runAutoCompaction("threshold", false)).toEqual({
			continuationScheduled: false,
			automaticContinuationBlocked: true,
		});
	}
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("system prompt and always-sent tool schemas");
});
