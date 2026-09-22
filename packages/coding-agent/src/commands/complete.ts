import { Database } from "bun:sqlite";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { completeHelp as commandHelp } from "../cli/command-help";
import { ModelRegistry } from "../config/model-registry";
import { AuthStorage, SqliteAuthCredentialStore } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";

export default class Complete extends Command {
	static hidden = commandHelp.hidden;
	static strict = false;

	async run(): Promise<void> {
		const argv = this.argv.filter(token => token !== "--");
		const kind = argv[0];
		const prefix = argv.length > 1 ? argv[argv.length - 1] : "";
		if (kind === "models") {
			completeModels(prefix);
		} else if (kind === "sessions") {
			await completeSessions(prefix);
		}
	}
}

function clean(text: string): string {
	return text.replace(/[\t\r\n]+/g, " ").trim();
}

/**
 * Models the user configured in `models.yml` (or discovered from a local provider) are as
 * completable as the bundled catalog, so completion reads the registry. Auth is irrelevant here —
 * an in-memory store keeps this off the credential broker and the network.
 */
function knownModels(): Array<{ provider: string; id: string }> {
	try {
		const registry = new ModelRegistry(new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:"))));
		const models = registry.getAll();
		if (models.length > 0) return models;
	} catch {
		// Unreadable model config must not break shell completion; fall back to the bundled catalog.
	}
	const bundled: Array<{ provider: string; id: string }> = [];
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as GeneratedProvider)) {
			bundled.push({ provider: model.provider, id: model.id });
		}
	}
	return bundled;
}

function completeModels(prefix: string): void {
	const needle = prefix.toLowerCase();
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const model of knownModels()) {
		const candidates = [`${model.provider}/${model.id}`, model.id];
		for (const candidate of candidates) {
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			if (needle && !candidate.toLowerCase().includes(needle)) continue;
			lines.push(`${candidate}\t${model.provider}`);
		}
	}
	lines.sort();
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

async function completeSessions(prefix: string): Promise<void> {
	const sessions = await SessionManager.list(process.cwd());
	const lines: string[] = [];
	for (const session of sessions) {
		if (prefix && !session.id.startsWith(prefix)) continue;
		const label = clean(session.title ?? session.firstMessage ?? "").slice(0, 72);
		lines.push(`${session.id}\t${label}`);
	}
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}
