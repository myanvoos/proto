import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { completeHelp as commandHelp } from "../cli/command-help";
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

function completeModels(prefix: string): void {
	const needle = prefix.toLowerCase();
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as GeneratedProvider)) {
			const candidates = [`${model.provider}/${model.id}`, model.id];
			for (const candidate of candidates) {
				if (seen.has(candidate)) continue;
				seen.add(candidate);
				if (needle && !candidate.toLowerCase().includes(needle)) continue;
				lines.push(`${candidate}\t${model.provider}`);
			}
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
