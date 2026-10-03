/**
 * A failing advisor re-sends the identical "Session update" batch on every retry; the recorder must persist that batch
 * once (the transcript otherwise grows quadratically) while keeping every billed assistant turn and every genuinely new
 * delta, even one that renders like an earlier delta.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	AdvisorTranscriptRecorder,
	loadAdvisorTranscriptCosts,
} from "./transcript-recorder";

function userMessage(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(text: string, cost: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-advisor-model",
		usage: {
			input: 1,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4,
			cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

async function recordedRoles(run: (recorder: AdvisorTranscriptRecorder) => void): Promise<{
	roles: string[];
	cost: number | undefined;
}> {
	await using dir = await TempDir.create("@advisor-recorder-");
	const sessionFile = dir.join("sess.jsonl");
	const recorder = new AdvisorTranscriptRecorder(
		() => sessionFile,
		() => dir.path(),
	);
	run(recorder);
	await recorder.close();
	const text = await Bun.file(dir.join("sess", ADVISOR_TRANSCRIPT_FILENAME)).text();
	const roles: string[] = [];
	for (const line of text.trim().split("\n")) {
		const entry: { type?: string; message?: { role?: string } } = JSON.parse(line);
		if (entry.type === "message" && entry.message?.role) roles.push(entry.message.role);
	}
	return { roles, cost: (await loadAdvisorTranscriptCosts(sessionFile)).get("") };
}

describe("AdvisorTranscriptRecorder replay dedup", () => {
	it("persists a retried batch once but keeps every billed assistant turn", async () => {
		const { roles, cost } = await recordedRoles(recorder => {
			for (let attempt = 0; attempt < 5; attempt++) {
				recorder.beginTurn();
				recorder.record(userMessage("### Session update", attempt + 1));
				recorder.record(assistantMessage(`attempt ${attempt}`, 0.1));
			}
			recorder.commitTurn();
		});
		expect(roles.filter(role => role === "user")).toHaveLength(1);
		expect(roles.filter(role => role === "assistant")).toHaveLength(5);
		expect(cost).toBeCloseTo(0.5, 8);
	});

	it("keeps identical deltas from distinct committed turns", async () => {
		const { roles } = await recordedRoles(recorder => {
			for (let turn = 0; turn < 3; turn++) {
				recorder.beginTurn();
				recorder.record(userMessage("### Session update"));
				recorder.record(assistantMessage(`review ${turn}`, 0.1));
				recorder.commitTurn();
			}
		});
		expect(roles.filter(role => role === "user")).toHaveLength(3);
	});

	it("keeps identical deltas delivered within one turn", async () => {
		const { roles } = await recordedRoles(recorder => {
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.record(userMessage("### Session update"));
			recorder.commitTurn();
		});
		expect(roles).toEqual(["user", "user"]);
	});

	it("keeps a repeated delta after the prior batch was abandoned", async () => {
		const { roles } = await recordedRoles(recorder => {
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.abandonTurn();
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.commitTurn();
		});
		expect(roles).toEqual(["user", "user"]);
	});
});
