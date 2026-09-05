import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { DeveloperMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const TEST_TIMESTAMP = 1_700_000_000_000;

type Harness = {
	session: AgentSession;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
	agentDir: string;
};

function userMessage(content: string, timestamp = TEST_TIMESTAMP): UserMessage {
	return { role: "user", content, timestamp };
}

function branchMessages(sessionManager: SessionManager): UserMessage[] {
	return sessionManager
		.getBranch()
		.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
}

async function createHarness(): Promise<Harness> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-persistence-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const sessionManager = SessionManager.inMemory(process.cwd());
	try {
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			agentDir,
			authStorage,
			sessionManager,
			disableExtensionDiscovery: true,
			enableMCP: false,
			skipPythonPreflight: true,
			workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		return { session, sessionManager, authStorage, agentDir };
	} catch (error) {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
		throw error;
	}
}

async function closeHarness(harness: Harness): Promise<void> {
	await harness.session.dispose();
	harness.authStorage.close();
	await fs.rm(harness.agentDir, { recursive: true, force: true });
}

let persistenceBarrierIndex = 0;

async function emitMessage(harness: Harness, message: AgentMessage): Promise<void> {
	const { session, sessionManager } = harness;
	const barrier: DeveloperMessage = {
		role: "developer",
		content: `persistence barrier ${persistenceBarrierIndex}`,
		timestamp: TEST_TIMESTAMP + 1_000 + persistenceBarrierIndex++,
	};
	const barrierSettled = Promise.withResolvers<void>();
	const previousOnEntryAppended = sessionManager.onEntryAppended;
	sessionManager.onEntryAppended = entry => {
		previousOnEntryAppended?.(entry);
		if (entry.type === "message" && entry.message === barrier) barrierSettled.resolve();
	};

	try {
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "message_end", message: barrier });
		await barrierSettled.promise;
	} finally {
		sessionManager.onEntryAppended = previousOnEntryAppended;
	}
}

test("does not duplicate an identical persisted message", async () => {
	const harness = await createHarness();
	try {
		const persisted = userMessage("same");
		harness.sessionManager.appendMessage(persisted);

		await emitMessage(harness, userMessage("same"));

		expect(branchMessages(harness.sessionManager)).toHaveLength(1);
		expect(branchMessages(harness.sessionManager)[0]).toEqual(persisted);
	} finally {
		await closeHarness(harness);
	}
});

test("retains same-key messages with different content", async () => {
	const harness = await createHarness();
	try {
		harness.sessionManager.appendMessage(userMessage("first"));
		await emitMessage(harness, userMessage("second"));

		expect(branchMessages(harness.sessionManager).map(message => message.content)).toEqual(["first", "second"]);
	} finally {
		await closeHarness(harness);
	}
});

test("invalidates persisted candidates after branch and session switches", async () => {
	const harness = await createHarness();
	try {
		const persisted = userMessage("before switch");
		harness.sessionManager.appendMessage(persisted);
		await emitMessage(harness, userMessage("before switch"));

		harness.sessionManager.resetLeaf();
		await emitMessage(harness, userMessage("before switch"));
		expect(branchMessages(harness.sessionManager).map(message => message.content)).toEqual(["before switch"]);

		await harness.sessionManager.newSession();
		await emitMessage(harness, userMessage("before switch"));
		expect(branchMessages(harness.sessionManager).map(message => message.content)).toEqual(["before switch"]);
	} finally {
		await closeHarness(harness);
	}
});

test("updates the candidate index incrementally after appends", async () => {
	const harness = await createHarness();
	const getBranchSpy = spyOn(harness.sessionManager, "getBranch");
	try {
		harness.sessionManager.appendMessage(userMessage("first", TEST_TIMESTAMP));
		await emitMessage(harness, userMessage("first", TEST_TIMESTAMP));
		expect(getBranchSpy).toHaveBeenCalledTimes(1);

		await emitMessage(harness, userMessage("second", TEST_TIMESTAMP + 1));
		await emitMessage(harness, userMessage("second", TEST_TIMESTAMP + 1));
		expect(getBranchSpy).toHaveBeenCalledTimes(1);
		expect(
			harness.sessionManager
				.getEntries()
				.flatMap(entry =>
					entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
				),
		).toEqual(["first", "second"]);
	} finally {
		getBranchSpy.mockRestore();
		await closeHarness(harness);
	}
});
