import type { Args } from "../../cli/args";
import type { SetupWizardOutcome } from "../setup-wizard";

export const ACP_TERMINAL_AUTH_FLAG = "--acp-terminal-auth";

interface AcpTerminalAuthArgs {
	args: string[];
	terminalAuth: boolean;
}

export function prepareAcpTerminalAuthArgs(rawArgs: readonly string[]): AcpTerminalAuthArgs {
	const withoutAuthFlag: string[] = [];
	let terminalAuth = false;
	for (const arg of rawArgs) {
		if (arg === ACP_TERMINAL_AUTH_FLAG) {
			terminalAuth = true;
			continue;
		}
		withoutAuthFlag.push(arg);
	}

	if (!terminalAuth) {
		return { args: withoutAuthFlag, terminalAuth: false };
	}

	const args: string[] = [];
	for (let i = 0; i < withoutAuthFlag.length; i++) {
		const arg = withoutAuthFlag[i];
		if (arg === "--mode") {
			i++;
			continue;
		}
		if (arg.startsWith("--mode=")) {
			continue;
		}
		args.push(arg);
	}

	return { args, terminalAuth: true };
}

/**
 * The client starts terminal auth with its base launch args plus ours (the spec reuses the agent's base
 * launch configuration). Keep what shapes sign-in, such as config files and extensions that add
 * providers; drop whatever would pick or persist a session, send a prompt, or start tools and MCP servers.
 */
export function terminalAuthArgs(parsed: Args): Args {
	return {
		...parsed,
		mode: undefined,
		print: false,
		messages: [],
		fileArgs: [],
		continue: false,
		resume: undefined,
		fork: undefined,
		fromClaude: false,
		fromCodex: false,
		noSession: true,
		noTools: true,
		tools: undefined,
		noTitle: true,
	};
}

/**
 * ACP gives terminal auth no in-band result: exit status 0 tells the client sign-in worked and it may
 * reconnect, anything else that it failed. Succeed only when sign-in ended with a usable model, so a
 * skipped step never claims credentials that do not exist.
 */
export function finishTerminalAuth(
	outcome: SetupWizardOutcome,
	availableModels: number,
	write: (text: string) => void = text => process.stderr.write(text),
): number {
	if (outcome === "cancelled") {
		write("Sign-in cancelled.\n");
		return 1;
	}
	if (availableModels === 0) {
		write("No provider is signed in yet, so there is no model to use. Sign in to a provider to finish.\n");
		return 1;
	}
	write(`Signed in: ${availableModels} model${availableModels === 1 ? "" : "s"} available.\n`);
	return 0;
}
