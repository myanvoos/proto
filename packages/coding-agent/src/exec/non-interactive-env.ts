import { $which } from "@oh-my-pi/pi-utils";

export const REJECT_PROMPT_COMMAND = $which("false") ?? "false";

export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
	PAGER: "cat",
	GIT_PAGER: "cat",
	MANPAGER: "cat",
	SYSTEMD_PAGER: "cat",
	BAT_PAGER: "cat",
	DELTA_PAGER: "cat",
	GH_PAGER: "cat",
	GLAB_PAGER: "cat",
	PSQL_PAGER: "cat",
	MYSQL_PAGER: "cat",
	AWS_PAGER: "",
	HOMEBREW_PAGER: "cat",
	LESS: "FRX",

	TERM: "dumb",
	NO_COLOR: "1",
	PYTHONUNBUFFERED: "1",

	GIT_EDITOR: "true",
	VISUAL: "true",
	EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	// Configured sequence editors otherwise block interactive rebases.
	GIT_SEQUENCE_EDITOR: "true",
	SSH_ASKPASS: REJECT_PROMPT_COMMAND,
	CI: "true",
	AGENT: "1",

	npm_config_yes: "true",
	npm_config_update_notifier: "false",
	npm_config_fund: "false",
	npm_config_audit: "false",
	npm_config_progress: "false",
	PNPM_DISABLE_SELF_UPDATE_CHECK: "true",
	PNPM_UPDATE_NOTIFIER: "false",
	YARN_ENABLE_TELEMETRY: "0",
	YARN_ENABLE_PROGRESS_BARS: "0",

	CARGO_TERM_PROGRESS_WHEN: "never",
	DEBIAN_FRONTEND: "noninteractive",
	PIP_NO_INPUT: "1",
	PIP_DISABLE_PIP_VERSION_CHECK: "1",
	TF_INPUT: "0",
	TF_IN_AUTOMATION: "1",
	GH_PROMPT_DISABLED: "1",
	COMPOSER_NO_INTERACTION: "1",
	CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
};

/**
 * Locale pinned for agent commands: byte-order collation, `C` numbers, dates,
 * and English messages like `C`, but UTF-8 text, which `C` would split into bytes.
 */
const AGENT_LOCALE = "C.UTF-8";

function hasLocaleEnvValue(env: Record<string, string | undefined> | undefined): boolean {
	if (!env) return false;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (key === "LANG" || key.startsWith("LC_")) return true;
	}
	return false;
}

/** Copy of the base env with `CI` removed, for the `PI_BASH_NO_CI` opt-out. */
function withoutCI(env: Readonly<Record<string, string>>): Record<string, string> {
	const { CI: _ci, ...rest } = env;
	return rest;
}

/** Options for {@link buildNonInteractiveEnv}. */
export interface NonInteractiveEnvOptions {
	/** Env the child inherits from the launcher. */
	baseEnv?: Record<string, string | undefined>;
	/** Keep the inherited locale instead of pinning {@link AGENT_LOCALE}: user-typed `!` commands. */
	inheritLocale?: boolean;
}

/** Builds the per-command environment for non-interactive child processes. */
export function buildNonInteractiveEnv(
	overrides?: Record<string, string>,
	{ baseEnv = Bun.env, inheritLocale = false }: NonInteractiveEnvOptions = {},
): Record<string, string> {
	// `PI_BASH_NO_CI` (and its legacy alias) opts out of the automatic `CI=true`
	// injection. Mirrors the session-env gate in `procmgr.ts` so the opt-out
	// reaches the per-command env, which otherwise overrides the session value.
	const env: Record<string, string> =
		baseEnv.PI_BASH_NO_CI || baseEnv.CLAUDE_BASH_NO_CI ? withoutCI(NON_INTERACTIVE_ENV) : { ...NON_INTERACTIVE_ENV };

	// Agent commands pin the locale whatever the launcher inherited, so sort
	// order, number formats, and messages do not vary by machine; a locale in
	// the command's own env (or direnv) opts out.
	if (!inheritLocale && !hasLocaleEnvValue(overrides)) {
		env.LANG = AGENT_LOCALE;
		env.LC_ALL = AGENT_LOCALE;
	}

	return overrides ? { ...env, ...overrides } : env;
}
