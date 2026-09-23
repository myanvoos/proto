/**
 * Terminal (readline) OAuth login primitives shared by `proto login` and `proto auth-broker login`.
 *
 * Callers own ONE `readline.Interface` for the whole command and pass it to every step: readline buffers
 * whole input chunks, so a second interface on piped stdin never sees lines the first one already consumed.
 */
import * as readline from "node:readline";
import {
	type AuthStorage,
	isPasteCodeLoginProvider,
	type OAuthLoginIdentity,
	type OAuthProviderId,
	type OAuthProviderInfo,
} from "@oh-my-pi/pi-ai";
import { openPath } from "../utils/open";

/**
 * Line prompt that tears down cleanly on Ctrl-C / Escape so a cancelled login never leaves the terminal in
 * raw mode. Rejects with "Login cancelled" on Ctrl-C / Escape or when stdin closes before an answer.
 */
export function promptLine(rl: readline.Interface, question: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const input = process.stdin as NodeJS.ReadStream;
	const supportsRawMode = input.isTTY && typeof input.setRawMode === "function";
	const wasRaw = supportsRawMode ? input.isRaw : false;
	let settled = false;

	const cleanup = () => {
		rl.off("SIGINT", onSigint);
		rl.off("close", cancel);
		if (supportsRawMode) {
			input.off("keypress", onKeypress);
			input.setRawMode?.(wasRaw);
		}
	};

	const finish = (result: () => void) => {
		if (settled) return;
		settled = true;
		cleanup();
		result();
	};

	const cancel = () => {
		finish(() => reject(new Error("Login cancelled")));
	};

	const onSigint = () => {
		cancel();
	};

	const onKeypress = (_str: string, key: readline.Key) => {
		if (key.name === "escape" || (key.ctrl && key.name === "c")) {
			cancel();
			rl.close();
		}
	};

	if (supportsRawMode) {
		readline.emitKeypressEvents(input, rl);
		input.setRawMode(true);
		input.on("keypress", onKeypress);
	}

	rl.once("SIGINT", onSigint);
	rl.once("close", cancel);
	try {
		rl.question(question, answer => {
			finish(() => resolve(answer));
		});
	} catch {
		// `rl.question` throws ERR_USE_AFTER_CLOSE once piped stdin hit EOF.
		finish(() => reject(new Error("Login cancelled: stdin closed")));
	}
	return promise;
}

/** Numbered stdin picker over `labels`; resolves with the chosen index or throws on an unlisted answer. */
export async function pickIndex(rl: readline.Interface, title: string, labels: readonly string[]): Promise<number> {
	process.stdout.write(`${title}\n\n`);
	for (let i = 0; i < labels.length; i++) {
		process.stdout.write(`  ${i + 1}. ${labels[i]}\n`);
	}
	process.stdout.write("\n");
	const choice = await promptLine(rl, `Enter number (1-${labels.length}): `);
	const index = Number.parseInt(choice, 10) - 1;
	if (Number.isNaN(index) || index < 0 || index >= labels.length) {
		throw new Error(`Invalid selection: ${choice}`);
	}
	return index;
}

export async function pickOAuthProvider(
	rl: readline.Interface,
	providers: readonly OAuthProviderInfo[],
): Promise<string> {
	if (providers.length === 0) {
		throw new Error("No OAuth providers registered");
	}
	const index = await pickIndex(
		rl,
		"Select a provider:",
		providers.map(p => p.name),
	);
	return providers[index].id;
}

/**
 * Run `provider`'s OAuth flow against `storage`, printing the auth URL and progress to stdout and reading
 * prompts from stdin. Resolves with the stored identity. `openBrowser` also opens the auth URL locally
 * (best-effort) — off for broker-host logins, which usually run headless.
 */
export async function runTerminalOAuthLogin(
	rl: readline.Interface,
	storage: AuthStorage,
	provider: OAuthProviderId,
	options: { openBrowser?: boolean } = {},
): Promise<OAuthLoginIdentity | undefined> {
	const ask = (msg: string) => promptLine(rl, `${msg} `);
	// Loopback providers complete over HTTP; only fixed non-loopback redirects need the paste fallback.
	const usesManualInput = isPasteCodeLoginProvider(provider);
	return storage.login(provider, {
		onAuth({ url, launchUrl, instructions }) {
			process.stdout.write("\nOpen this URL in your browser:\n");
			// Full URL first: works from any machine, including SSH sessions where the loopback `launchUrl`
			// would resolve against the caller's browser. Headless capture reads the first URL line.
			process.stdout.write(`${url}\n`);
			if (launchUrl && launchUrl !== url) {
				process.stdout.write(`Local shortcut (this machine only): ${launchUrl}\n`);
			}
			if (instructions) process.stdout.write(`${instructions}\n`);
			process.stdout.write("\n");
			if (options.openBrowser) openPath(url);
		},
		onProgress(message) {
			process.stdout.write(`${message}\n`);
		},
		async onPrompt(p) {
			// readline echoes input; hosts that cannot mask must reject secret prompts.
			if (p.secret) {
				throw new Error("This provider requires secret input, which the terminal login cannot mask.");
			}
			return ask(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
		},
		...(usesManualInput
			? {
					onManualCodeInput() {
						return ask("Paste the authorization code (or full redirect URL):");
					},
				}
			: undefined),
	});
}

/** `email (org)`, `email`, or `org` for the account a login stored; undefined for API keys and identity-less grants. */
export function formatLoginIdentity(identity: OAuthLoginIdentity | undefined): string | undefined {
	if (identity?.type !== "oauth") return undefined;
	const base = identity.email ?? identity.accountId;
	const org = identity.orgName ?? identity.orgId;
	if (base) return org ? `${base} (${org})` : base;
	return org;
}
