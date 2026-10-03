import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type UsageReport } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import * as sdkModule from "../sdk";
import { runUsageCommand } from "./usage-cli";

const EXTENSION_SOURCE = `export default function (pi) {
	pi.registerProvider("ext-usage", {
		usage: {
			id: "ext-usage",
			async fetchUsage() {
				return {
					provider: "ext-usage",
					fetchedAt: Date.now(),
					limits: [{
						id: "credits",
						label: "Credits",
						scope: { provider: "ext-usage" },
						amount: { used: 6, limit: 10, unit: "usd", usedFraction: 0.6 },
					}],
				};
			},
		},
	});
}
`;

class BrokerUsageStore extends SqliteAuthCredentialStore {
	async fetchUsageReports(): Promise<UsageReport[]> {
		return [{ provider: "anthropic", fetchedAt: Date.now(), limits: [] }];
	}
}

let tmp: TempDir;
let extPath: string;
let authStorage: AuthStorage;

async function useAuthStorage(store: SqliteAuthCredentialStore): Promise<void> {
	authStorage = new AuthStorage(store);
	await authStorage.reload();
	await authStorage.set("ext-usage", { type: "api_key", key: "sk-test" });
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
}

beforeEach(async () => {
	tmp = await TempDir.create("@proto-usage-extension-");
	extPath = tmp.join("ext.ts");
	await Bun.write(extPath, EXTENSION_SOURCE);
	vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated());
});

afterEach(async () => {
	vi.restoreAllMocks();
	await tmp.remove();
});

async function usageJson(provider?: string): Promise<{
	reports: Array<{ provider: string; limits: Array<{ id: string }> }>;
	accountsWithoutUsage: Array<{ provider: string }>;
}> {
	const chunks: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		chunks.push(String(chunk));
		return true;
	});
	await runUsageCommand({ json: true, provider, extensions: [extPath], noExtensions: true });
	return JSON.parse(chunks.join(""));
}

test("proto usage reports accounts through an extension-registered usage provider", async () => {
	await useAuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));

	const output = await usageJson("ext-usage");

	expect(output.reports.map(report => [report.provider, report.limits.map(limit => limit.id)])).toEqual([
		["ext-usage", ["credits"]],
	]);
	expect(output.accountsWithoutUsage).toEqual([]);
});

test("proto usage combines broker reports with locally registered extension usage", async () => {
	await useAuthStorage(new BrokerUsageStore(new Database(":memory:")));

	const output = await usageJson();

	expect(output.reports.map(report => [report.provider, report.limits.map(limit => limit.id)])).toEqual([
		["anthropic", []],
		["ext-usage", ["credits"]],
	]);
});
