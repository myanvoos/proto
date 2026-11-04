import { expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { executeInVmContext } from "../eval/js/context-manager";
import { createAgentSession } from "../sdk";
import type { ToolSession } from "../tools";
import type { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";
import { captureSessionState } from "./state-manifest";

async function javascript(session: AgentSession, code: string): Promise<string> {
	const cwd = session.sessionManager.getCwd();
	const tools: ToolSession = {
		cwd,
		hasUI: false,
		settings: session.settings,
		getSessionFile: () => session.sessionFile ?? null,
		getSessionSpawns: () => null,
	};
	const id = `bun:${session.getEvalSessionId()}`;
	let output = "";
	await executeInVmContext({
		runtime: "bun",
		sessionKey: id,
		sessionId: id,
		ownerId: session.getEvalKernelOwnerId(),
		cwd,
		session: tools,
		code,
		filename: "temporal-state.js",
		runState: {
			onText: text => {
				output += text;
			},
			onDisplay: () => {},
		},
	});
	return output;
}

test("SDK temporal navigation, independent fork and restart use the exact declared Python and JavaScript boundary", async () => {
	using directory = TempDir.createSync("@sdk-state-continuity-");
	const auth = await AuthStorage.create(":memory:");
	const model = createMockModel({ responses: [{ content: ["Ready"] }] });
	auth.setRuntimeApiKey(model.provider, "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"checklist.enabled": false,
	});
	const open = async (manager: SessionManager) =>
		(
			await createAgentSession({
				cwd: directory.path(),
				agentDir: directory.join("agent"),
				authStorage: auth,
				sessionManager: manager,
				model,
				settings,
				streamFn: model.stream,
				disableExtensionDiscovery: true,
				enableMCP: false,
				toolNames: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				extensions: [],
			})
		).session;
	const session = await open(SessionManager.create(directory.path(), directory.join("sessions")));
	let fork: AgentSession | undefined;
	let resumed: AgentSession | undefined;
	try {
		await session.prompt("Prepare computation");
		expect((await session.executePython('value = 41\ndeclare_state(["value"])')).exitCode).toBe(0);
		await javascript(session, 'var value = 41; declareState(["value"]);');
		session.sessionManager.appendCustomEntry("state-test-boundary", { turn: 1 });
		await captureSessionState(session.sessionManager, session.getEvalKernelOwnerId());
		const early = session.sessionManager.getLeafId()!;
		expect((await session.executePython("value = 73")).exitCode).toBe(0);
		await javascript(session, "value = 73;");
		session.sessionManager.appendCustomEntry("state-test-boundary", { turn: 2 });
		await captureSessionState(session.sessionManager, session.getEvalKernelOwnerId());
		const sourceFile = session.sessionFile!;
		const sourceHead = session.sessionManager.getLeafId();
		const sourceBytes = await Bun.file(sourceFile).text();
		fork = (await session.fork()) ?? undefined;
		if (!fork) throw new Error("Fork was cancelled");
		expect(fork.getEvalKernelOwnerId()).not.toBe(session.getEvalKernelOwnerId());
		expect((await fork.executePython("print(value)")).output).toContain("73");
		expect(await javascript(fork, "console.log(value);")).toContain("73");
		expect(session.sessionManager.getLeafId()).toBe(sourceHead);
		expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
		const navigated = await session.navigateTree(early, { summarize: false, requireIdle: true });
		expect(navigated.cancelled).toBe(false);
		expect((await session.executePython("print(value)")).output).toContain("41");
		expect(await javascript(session, "console.log(value);")).toContain("41");
		expect((await fork.executePython("print(value)")).output).toContain("73");
		const oldOwner = session.getEvalKernelOwnerId();
		await session.dispose();
		const reopened = await SessionManager.open(sourceFile);
		expect(reopened.getCustomEntries("session_exit").length).toBeGreaterThan(0);
		resumed = await open(reopened);
		expect(resumed.getEvalKernelOwnerId()).not.toBe(oldOwner);
		expect((await resumed.executePython("print(value)")).output).toContain("41");
		expect(await javascript(resumed, "console.log(value);")).toContain("41");
		await resumed.executePython('first = []\nsecond = []\ndeclare_state(["first", "second"])');
		await expect(resumed.executePython("second = first")).rejects.toThrow("aliases");
		await expect(resumed.dispose()).rejects.toThrow("aliases");
		expect((await resumed.executePython("print(first is second)\nsecond = []")).output).toContain("True");
	} finally {
		await resumed?.dispose();
		await fork?.dispose();
		await session.dispose();
		auth.close();
	}
}, 60_000);
