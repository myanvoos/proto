import { Args, type CommandMetadata, Flags } from "@oh-my-pi/pi-utils/cli";
import { BINARY_NAME } from "@oh-my-pi/pi-utils/dirs";
import { SERVICE_TIER_OPENAI_VALUES } from "../config/service-tier";
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { SEARCH_PROVIDER_ORDER } from "../web/search/types";
import type { GalleryState } from "./gallery-cli";

export const AUTH_BROKER_ACTIONS = [
	"serve",
	"token",
	"login",
	"logout",
	"import",
	"migrate",
	"status",
	"list",
] as const;

export const AUTH_GATEWAY_ACTIONS = ["serve", "token", "status", "check"] as const;

export const BROWSER_RELAY_ACTIONS = ["serve", "install"] as const;

export const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);

export const IMAGES_ACTIONS = ["status", "doctor", "probe", "purge"] as const;

export const TTSR_ACTIONS = ["test", "list", "scan"] as const;

export const TTSR_SOURCES = ["text", "thinking", "tool"] as const;

export const GALLERY_STATE_ALIASES: Record<string, GalleryState> = {
	streaming: "streaming",
	"streaming args": "streaming",
	progress: "progress",
	"in progress": "progress",
	success: "success",
	done: "success",
	error: "error",
	failed: "error",
};

export const GALLERY_STATE_TOKENS = Object.keys(GALLERY_STATE_ALIASES);

export const acpHelp = {
	description: "Run Proto as an ACP (Agent Client Protocol) server over stdio",
} satisfies CommandMetadata;

export const agentsHelp = {
	description: "Manage bundled worker agents",
	args: {
		action: Args.string({
			description: "Agents action",
			required: false,
			options: ["unpack"],
		}),
	},
	flags: {
		force: Flags.boolean({ char: "f", description: "Overwrite existing agent files" }),
		json: Flags.boolean({ description: "Output JSON" }),
		dir: Flags.string({ description: "Output directory (overrides --user/--project)" }),
		user: Flags.boolean({ description: "Write to ~/.proto/agent/agents (default)" }),
		project: Flags.boolean({ description: "Write to ./.proto/agents" }),
	},
	examples: [
		"# Export bundled agents into user config (default)\n  proto agents unpack",
		"# Export bundled agents into project config\n  proto agents unpack --project",
		"# Overwrite existing local agent files\n  proto agents unpack --project --force",
		"# Export into a custom directory\n  proto agents unpack --dir ./tmp/agents --json",
	],
} satisfies CommandMetadata;

export const authBrokerHelp = {
	description: "Manage the proto auth-broker (credential vault)",
	args: {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_BROKER_ACTIONS],
		}),

		source: Args.string({
			description: "OAuth provider id (login/logout) or path (import)",
			required: false,
		}),
	},
	flags: {
		json: Flags.boolean({ description: "Output JSON" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		regenerate: Flags.boolean({ description: "Regenerate the bearer token" }),
		via: Flags.string({
			description: "SSH user@host for remote login (login --via=user@host)",
		}),
		provider: Flags.string({
			description: "Override provider id for `import` (e.g. when JSON `type` is unrecognized)",
		}),
		"include-disabled": Flags.boolean({
			description: "Import credentials whose JSON has `disabled: true` (import)",
		}),
		"from-local": Flags.boolean({
			description: "migrate source: local SQLite + env vars (required for `migrate`)",
		}),
		"include-env": Flags.boolean({
			description: "Capture env-var API keys for providers not yet on broker (migrate)",
		}),
		"include-oauth": Flags.boolean({
			description: "Also upload OAuth from local SQLite during migrate (default skips them)",
		}),
		"dry-run": Flags.boolean({ description: "Print actions without executing (import / login --via / migrate)" }),
	},
	examples: [
		"# Boot the broker against the local SQLite store\n  proto auth-broker serve",
		"# Boot on a non-default port\n  proto auth-broker serve --bind=127.0.0.1:9000",
		"# Print the bearer token\n  proto auth-broker token",
		"# Rotate the bearer token\n  proto auth-broker token --regenerate",
		"# List supported OAuth providers\n  proto auth-broker list",
		"# Local login (run on the broker host)\n  proto auth-broker login anthropic",
		"# Interactive provider selection\n  proto auth-broker login",
		"# Remote login over SSH tunnel\n  proto auth-broker login anthropic --via=user@broker",
		"# Log out of a provider (interactive without provider arg)\n  proto auth-broker logout anthropic",
		"# Import a CLIProxyAPI auth dump\n  proto auth-broker import ~/.cliproxy/auth",
		"# Import a single CLIProxyAPI JSON, overriding the provider mapping\n  proto auth-broker import ~/.cliproxy/auth/claude-foo.json --provider anthropic",
		"# Preview a migration from local store + env vars to the configured broker\n  proto auth-broker migrate --from-local --include-env --dry-run",
		"# Apply the migration\n  proto auth-broker migrate --from-local --include-env",
		"# Health-check the configured remote broker\n  proto auth-broker status",
	],
} satisfies CommandMetadata;

export const authGatewayHelp = {
	description: "Run an auth-gateway forward proxy backed by the configured broker",
	args: {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_GATEWAY_ACTIONS],
		}),
	},
	flags: {
		json: Flags.boolean({ description: "Output JSON (token/status/check)" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		regenerate: Flags.boolean({ description: "Regenerate the gateway bearer token (token)" }),
		"no-auth": Flags.boolean({
			description:
				"Disable inbound bearer-token auth (serve). Useful when bound to loopback — any caller is allowed.",
		}),
		strict: Flags.boolean({
			description:
				"For `check`: additionally probe each credential against its provider's chat-completion endpoint. Slower; consumes a tiny amount of quota per credential.",
		}),
	},
	examples: [
		"# Boot the gateway against the configured broker\n  proto auth-gateway serve",
		"# Boot on a non-default port\n  proto auth-gateway serve --bind=127.0.0.1:4000",
		"# Print the gateway bearer token (creates one on first run)\n  proto auth-gateway token",
		"# Rotate the gateway bearer token\n  proto auth-gateway token --regenerate",
		"# Run on loopback without any bearer (anyone on this host can call)\n  proto auth-gateway serve --no-auth",
		"# Show local gateway + broker config status\n  proto auth-gateway status",
		"# Probe each broker credential to see which one is producing 401s\n  proto auth-gateway check",
		"# Same, machine-readable for scripts\n  proto auth-gateway check --json",
		"# Strict check — also exercises each credential with a real chat-completion ping\n  proto auth-gateway check --strict",
	],
} satisfies CommandMetadata;

export const benchHelp = {
	description:
		"Benchmark models: TTFT/prefill vs decode throughput with p50/p95, across chat, prefill, generation, and prompt-cache workloads",
	args: {
		models: Args.string({
			description: "Model selectors (provider/model or fuzzy id, e.g. opus)",
			required: true,
			multiple: true,
		}),
	},
	flags: {
		runs: Flags.integer({ description: "Requests per model (default: 9 for mix, 10 chat, 5 prefill/generation)" }),
		"max-tokens": Flags.integer({
			description: "Max output tokens per request (default: chat 512, prefill 64, generation 2048, cache 64)",
		}),
		prompt: Flags.string({ description: "Custom prompt text (requires --profile chat or generation)" }),
		profile: Flags.string({
			description:
				"Benchmark workload (default mix rotates all): chat (balanced), prefill (large cache-busted input, measures input processing), generation (long forced output, measures sustained decode)",
			options: ["mix", "chat", "prefill", "generation"],
		}),
		"prefill-bytes": Flags.integer({
			description: "Synthetic input size for prefill challenges (default: 32768)",
		}),
		"service-tier": Flags.string({
			description: "Service tier applied per model family (default: configured `tier.*` settings; `none` omits it)",
			options: SERVICE_TIER_OPENAI_VALUES,
		}),
		json: Flags.boolean({ description: "Output JSON" }),
		par: Flags.integer({ description: "Execute runs with N parallel queries/requests (default: 4)" }),
		cache: Flags.boolean({
			description: "Run independent cold/warm prompt-cache pairs (not supported for openai-codex-responses)",
		}),
		"cache-prefix-file": Flags.string({ description: "Stable prompt prefix file for --cache" }),
		"cache-prefix-bytes": Flags.integer({ description: "Stable prefix byte budget for --cache (default: 8192)" }),
		"cache-pairs": Flags.integer({ description: "Cold/warm pairs per model for --cache (default: 1)" }),
		"cache-concurrency": Flags.integer({
			description: "Concurrent cache pairs for --cache; each pair remains sequential (default: 1)",
		}),
	},
	examples: [
		"# Compare two models across mixed challenges (chat, prefill, generation)\n  proto bench anthropic/claude-opus-4-5 openai/gpt-5.2",
		"# Fuzzy selectors work\n  proto bench opus sonnet",
		"# Average over 3 runs each\n  proto bench opus gpt-5.2 --runs 3",
		"# Isolate prompt-ingestion speed with a 64 KiB cache-busted input\n  proto bench opus sonnet --profile prefill --prefill-bytes 65536",
		"# Isolate sustained decode throughput\n  proto bench opus sonnet --profile generation",
		"# Force priority serving tier\n  proto bench openai-codex/gpt-5.5:low --runs 10 --service-tier priority",
		"# Measure one cold/warm prompt-cache pair\n  proto bench openai/gpt-5.6 --cache --json",
	],
} satisfies CommandMetadata;

export const browserRelayHelp = {
	description: "Run the local CDP relay that lets the browser tool drive your own Chrome tabs",
	args: {
		action: Args.string({
			description: `Action: ${BROWSER_RELAY_ACTIONS.join(" | ")} (default serve)`,
			options: [...BROWSER_RELAY_ACTIONS],
			required: false,
		}),
	},
	flags: {
		port: Flags.integer({ char: "p", description: "Port to listen on", default: DEFAULT_RELAY_PORT }),
		token: Flags.string({ description: "Require the extension to present this token" }),
		dir: Flags.string({
			description: "Extension install directory (install; default ~/.proto/browser-relay/extension)",
		}),
		"no-group": Flags.boolean({
			description: "Don't gather controllable tabs into a 'proto' tab group",
			default: false,
		}),
		verbose: Flags.boolean({ char: "v", description: "Log relay traffic summaries to stderr", default: false }),
	},
	examples: [
		"proto browser-relay install    # write the Chrome extension to disk + setup steps",
		"proto browser-relay            # serve the relay on the default port",
		"proto browser-relay -p 9333 --token s3cret",
	],
} satisfies CommandMetadata;

export const commitHelp = {
	description: "Generate a commit message and update changelogs",
	flags: {
		push: Flags.boolean({ description: "Push after committing" }),
		"dry-run": Flags.boolean({ description: "Preview without committing" }),
		"no-changelog": Flags.boolean({ description: "Skip changelog updates" }),
		legacy: Flags.boolean({ description: "Use legacy deterministic pipeline" }),
		context: Flags.string({ char: "c", description: "Additional context for the model" }),
		model: Flags.string({ char: "m", description: "Override model selection" }),
	},
} satisfies CommandMetadata;

export const completionsHelp = {
	description: "Print a shell completion script (bash, zsh, or fish)",
	args: {
		shell: Args.string({
			description: "Target shell",
			required: true,
			options: ["bash", "zsh", "fish"] as const,
		}),
	},
	examples: [
		`# zsh — eval at startup, or write to a file in $fpath\n  eval "$(${BINARY_NAME} completions zsh)"`,
		`# bash\n  eval "$(${BINARY_NAME} completions bash)"`,
		`# fish\n  ${BINARY_NAME} completions fish > ~/.config/fish/completions/${BINARY_NAME}.fish`,
	],
} satisfies CommandMetadata;

export const completeHelp = { hidden: true } satisfies CommandMetadata;

export const compressHelp = {
	description: "Rewrite a text file into the dense prompt register, reporting what it drops",
	args: {
		files: Args.string({ description: "Files or glob patterns to compress", required: true, multiple: true }),
	},
	flags: {
		out: Flags.string({ char: "o", description: "Write the approved text here instead of stdout (single file)" }),
		inPlace: Flags.boolean({ char: "i", description: "Overwrite each source file with its approved text" }),
		rounds: Flags.integer({ char: "r", description: "Maximum drafts per file before giving up", default: 3 }),
		agents: Flags.integer({ char: "n", description: "Files compressed concurrently", default: 4 }),
		model: Flags.string({ char: "m", description: "Model selector" }),
	},
	examples: [
		"proto compress prompts/tools/read.md",
		"proto compress notes.md -o notes.compressed.md",
		"proto compress 'src/prompts/**/*.md' -i",
		"proto compress a.md b.md c.md -i -n 8",
		"proto compress spec.md -r 5 -m opus",
	],
} satisfies CommandMetadata;

export const configHelp = {
	description: "Manage configuration settings",
	args: {
		action: Args.string({
			description: "Config action",
			required: false,
			options: ["list", "get", "set", "reset", "path", "init-xdg"],
		}),
		key: Args.string({
			description: "Setting key",
			required: false,
		}),
		value: Args.string({
			description: "Value (for set/reset)",
			required: false,
			multiple: true,
		}),
	},
	flags: {
		json: Flags.boolean({ description: "Output JSON" }),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
	},
} satisfies CommandMetadata;

export const dryBalanceHelp = {
	description: "Dry-run OAuth account balancing across random session ids",
	args: {
		model: Args.string({
			description: "Model selector (provider/model or fuzzy id). Defaults to the configured default model.",
			required: false,
		}),
	},
	flags: {
		model: Flags.string({ description: "Model selector (same syntax as --model on proto)" }),
		count: Flags.integer({ description: "Number of random session ids to try", default: 100 }),
		concurrency: Flags.integer({ description: "Maximum concurrent credential resolutions", default: 32 }),
		json: Flags.boolean({ description: "Output JSON" }),
		bench: Flags.boolean({ description: "Send one live benchmark request per OAuth account" }),
	},
	examples: [
		"# Dry-run the configured default model with 100 random session ids\n  proto dry-balance",
		"# Dry-run a specific model\n  proto dry-balance anthropic/claude-sonnet-4-5",
		"# Larger run with bounded concurrency\n  proto dry-balance --model openai-codex/gpt-5-codex --count 1000 --concurrency 64",
		"# Benchmark every OAuth account in parallel\n  proto dry-balance --bench",
		"# Machine-readable output\n  proto dry-balance --json",
	],
} satisfies CommandMetadata;

export const galleryHelp = {
	description: "Preview tool renderers across streaming, in-progress, success, and failure states",
	flags: {
		tool: Flags.string({ char: "t", description: "Render a single tool by name" }),
		state: Flags.string({
			char: "s",
			description: "Render only the given lifecycle state(s)",
			options: GALLERY_STATE_TOKENS,
			multiple: true,
		}),
		width: Flags.integer({ char: "w", description: "Render width in columns" }),
		expanded: Flags.boolean({
			char: "e",
			description: "Render the expanded variant of each renderer",
			default: false,
		}),
		plain: Flags.boolean({ description: "Strip ANSI styling from the output", default: false }),
		screenshot: Flags.boolean({
			description:
				"Capture the rendered output as PNG screenshot(s) via VHS instead of printing ANSI (requires vhs)",
			default: false,
		}),
		out: Flags.string({
			char: "o",
			description: "Screenshot output path (with --screenshot); suffixed per image when split across multiple",
		}),
		font: Flags.string({ description: "Screenshot font family (default: JetBrainsMono Nerd Font)" }),
		"font-size": Flags.integer({ description: "Screenshot font size in points (default: 18)" }),
	},
} satisfies CommandMetadata;

export const gcHelp = {
	description: "Run storage garbage collection",
	flags: {
		apply: Flags.boolean({ description: "Apply changes (default is dry-run)" }),
		json: Flags.boolean({ description: "Output JSON" }),
		"agent-dir": Flags.string({ description: "Agent directory to maintain" }),
		blobs: Flags.boolean({ description: "Sweep unreferenced blobs" }),
		archive: Flags.boolean({ description: "Archive cold sessions" }),
		wal: Flags.boolean({ description: "Checkpoint history/model database WAL files" }),
		"cold-archive-after-days": Flags.integer({ description: "Minimum session age before archiving" }),
		"retain-newest-global": Flags.integer({ description: "Always keep this many newest sessions active" }),
		"retain-newest-per-cwd": Flags.integer({ description: "Always keep this many newest sessions per cwd" }),
	},
} satisfies CommandMetadata;

export const grepHelp = {
	description: "Test grep tool",
	args: {
		pattern: Args.string({ description: "Regex pattern to search for", required: false }),
		path: Args.string({ description: "Directory or file to search", required: false }),
	},
	flags: {
		glob: Flags.string({ char: "g", description: "Filter files by glob pattern" }),
		limit: Flags.integer({ char: "l", description: "Max matches", default: 20 }),
		context: Flags.integer({ char: "C", description: "Context lines", default: 2 }),
		files: Flags.boolean({ char: "f", description: "Output file names only" }),
		count: Flags.boolean({ char: "c", description: "Output match counts per file" }),
		"no-gitignore": Flags.boolean({ description: "Include files excluded by .gitignore" }),
	},
} satisfies CommandMetadata;

export const grievancesHelp = {
	description: "View, clean, or push reported tool issues (auto-QA grievances)",
	args: {
		action: Args.string({
			description: "list (default), clean, or push",
			required: false,
			options: ["list", "clean", "push"],
			default: "list",
		}),
	},
	flags: {
		limit: Flags.integer({ char: "n", description: "Number of recent issues to show (list)", default: 20 }),
		tool: Flags.string({ char: "t", description: "Filter by tool name (list, clean)" }),
		json: Flags.boolean({ char: "j", description: "Output as JSON", default: false }),
		id: Flags.integer({ description: "Delete a single grievance by id (clean)" }),
		all: Flags.boolean({ description: "Delete every grievance (clean)", default: false }),
	},
	examples: [
		"proto grievances",
		"proto grievances list --tool find",
		"proto grievances clean --id 209",
		"proto grievances clean --tool find",
		"proto grievances clean --all",
		"proto grievances push",
	],
} satisfies CommandMetadata;

export const imagesHelp = {
	description: "Inspect, diagnose, probe, and purge image publication backends",
	args: {
		action: Args.string({
			description: "status (default), doctor, probe, or purge",
			required: false,
			options: [...IMAGES_ACTIONS],
		}),
	},
	flags: {
		json: Flags.boolean({ description: "Output one JSON document" }),
		apply: Flags.boolean({ description: "Apply purge deletions (default is dry-run)" }),
		all: Flags.boolean({ description: "Purge all entries instead of expired entries only" }),
		dir: Flags.string({ description: "Project directory (default: current directory)" }),
		timeout: Flags.integer({ description: "External health probe timeout in seconds" }),
	},
	examples: [
		"proto images",
		"proto images status --json",
		"proto images doctor",
		"proto images probe --timeout 15",
		"proto images purge",
		"proto images purge --all --apply",
	],
} satisfies CommandMetadata;

export const installHelp = {
	description: "Install or link an extension package (alias of `plugin install`/`plugin link`)",
	args: {
		targets: Args.string({
			description: "Local path, npm spec, or marketplace ref (e.g. ./my-ext, my-pkg@1.2.3, name@marketplace)",
			required: false,
			multiple: true,
		}),
	},
	flags: {
		json: Flags.boolean({ description: "Output JSON" }),
		force: Flags.boolean({ description: "Force install" }),
		"dry-run": Flags.boolean({ description: "Show actions without applying changes" }),
		scope: Flags.string({
			description: 'Install scope: "user" (default) or "project" (marketplace installs only)',
			options: ["user", "project"],
		}),
	},
} satisfies CommandMetadata;

export const modelsHelp = {
	description: "List, search, and refresh available models",
	args: {
		action: Args.string({
			description: "ls (default) | find | refresh | <provider>",
			required: false,
		}),
		pattern: Args.string({
			description: "Filter/search substring, or provider name (required for find)",
			required: false,
		}),
	},
	flags: {
		json: Flags.boolean({ description: "Output JSON" }),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file before listing (repeatable)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
	},
	examples: [
		`# List every available model, grouped by provider\n  ${BINARY_NAME} models`,
		`# List one provider's models (any provider name works)\n  ${BINARY_NAME} models openai-codex`,
		`# Find models by substring\n  ${BINARY_NAME} models find minimax`,
		`# Force a fresh catalog fetch (replaces rm -rf ~/.proto/models.db)\n  ${BINARY_NAME} models refresh`,
		`# Machine-readable output\n  ${BINARY_NAME} models --json`,
	],
} satisfies CommandMetadata;

export const attachHelp = {
	description: "Attach to a daemon-hosted session: watch it live, send prompts, detach without stopping it",
	args: {
		session: Args.string({
			description: "Session id or file path (default: most recent session for the project)",
			required: false,
		}),
	},
	flags: {
		dir: Flags.string({ description: "Project directory the session belongs to (default: cwd)" }),
		messages: Flags.integer({ description: "Number of recent messages to replay on attach (default 10)" }),
		stop: Flags.boolean({ description: "Stop the daemon-supervised session host instead of attaching" }),
	},
	examples: ["proto attach", "proto attach <session-id>", "proto attach --stop <session-id>"],
} satisfies CommandMetadata;

export const pluginHelp = {
	description: "Manage plugins (install, uninstall, list, etc.)",
	args: {
		action: Args.string({
			description: "Plugin action",
			required: false,
			options: [
				"install",
				"uninstall",
				"list",
				"link",
				"doctor",
				"features",
				"config",
				"enable",
				"disable",
				"marketplace",
				"discover",
				"upgrade",
			],
		}),
		targets: Args.string({
			description: "Packages, paths, or plugin names",
			required: false,
			multiple: true,
		}),
	},
	flags: {
		json: Flags.boolean({ description: "Output JSON" }),
		fix: Flags.boolean({ description: "Attempt to fix issues (doctor)" }),
		force: Flags.boolean({ description: "Force install; link local plugins despite validation problems" }),
		"dry-run": Flags.boolean({ description: "Show actions without applying changes" }),
		local: Flags.boolean({ char: "l", description: "Operate on local plugin directory" }),
		enable: Flags.string({ description: "Enable a feature" }),
		disable: Flags.string({ description: "Disable a feature" }),
		set: Flags.string({
			description:
				"Set plugin config (config <plugin> --set key=value) or replace features (features <plugin> --set f1,f2)",
		}),
		scope: Flags.string({
			description: 'Install scope: "user" (default) or "project"',
			options: ["user", "project"],
		}),
	},
} satisfies CommandMetadata;

export const psHelp = {
	description: "List and control daemon-supervised background processes (logs, stop, kill, restart)",
	args: {
		action: Args.string({
			description: "list (default), info, logs, stop, kill, or restart",
			required: false,
			options: ["list", "info", "logs", "stop", "kill", "restart"],
		}),
		name: Args.string({
			description: "Process name (required for every action except list)",
			required: false,
		}),
	},
	flags: {
		all: Flags.boolean({ char: "a", description: "List every project and global service scope (list)" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
		plain: Flags.boolean({ description: "Static listing instead of the interactive monitor (list)" }),
		dir: Flags.string({ description: "Target another project directory instead of the current one" }),
		global: Flags.string({ description: "Target a machine-global service scope (e.g. browser-relay)" }),
		follow: Flags.boolean({ char: "f", description: "Keep streaming new output (logs)" }),
		head: Flags.boolean({ description: "Read from the beginning instead of the tail (logs)" }),
		lines: Flags.integer({ char: "n", description: "Number of log lines, max 1000 (logs)" }),
		grep: Flags.string({ description: "Regex filter applied to log lines (logs)" }),
		timeout: Flags.integer({ description: "Grace period in seconds before hard kill (stop)" }),
	},
	examples: [
		"proto ps",
		"proto ps --all",
		"proto ps logs web --follow",
		"proto ps stop web",
		"proto ps kill web",
		"proto ps info relay --global browser-relay",
	],
} satisfies CommandMetadata;

export const readHelp = {
	description: "Show what the read tool will return for a path, URL, or internal URI",
	args: {
		path: Args.string({
			description:
				"Path, URL, or internal URI to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	},
	examples: [
		"proto read src/foo.ts",
		"proto read src/foo.ts:50-100",
		"proto read src/foo.ts:raw",
		"proto read https://example.com",
		"proto read proto://",
		"proto read path/to/archive.zip:dir/file.ts",
		"proto read path/to/db.sqlite:users:42",
	],
} satisfies CommandMetadata;
export const renderHelp = {
	description: "Draw a session's entire thread through the production transcript pipeline (with repaint timing)",
	args: {
		session: Args.string({ description: "Session file path or id prefix (default: most recent for cwd)" }),
	},
	flags: {
		width: Flags.integer({ char: "w", description: "Render width in columns (default: terminal width)" }),
		height: Flags.integer({ description: "Viewport height in rows (default: terminal height)" }),
		timing: Flags.boolean({ char: "t", description: "Print phase timings and emitted byte counts to stderr" }),
		repaint: Flags.integer({
			description: "Benchmark N extra full clear-scrollback repaints (the /tree navigation frame)",
		}),
		plain: Flags.boolean({ description: "Strip ANSI styling from the output", default: false }),
		quiet: Flags.boolean({ char: "q", description: "Suppress transcript output (benchmark runs)", default: false }),
	},
	examples: [
		"proto render",
		"proto render 01a0285c --plain",
		"proto render ~/.proto/agent/sessions/--work-project--/big.jsonl -q -t --repaint 5",
		"proto render -w 200 > thread.ansi",
	],
} satisfies CommandMetadata;

export const searchHelp = {
	description: "Test web search providers",
	args: {
		query: Args.string({ description: "Search query text", required: false, multiple: true }),
	},
	flags: {
		provider: Flags.string({ description: "Search provider", options: ["auto", ...SEARCH_PROVIDER_ORDER] }),
		recency: Flags.string({ description: "Recency filter", options: ["day", "week", "month", "year"] }),
		limit: Flags.integer({ char: "l", description: "Max results to return" }),
		compact: Flags.boolean({ description: "Render condensed output" }),
	},
} satisfies CommandMetadata;

export const setupHelp = {
	description: "Run onboarding setup or install dependencies for optional features",
	args: {
		component: Args.string({
			description: "Optional component to install",
			required: false,
			options: ["python"],
		}),
	},
	flags: {
		check: Flags.boolean({ char: "c", description: "Check if dependencies are installed" }),
		json: Flags.boolean({ description: "Output status as JSON" }),
	},
} satisfies CommandMetadata;

export const shellHelp = {
	description: "Interactive shell console",
	flags: {
		cwd: Flags.string({ char: "C", description: "Set working directory for commands" }),
		timeout: Flags.integer({ char: "t", description: "Timeout per command in milliseconds" }),
		"no-snapshot": Flags.boolean({ description: "Skip sourcing snapshot from user shell" }),
	},
} satisfies CommandMetadata;

export const sshHelp = {
	description: "Manage SSH host configurations",
	args: {
		action: Args.string({
			description: "SSH action",
			required: false,
			options: ["add", "remove", "list"],
		}),
		targets: Args.string({
			description: "Host name or arguments",
			required: false,
			multiple: true,
		}),
	},
	flags: {
		json: Flags.boolean({ description: "Output JSON" }),
		host: Flags.string({ description: "Host address" }),
		user: Flags.string({ description: "Username" }),
		port: Flags.string({ description: "Port number" }),
		key: Flags.string({ description: "Identity key path" }),
		desc: Flags.string({ description: "Host description" }),
		scope: Flags.string({ description: "Config scope (project|user)", options: ["project", "user"] }),
	},
} satisfies CommandMetadata;

export const tinyModelsHelp = {
	description: "Download tiny local models (session titles)",
	args: {
		action: Args.string({
			description: "Action to perform",
			required: false,
			options: ["download", "list"],
		}),
		model: Args.string({
			description: "Model key, or all",
			required: false,
		}),
	},
	flags: {
		json: Flags.boolean({ description: "Output JSON" }),
	},
} satisfies CommandMetadata;

export const tokenHelp = {
	description: "Get the API key or OAuth token for a provider",
	args: {
		provider: Args.string({
			description: "Provider ID (e.g. anthropic, openai)",
			required: true,
		}),
	},
	flags: {
		raw: Flags.boolean({
			description: "Output the raw credential value without parsing nested JSON structures",
			default: false,
		}),
		"force-refresh": Flags.boolean({
			description: "Force refresh the OAuth token even if it has not expired",
			default: false,
		}),
		account: Flags.integer({
			char: "a",
			description: "Select the Nth OAuth account (1-based) in stored order instead of the round-robin default",
		}),
		list: Flags.boolean({
			char: "l",
			description: "List the provider's OAuth accounts (index + identity) and exit",
			default: false,
		}),
	},
	examples: [
		"# Get API key for Anthropic\n  proto token anthropic",
		"# Get raw Copilot credential JSON\n  proto token github-copilot --raw",
		"# Force refresh and get Gemini CLI token\n  proto token google-gemini-cli --force-refresh",
		"# List Anthropic OAuth accounts\n  proto token anthropic --list",
		"# Get the 2nd Anthropic OAuth account's token\n  proto token anthropic --account 2",
	],
} satisfies CommandMetadata;

export const ttsrHelp = {
	description: "Inspect and test Time-Traveling Stream Rules (TTSR)",
	args: {
		action: Args.string({
			description: "TTSR action",
			required: false,
			options: TTSR_ACTIONS,
		}),
		snippet: Args.string({
			description: "Inline snippet text to test (ttsr test) or directory to scan (ttsr scan)",
			required: false,
		}),
	},
	flags: {
		file: Flags.string({ description: "Snippet file path, or - for stdin (ttsr test)" }),
		rule: Flags.string({
			char: "r",
			description: "Rule markdown file to test in isolation (skips project rule loading)",
		}),
		source: Flags.string({
			description: "Match source: text, thinking, or tool (inferred from --file when omitted)",
			options: TTSR_SOURCES,
		}),
		tool: Flags.string({
			description: "Tool name when source is tool (e.g. edit, write); defaults to edit",
		}),
		path: Flags.string({
			char: "p",
			description: "Candidate file path for scope/glob matching and AST language inference",
		}),
		verbose: Flags.boolean({ char: "v", description: "Show every evaluated rule, not just triggered ones" }),
		llm: Flags.boolean({
			description: "Resolve llm: conditions with the tiny/smol model role (ttsr test); off by default",
		}),
		json: Flags.boolean({ description: "Output JSON" }),
		"no-gitignore": Flags.boolean({ description: "Include files excluded by .gitignore (ttsr scan)" }),
		"max-bytes": Flags.integer({
			description: "Maximum file size to scan in bytes; 0 disables the limit (ttsr scan)",
		}),
	},
	examples: [
		"proto ttsr list",
		"proto ttsr test 'const x: any = 1'",
		"proto ttsr test src/foo.ts",
		"proto ttsr test --file src/foo.ts",
		"proto ttsr test --file src/foo.ts --source text",
		"proto ttsr test --rule .proto/rules/no-any.md --source tool --path src/foo.ts 'const x: any = 1'",
		"echo 'Box::leak(&mut v)' | proto ttsr test --file - --path src/lib.rs",
		"proto ttsr test --source tool --tool edit --path src/foo.ts 'const x: any = 1'",
		"proto ttsr test --llm --path src/foo.ts 'const seen = new Set<string>()'",
		"proto ttsr scan",
		"proto ttsr scan src/",
		"proto ttsr scan -r .proto/rules/no-any.md src/",
	],
} satisfies CommandMetadata;

export const updateHelp = {
	description: "Check for and install updates",
	flags: {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
	},
	examples: [
		"proto update",
		"proto update --check",
		"# If GitHub rate-limits release metadata, set GITHUB_TOKEN or GH_TOKEN\n  GITHUB_TOKEN=... proto update",
	],
} satisfies CommandMetadata;

export const usageHelp = {
	description: "Show provider usage limits for every authenticated account",
	args: {
		action: Args.string({
			description: "Optional subcommand to execute",
			required: false,
			options: ["invalidate"],
		}),
	},
	flags: {
		json: Flags.boolean({ char: "j", description: "Output usage reports as JSON", default: false }),
		provider: Flags.string({ char: "p", description: "Only show usage for this provider id (e.g. anthropic)" }),
		redact: Flags.boolean({
			char: "r",
			description: "Redact account emails/ids (shortest unique prefix) for sharing screenshots",
			default: false,
		}),
		history: Flags.boolean({
			description: "Show recorded usage-limit history (hourly snapshots) instead of a live snapshot",
			default: false,
		}),
		days: Flags.integer({ char: "d", description: "History window in days (with --history)", default: 7 }),
	},
	examples: [
		"# Detailed per-account usage breakdown across all providers\n  proto usage",
		"# Only Anthropic accounts\n  proto usage --provider anthropic",
		"# Redact account identifiers for screenshots\n  proto usage --redact",
		"# Machine-readable output\n  proto usage --json",
		"# Usage-limit trend over the last 30 days\n  proto usage --history --days 30",
		"# Invalidate cached usage reports for all providers\n  proto usage invalidate",
		"# Invalidate cached usage reports for a specific provider\n  proto usage invalidate --provider anthropic",
	],
} satisfies CommandMetadata;

export const worktreeHelp = {
	description: "List or clear agent-managed git worktrees (~/.proto/wt)",
	args: {
		action: Args.string({
			description: "list (default) or clear",
			required: false,
			options: ["list", "clear"],
			default: "list",
		}),
	},
	flags: {
		all: Flags.boolean({
			description: "Clear every entry, including live PR-checkout worktrees (clear)",
			default: false,
		}),
		"dry-run": Flags.boolean({
			char: "n",
			description: "Print what would be removed without touching the filesystem (clear)",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
	},
	examples: [
		"proto worktree",
		"proto worktree list --json",
		"proto worktree clear",
		"proto worktree clear --dry-run",
		"proto worktree clear --all",
	],
} satisfies CommandMetadata;
