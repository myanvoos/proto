import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEffectiveSubagentPolicy } from "../task/structured-subagent";
import type { ToolSession } from "../tools";
import { resolveAgentSpawnModelSelection } from "./model-resolver";
import { Settings } from "./settings";

// Contract: a role model bank (`modelRoleBank.<role>`) is an allowlist for explicit `model=`
// spawn requests on that role; the role's primary model is always allowed, and a concrete
// request must not erase the spawn's role.
function bankSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		modelRoles: { worker: "prov/primary", smol: "prov/smol" },
		modelRoleBank: { worker: ["prov/alt-1", "prov/alt-2"] },
		...overrides,
	});
}

describe("resolveAgentSpawnModelSelection role bank", () => {
	test("accepts an in-bank model and keeps the spawn role", () => {
		const result = resolveAgentSpawnModelSelection({
			requestModel: "prov/alt-1",
			agentModel: "@worker",
			settings: bankSettings(),
		});
		expect(result.patterns).toEqual(["prov/alt-1"]);
		expect(result.role).toBe("worker");
		expect(result.requestError).toBeUndefined();
	});

	test("rejects an out-of-bank model, naming the role and its bank entries", () => {
		const result = resolveAgentSpawnModelSelection({
			requestModel: "prov/other",
			agentModel: "@worker",
			settings: bankSettings(),
		});
		expect(result.requestError).toContain("worker");
		expect(result.requestError).toContain("prov/alt-1, prov/alt-2");
	});

	test("accepts any model when the role has no bank", () => {
		const result = resolveAgentSpawnModelSelection({
			requestModel: "prov/whatever",
			agentModel: "@worker",
			settings: bankSettings({ modelRoleBank: {} }),
		});
		expect(result.patterns).toEqual(["prov/whatever"]);
		expect(result.requestError).toBeUndefined();
	});

	test("always allows the role alias even when the primary is not a bank entry", () => {
		const result = resolveAgentSpawnModelSelection({
			requestModel: "@worker",
			agentModel: "@worker",
			settings: bankSettings(),
		});
		expect(result.patterns).toEqual(["prov/primary"]);
		expect(result.requestError).toBeUndefined();
	});

	test("an explicit role alias in the request selects that role's bank", () => {
		const settings = bankSettings({
			modelRoleBank: { worker: ["prov/alt-1"], smol: ["prov/smol-alt"] },
		});
		const result = resolveAgentSpawnModelSelection({
			requestModel: "@smol",
			agentModel: "@worker",
			settings,
		});
		expect(result.role).toBe("smol");
		expect(result.requestError).toBeUndefined();
	});

	test("thinking suffixes do not affect bank membership", () => {
		const settings = bankSettings();
		const suffixed = resolveAgentSpawnModelSelection({
			requestModel: "prov/alt-1:high",
			agentModel: "@worker",
			settings,
		});
		expect(suffixed.requestError).toBeUndefined();
		const entrySuffixed = resolveAgentSpawnModelSelection({
			requestModel: "prov/alt-2",
			agentModel: "@worker",
			settings: bankSettings({ modelRoleBank: { worker: ["prov/alt-2:high"] } }),
		});
		expect(entrySuffixed.requestError).toBeUndefined();
		const stillRejected = resolveAgentSpawnModelSelection({
			requestModel: "prov/other:high",
			agentModel: "@worker",
			settings,
		});
		expect(stillRejected.requestError).toContain("prov/other");
	});

	test("unrestricted spawns without a request model never hit the bank", () => {
		const result = resolveAgentSpawnModelSelection({
			agentModel: "@worker",
			settings: bankSettings(),
		});
		expect(result.patterns).toEqual(["prov/primary"]);
		expect(result.requestError).toBeUndefined();
	});
});

describe("Settings.getModelRoleBank", () => {
	test("drops blank and non-string entries; undefined when nothing usable remains", () => {
		const settings = Settings.isolated({
			modelRoleBank: { worker: ["  ", "prov/a", "", 42 as unknown as string] },
		});
		expect(settings.getModelRoleBank("worker")).toEqual(["prov/a"]);
		expect(settings.getModelRoleBank("smol")).toBeUndefined();
	});
});

describe("resolveEffectiveSubagentPolicy role bank preflight", () => {
	test("a spawn request outside the role bank is rejected in preflight", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "role-bank-"));
		try {
			const session = {
				cwd,
				taskDepth: 0,
				settings: Settings.isolated({
					modelRoles: { worker: "prov/primary" },
					modelRoleBank: { worker: ["prov/alt-1", "prov/alt-2"] },
				}),
				getSessionSpawns: () => null,
				getActiveModelString: () => undefined,
				getModelString: () => undefined,
			} as unknown as ToolSession;

			const error = await resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "worker",
				assignment: "do the thing",
				model: "prov/other",
			}).catch(err => err);

			expect(error).toBeInstanceOf(Error);
			expect(error.kind).toBe("preflight");
			expect(error.message).toContain("worker");
			expect(error.message).toContain("prov/alt-1, prov/alt-2");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
