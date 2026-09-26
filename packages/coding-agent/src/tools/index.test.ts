import { describe, expect, test } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "../async/job-manager";
import { Settings } from "../config/settings";
import { BUILTIN_TOOLS, createTools, type ToolSession } from ".";

const EXPECTED_SCHEMA_HASHES = {
	kernel: "afd9139ccd0fa5d5d936902db028420a23d3fa41f67b06338deb0f5461a9000e",
	bash: "a090be2f47d17b7fd240e81a2f6b5f66407a382f10d2c3d0bbda1a373ddfe878",
	ask: "f6461da4127dda24ee2a896b5ef5fee810976e783139aa3de9ac8a681d2825bb",
	inspect_media: "c27e6e1252710dab5ffc41b493a847af4fe6e47d25168e664a9f3e3f6a1a9f49",
	browser: "fb75a57dba37513fcdc093e0516a7c889a0eae70ad233cb5fd4e2306719abd57",
	computer: "049c7a8684572e49ba0b5b95d584a2922539cb4085d17608d03694eb8eeacb2b",
	checkpoint: "fa3b87c3f132d2466eb9d1dd0ba9c31a8c9d2bdd2936a3821d1fd6e25b7f770d",
	rewind: "26d87b1241379ba274c056269d1a5630e56e3884848044d38b123521a45c0885",
	orchestrate_spawn: "a101f8601b7e4d45a21d56d0b3cc7eb1aed520d3e95dc5da24a9164724570c3f",
	orchestrate_send: "22710273b132b4ea5686ed9956c0d6ebc04491cf0898ec687c0a76e6e524e0f8",
	orchestrate_wait: "c5682266ac4050980f8b7c77167a427ab1a8befd0631c4641e3da289bf6a7f75",
	orchestrate_kill: "c914fe9935c807a74acc19f131e44336f40ed720377ca2260153fce00c7b2f85",
	orchestrate_list: "32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e",
	fleet: "b7c4559ec93bd342115e23ba09b4f3cc55f332c1eecb5107c8f3f26d022d8b31",
	monitor: "921b8ee2390a5842169740a45443c20c7cfeb3f813730bad08c5d15394a29ce5",
	checklist: "f1c164b6e734b737b003cd93a8e5ffb45a624486f5e0e8878032b94955892bff",
	web_search: "0d4dfea8a9d98cfe1831327673162cdd4e1e3cd366f5d440c47c482b2495b67f",
	manage_skill: "ba3244f6b123cda00f8f2eddad7b681a0f62ac7d3b25162169c21779502bc4c0",
} as const satisfies Record<keyof typeof BUILTIN_TOOLS, string>;

function schemaHash(schema: Record<string, unknown>): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(JSON.stringify(schema));
	return hasher.digest("hex");
}

function enabledToolSession(): ToolSession {
	const settings = Settings.isolated({
		"ask.enabled": true,
		"autolearn.enabled": true,
		"bash.enabled": true,
		"browser.enabled": true,
		"checkpoint.enabled": true,
		"computer.enabled": true,
		"goal.enabled": false,
		"inspect_media.mode": "on",
		"monitor.enabled": true,
		"checklist.enabled": true,
		"tools.xdev": false,
		"web_search.enabled": true,
	});
	return {
		cwd: import.meta.dir,
		hasUI: false,
		canPromptUser: true,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getGoalModeState: () => undefined,
		getActiveModel: () => undefined,
		taskDepth: 0,
		asyncJobManager: new AsyncJobManager({}),
	} as unknown as ToolSession;
}

describe("lazy builtin tool registry", () => {
	test("instantiates every builtin with its unchanged model-facing name and schema", async () => {
		const expectedNames = Object.keys(EXPECTED_SCHEMA_HASHES);
		expect(Object.keys(BUILTIN_TOOLS)).toEqual(expectedNames);

		const tools = await createTools(enabledToolSession(), expectedNames);
		const builtins = tools.filter(tool => Object.hasOwn(EXPECTED_SCHEMA_HASHES, tool.name));
		expect(builtins.map(tool => tool.name)).toEqual(expectedNames);

		for (const tool of builtins) {
			const expectedHash = EXPECTED_SCHEMA_HASHES[tool.name as keyof typeof EXPECTED_SCHEMA_HASHES];
			expect(schemaHash(toolWireSchema(tool)), tool.name).toBe(expectedHash);
		}
	});
});

test("monitor registration accepts subagents and requires the shared async manager", async () => {
	const session = enabledToolSession();
	session.taskDepth = 1;
	const enabled = await createTools(session, ["monitor"]);
	expect(enabled.map(tool => tool.name)).toContain("monitor");
	session.asyncJobManager = undefined;
	const disabled = await createTools(session, ["monitor"]);
	expect(disabled.map(tool => tool.name)).not.toContain("monitor");
});

test("monitor refuses a start without an owner session", async () => {
	const session = enabledToolSession();
	const tool = await BUILTIN_TOOLS.monitor(session);
	const result = await tool!.execute("unowned", { op: "start", command: "printf READY" });
	expect(result.isError).toBe(true);
	expect(session.asyncJobManager!.getRunningJobs()).toEqual([]);
});

test("monitor and fleet expose the migrated job schema", async () => {
	const session = enabledToolSession();
	for (const name of ["monitor", "fleet"] as const) {
		const tool = await BUILTIN_TOOLS[name](session);
		expect(schemaHash(toolWireSchema(tool!))).toBe(EXPECTED_SCHEMA_HASHES[name]);
	}
});
