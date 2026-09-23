import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadAuthBrokerAccountPool } from "./discover";

const POOL_ENV = "PROTO_AUTH_BROKER_ACCOUNT_POOL_FILE";
const savedPoolFile = process.env[POOL_ENV];

afterEach(() => {
	if (savedPoolFile === undefined) delete process.env[POOL_ENV];
	else process.env[POOL_ENV] = savedPoolFile;
});

describe("loadAuthBrokerAccountPool", () => {
	it("parses an account-pool file saved with a UTF-8 BOM", async () => {
		using dir = TempDir.createSync("@proto-account-pool-");
		const file = path.join(dir.path(), "pool.json");
		await Bun.write(file, `\uFEFF${JSON.stringify({ anthropic: ["acct-a", "acct-b"] })}`);
		process.env[POOL_ENV] = file;

		const pool = await loadAuthBrokerAccountPool();

		expect(pool?.get("anthropic")).toEqual(new Set(["acct-a", "acct-b"]));
	});
});
