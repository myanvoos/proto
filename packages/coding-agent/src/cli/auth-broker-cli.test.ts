import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { getAgentDbPath, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

test("migrate adds users sharing project/workspace ids without overwriting a broker account held under another identity key", async () => {
	using dir = TempDir.createSync("@proto-broker-migrate-");
	const local = await SqliteAuthCredentialStore.open(getAgentDbPath(dir.path()));
	const remote = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	const oauth = (email: string, refresh: string, identity: Partial<OAuthCredential>): OAuthCredential => ({
		type: "oauth",
		access: `access-${email}`,
		refresh,
		expires: Date.now() + 3_600_000,
		email,
		...identity,
	});
	const google = { projectId: "aicode-consumers" };
	const codex = { accountId: "workspace", orgId: "workspace" };
	await remote.set("google-antigravity", [
		oauth("carol@example.test", "carol-new", google),
		oauth("alice@example.test", "alice-new", google),
	]);
	await remote.set("openai-codex", oauth("carol@example.test", "codex-new", codex));
	local.replaceAuthCredentialsForProvider("google-antigravity", [
		oauth("bob@example.test", "bob-local", google),
		oauth("alice@example.test", "alice-stale", { ...google, accountId: "alice-id" }),
	]);
	local.replaceAuthCredentialsForProvider("openai-codex", [oauth("bob@example.test", "bob-codex-local", codex)]);
	local.close();
	const handle = startAuthBroker({
		storage: remote,
		bind: "127.0.0.1:0",
		bearerTokens: ["secret"],
		disableRefresher: true,
	});
	const cli = `import { runAuthBrokerCommand } from ${JSON.stringify(path.join(import.meta.dir, "auth-broker-cli.ts"))};
		await runAuthBrokerCommand({ action: "migrate", flags: { fromLocal: true, includeOauth: true, json: true } });`;
	const run = () =>
		$`${process.execPath} -e ${cli}`
			.env({
				...process.env,
				PI_CODING_AGENT_DIR: dir.path(),
				PROTO_AUTH_BROKER_URL: handle.url,
				PROTO_AUTH_BROKER_TOKEN: "secret",
			})
			.quiet()
			.nothrow();
	try {
		const first = await run();
		expect(first.exitCode).toBe(0);
		const plan = JSON.parse(first.text());
		expect(plan.plan).toHaveLength(2);
		expect(plan.skipped).toMatchObject([{ identity: "alice@example.test", reason: "already on broker" }]);
		expect(remote.listStoredCredentials("google-antigravity").map(row => row.credential)).toMatchObject([
			{ email: "carol@example.test", refresh: "carol-new" },
			{ email: "alice@example.test", refresh: "alice-new" },
			{ email: "bob@example.test", refresh: "bob-local" },
		]);
		expect(remote.listStoredCredentials("openai-codex").map(row => row.credential)).toMatchObject([
			{ email: "carol@example.test", refresh: "codex-new" },
			{ email: "bob@example.test", refresh: "bob-codex-local" },
		]);
		const rerun = await run();
		expect(rerun.exitCode).toBe(0);
		expect(JSON.parse(rerun.text()).plan).toEqual([]);
	} finally {
		await handle.close();
		remote.close();
	}
}, 15_000);
