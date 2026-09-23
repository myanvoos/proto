import { getProviderRegistry } from "@oh-my-pi/pi-ai";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { tokenHelp as commandHelp } from "../cli/command-help";
import { isAuthenticated, ModelRegistry } from "../config/model-registry";
import { discoverAuthStorage } from "../sdk";
import { getAvailableAuthMethods } from "../web/search/providers/perplexity-auth";

export default class Token extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;

	static flags = commandHelp.flags;

	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Token);
		const providerName = args.provider ?? "";
		const provider = providerName.toLowerCase();

		const authStorage = await discoverAuthStorage();
		try {
			if (flags.list || flags.account !== undefined) {
				const accounts = authStorage.listOAuthAccounts(provider);
				if (accounts.length === 0) {
					process.stderr.write(`${chalk.red(`No OAuth accounts found for provider "${providerName}".`)}\n`);
					process.stderr.write("--account/--list select among OAuth accounts; this provider has none stored.\n");
					process.exitCode = 1;
					return;
				}
				if (flags.list) {
					for (const acct of accounts) {
						const base =
							acct.email ??
							acct.accountId ??
							acct.projectId ??
							acct.enterpriseUrl ??
							`credential #${acct.credentialId}`;
						const org = acct.orgName ?? acct.orgId;
						const label = org && org !== base ? `${base} (${org})` : base;
						process.stdout.write(`${acct.position + 1}. ${label}\n`);
					}
					return;
				}
				const n = flags.account;
				if (n === undefined || n < 1 || n > accounts.length) {
					process.stderr.write(
						`${chalk.red(`Invalid --account ${n ?? "(missing)"}.`)} Provider "${providerName}" has ${accounts.length} OAuth account(s) (1-${accounts.length}).\n`,
					);
					process.exitCode = 1;
					return;
				}
				const resolution = await authStorage.getOAuthAccessAt(provider, n - 1, {
					forceRefresh: flags["force-refresh"],
				});
				if (!resolution?.ok) {
					const reason = resolution && !resolution.ok ? resolution.error : "no OAuth credential available";
					process.stderr.write(
						`${chalk.red(`Could not get token for account ${n} of "${providerName}": ${reason}`)}\n`,
					);
					process.exitCode = 1;
					return;
				}
				process.stdout.write(`${resolution.accessToken}\n`);
				return;
			}

			const modelRegistry = new ModelRegistry(authStorage);

			let apiKey: string | undefined;

			if (provider === "perplexity") {
				const methods = await getAvailableAuthMethods(authStorage, undefined, {
					forceRefresh: flags["force-refresh"],
				});
				const printable = methods.find(m => m.type === "oauth" || m.type === "api_key");
				if (printable) {
					apiKey = printable.type === "oauth" ? printable.access.accessToken : printable.apiKey;
				}
			}

			if (!apiKey) {
				apiKey = await modelRegistry.getApiKeyForProvider(provider, undefined, {
					forceRefresh: flags["force-refresh"],
				});
			}

			if (!isAuthenticated(apiKey)) {
				const activeProviders = new Set<string>();
				for (const p of getProviderRegistry()) {
					if (authStorage.hasAuth(p.id)) {
						activeProviders.add(p.id);
					}
				}
				const all = authStorage.getAll();
				for (const p in all) {
					if (authStorage.hasAuth(p)) {
						activeProviders.add(p);
					}
				}

				const msg = `No active credential found for provider "${providerName}".`;
				process.stderr.write(`${chalk.red(msg)}\n`);
				if (activeProviders.size > 0) {
					process.stderr.write(`Configured providers: ${Array.from(activeProviders).sort().join(", ")}\n`);
				}
				process.exitCode = 1;
				return;
			}

			if (!flags.raw) {
				try {
					const parsed = JSON.parse(apiKey);
					if (parsed && typeof parsed === "object" && typeof parsed.token === "string") {
						process.stdout.write(`${parsed.token}\n`);
						return;
					}
				} catch {}
			}

			process.stdout.write(`${apiKey}\n`);
		} finally {
			authStorage.close();
		}
	}
}
