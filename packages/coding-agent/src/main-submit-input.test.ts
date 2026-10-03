import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "./extensibility/skills";
import { submitInteractiveInput } from "./main";
import type { SubmittedUserInput } from "./modes/types";
import { SKILL_PROMPT_MESSAGE_TYPE } from "./session/messages";

const cleanupDirs: string[] = [];

afterEach(async () => {
	for (const dir of cleanupDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function createMode(skillCommands: Map<string, Skill>) {
	return {
		markPendingSubmissionStarted: vi.fn(() => true),
		finishPendingSubmission: vi.fn(),
		showError: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		skillCommands,
	};
}

function createSession() {
	return {
		prompt: vi.fn(async () => true),
		promptCustomMessage: vi.fn(async () => {}),
		isStreaming: false,
	};
}

function createInput(text: string): SubmittedUserInput {
	return { text, cancelled: false, started: true };
}

describe("submitInteractiveInput", () => {
	it("expands a submitted /skill: invocation instead of sending the literal text", async () => {
		const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-skill-submit-"));
		cleanupDirs.push(skillDir);
		const skillPath = path.join(skillDir, "recap.md");
		await fs.writeFile(skillPath, "---\nname: recap\n---\nSummarize recent changes.\n");
		const skill: Skill = { name: "recap", description: "", filePath: skillPath, baseDir: skillDir, source: "test" };
		const mode = createMode(new Map([["skill:recap", skill]]));
		const session = createSession();

		await submitInteractiveInput(mode, session, createInput("/skill:recap what changed"));

		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.promptCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				attribution: "user",
				display: true,
				details: expect.objectContaining({ name: "recap", args: "what changed" }),
			}),
			expect.objectContaining({ streamingBehavior: "followUp" }),
		);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("sends unknown /skill: text to the model as a plain prompt", async () => {
		const mode = createMode(new Map());
		const session = createSession();

		await submitInteractiveInput(mode, session, createInput("/skill:missing go"));

		expect(session.promptCustomMessage).not.toHaveBeenCalled();
		expect(session.prompt).toHaveBeenCalledWith("/skill:missing go", {
			images: undefined,
			streamingBehavior: "followUp",
		});
	});
});
