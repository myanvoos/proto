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

async function python(session: AgentSession, code: string) {
	const result = await session.executePython(
		[
			"import proto_harness as harness",
			`result = harness.kernel("temporal").run(${JSON.stringify(code)})`,
			'print(result["output"], end="")',
			'assert result["exitCode"] == 0, result["output"]',
		].join("\n"),
	);
	expect(result.exitCode, result.output).toBe(0);
	return result;
}

const observePython = [
	"import proto_harness as harness",
	'print("WARM", value, counter.value, closure(), first is second, cycle[0] is cycle)',
	'graph = harness.store["graph"]',
	'print("STORE", graph["counter"].value, graph["closure"](), graph["first"] is graph["second"], graph["cycle"][0] is graph["cycle"])',
].join("\n");

test("SDK temporal navigation, independent fork and restart restore exact rich Python and declared JavaScript boundaries", async () => {
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
				toolNames: ["bash", "read"],
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
		expect(
			(
				await python(
					session,
					[
						"import proto_harness as harness",
						"class Counter:",
						"    def __init__(self, value): self.value = value",
						"def capture(items):",
						"    return lambda: items[0]",
						"value = 41",
						"counter = Counter(value)",
						"first = [value]",
						"second = first",
						"cycle = []",
						"cycle.append(cycle)",
						"closure = capture(first)",
						'harness.store["graph"] = {"counter": counter, "closure": closure, "first": first, "second": second, "cycle": cycle}',
					].join("\n"),
				)
			).exitCode,
		).toBe(0);
		expect((await session.executePython("print(value)")).exitCode).not.toBe(0);
		await javascript(session, 'var value = 41; declareState(["value"]);');
		session.sessionManager.appendCustomEntry("state-test-boundary", { turn: 1 });
		await captureSessionState(session.sessionManager, session.getEvalKernelOwnerId());
		const early = session.sessionManager.getLeafId()!;
		expect(
			(
				await python(
					session,
					[
						"value = 73",
						"counter.value = value",
						"first[0] = value",
						'graph = harness.store["graph"]',
						'graph["counter"].value = value',
						'graph["first"][0] = value',
						"harness.store.commit()",
					].join("\n"),
				)
			).exitCode,
		).toBe(0);
		await javascript(session, "value = 73;");
		session.sessionManager.appendCustomEntry("state-test-boundary", { turn: 2 });
		await captureSessionState(session.sessionManager, session.getEvalKernelOwnerId());
		const sourceFile = session.sessionFile!;
		const sourceHead = session.sessionManager.getLeafId();
		const sourceBytes = await Bun.file(sourceFile).text();
		fork = (await session.fork()) ?? undefined;
		if (!fork) throw new Error("Fork was cancelled");
		expect(fork.getEvalKernelOwnerId()).not.toBe(session.getEvalKernelOwnerId());
		expect((await python(fork, observePython)).output).toContain("WARM 73 73 73 True True\nSTORE 73 73 True True");
		expect(await javascript(fork, "console.log(value);")).toContain("73");
		expect(session.sessionManager.getLeafId()).toBe(sourceHead);
		expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
		const navigated = await session.navigateTree(early, { summarize: false, requireIdle: true });
		expect(navigated.cancelled).toBe(false);
		expect((await python(session, observePython)).output).toContain("WARM 41 41 41 True True\nSTORE 41 41 True True");
		expect(await javascript(session, "console.log(value);")).toContain("41");
		expect((await python(fork, observePython)).output).toContain("WARM 73 73 73 True True\nSTORE 73 73 True True");
		const oldOwner = session.getEvalKernelOwnerId();
		await session.dispose();
		const reopened = await SessionManager.open(sourceFile);
		expect(reopened.getCustomEntries("session_exit").length).toBeGreaterThan(0);
		resumed = await open(reopened);
		expect(resumed.getEvalKernelOwnerId()).not.toBe(oldOwner);
		expect((await python(resumed, observePython)).output).toContain("WARM 41 41 41 True True\nSTORE 41 41 True True");
		expect(await javascript(resumed, "console.log(value);")).toContain("41");
		expect((await resumed.executePython("print(value)")).exitCode).not.toBe(0);
		expect((await python(resumed, "first[0] = 99; print(closure(), second[0])")).output).toContain("99 99");
		expect((await python(fork, observePython)).output).toContain("WARM 73 73 73 True True\nSTORE 73 73 True True");
	} finally {
		await resumed?.dispose();
		await fork?.dispose();
		await session.dispose();
		auth.close();
	}
}, 60_000);
