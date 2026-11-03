import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadAuthBrokerAccountPool } from "./discover";

const POOL_ENV = "PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE";
let savedPoolFile: string | undefined;
beforeEach(() => {
	savedPoolFile = process.env[POOL_ENV];
});

afterEach(() => {
	if (savedPoolFile === undefined) delete process.env[POOL_ENV];
	else process.env[POOL_ENV] = savedPoolFile;
});

describe("loadAuthBrokerAccountPool", () => {
	it("parses provider and API-key allowlists without granting unlisted providers access", async () => {
		using dir = TempDir.createSync("@proto-account-pool-");
		const file = path.join(dir.path(), "pool.json");
		await Bun.write(
			file,
			JSON.stringify({
				"*": false,
				cursor: { accounts: ["account-1"], apiKeys: false },
				zai: true,
				legacy: ["legacy-account"],
			}),
		);
		process.env[POOL_ENV] = file;
		const pool = await loadAuthBrokerAccountPool();
		expect(pool?.get("*")).toEqual({ accounts: new Set(), apiKeys: false });
		expect(pool?.get("cursor")).toEqual({ accounts: new Set(["account-1"]), apiKeys: false });
		expect(pool?.get("zai")).toEqual({});
		expect(pool?.get("legacy")).toEqual(new Set(["legacy-account"]));
	});

	it("rejects malformed visibility rules instead of silently widening account access", async () => {
		using dir = TempDir.createSync("@proto-account-pool-");
		const file = path.join(dir.path(), "pool.json");
		process.env[POOL_ENV] = file;
		for (const rule of [
			{ unknown: true },
			{ accounts: "account-1" },
			{ apiKeys: "false" },
			{ accounts: [" account-1"] },
			null,
		]) {
			await Bun.write(file, JSON.stringify({ cursor: rule }));
			await expect(loadAuthBrokerAccountPool()).rejects.toThrow("PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE");
		}
	});

	it("parses an account-pool file saved with a UTF-8 BOM", async () => {
		using dir = TempDir.createSync("@proto-account-pool-");
		const file = path.join(dir.path(), "pool.json");
		await Bun.write(file, `\uFEFF${JSON.stringify({ anthropic: ["acct-a", "acct-b"] })}`);
		process.env[POOL_ENV] = file;

		const pool = await loadAuthBrokerAccountPool();

		expect(pool?.get("anthropic")).toEqual(new Set(["acct-a", "acct-b"]));
	});
});
