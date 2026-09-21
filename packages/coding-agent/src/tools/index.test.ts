import { describe, expect, test } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "../config/settings";
import { BUILTIN_TOOLS, createTools, type ToolSession } from ".";

const EXPECTED_SCHEMA_HASHES = {
	bash: "8b0063176e37e24d72d0bd05afb0b3824fcac83eb0fd3d39c7335fe0063e6ffe",
	ask: "f6461da4127dda24ee2a896b5ef5fee810976e783139aa3de9ac8a681d2825bb",
	inspect_media: "c27e6e1252710dab5ffc41b493a847af4fe6e47d25168e664a9f3e3f6a1a9f49",
	browser: "fb75a57dba37513fcdc093e0516a7c889a0eae70ad233cb5fd4e2306719abd57",
	computer: "049c7a8684572e49ba0b5b95d584a2922539cb4085d17608d03694eb8eeacb2b",
	checkpoint: "fa3b87c3f132d2466eb9d1dd0ba9c31a8c9d2bdd2936a3821d1fd6e25b7f770d",
	rewind: "26d87b1241379ba274c056269d1a5630e56e3884848044d38b123521a45c0885",
	orchestrate_spawn: "a101f8601b7e4d45a21d56d0b3cc7eb1aed520d3e95dc5da24a9164724570c3f",
	orchestrate_send: "1e22ebf89646f02d1901a7c296f64f33b5482e7cf24b93f32bb8ec712bedb9a7",
	orchestrate_wait: "c5682266ac4050980f8b7c77167a427ab1a8befd0631c4641e3da289bf6a7f75",
	orchestrate_kill: "c914fe9935c807a74acc19f131e44336f40ed720377ca2260153fce00c7b2f85",
	orchestrate_list: "32062bdb9024160d3b9816f12ba2f337808ee107449f8bf08d55b0026944f51e",
	fleet: "305745a52cc3bc9a15d6cc362657dd7bfab856697fc4b8b399bdfe1ee9a38324",
	monitor: "90846dcddd901e0af27df42aba20c3de3351b0b7cedd8d0284141fa1cf7907f0",
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
