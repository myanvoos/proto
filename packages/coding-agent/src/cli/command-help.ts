import { Args, type CommandMetadata, Flags } from "@oh-my-pi/pi-utils/cli";
import { BINARY_NAME } from "@oh-my-pi/pi-utils/dirs";

export const acpHelp = {
	description: "Run Proto as an ACP (Agent Client Protocol) server over stdio",
} satisfies CommandMetadata;

export const agentsHelp = { description: "Manage bundled worker agents" } satisfies CommandMetadata;

export const authBrokerHelp = {
	description: "Manage the proto auth-broker (credential vault)",
} satisfies CommandMetadata;

export const authGatewayHelp = {
	description: "Run an auth-gateway forward proxy backed by the configured broker",
} satisfies CommandMetadata;

export const benchHelp = {
	description:
		"Benchmark models: TTFT/prefill vs decode throughput with p50/p95, across chat, prefill, generation, and prompt-cache workloads",
} satisfies CommandMetadata;

export const browserRelayHelp = {
	description: "Run the local CDP relay that lets the browser tool drive your own Chrome tabs",
} satisfies CommandMetadata;

export const commitHelp = { description: "Generate a commit message and update changelogs" } satisfies CommandMetadata;

export const completionsHelp = {
	description: "Print a shell completion script (bash, zsh, or fish)",
} satisfies CommandMetadata;

export const completeHelp = { hidden: true } satisfies CommandMetadata;

export const compressHelp = {
	description: "Rewrite a text file into the dense prompt register, reporting what it drops",
} satisfies CommandMetadata;

export const configHelp = { description: "Manage configuration settings" } satisfies CommandMetadata;

export const dryBalanceHelp = {
	description: "Dry-run OAuth account balancing across random session ids",
} satisfies CommandMetadata;

export const galleryHelp = {
	description: "Preview tool renderers across streaming, in-progress, success, and failure states",
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

export const grepHelp = { description: "Test grep tool" } satisfies CommandMetadata;

export const grievancesHelp = {
	description: "View, clean, or push reported tool issues (auto-QA grievances)",
} satisfies CommandMetadata;

export const imagesHelp = {
	description: "Inspect, diagnose, probe, and purge image publication backends",
} satisfies CommandMetadata;

export const installHelp = {
	description: "Install or link an extension package (alias of `plugin install`/`plugin link`)",
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

export const pluginHelp = { description: "Manage plugins (install, uninstall, list, etc.)" } satisfies CommandMetadata;

export const psHelp = {
	description: "List and control daemon-supervised background processes (logs, stop, kill, restart)",
} satisfies CommandMetadata;

export const readHelp = {
	description: "Show what the read tool will return for a path, URL, or internal URI",
} satisfies CommandMetadata;
export const renderHelp = {
	description: "Draw a session's entire thread through the production transcript pipeline (with repaint timing)",
} satisfies CommandMetadata;

export const searchHelp = { description: "Test web search providers" } satisfies CommandMetadata;

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

export const shellHelp = { description: "Interactive shell console" } satisfies CommandMetadata;

export const sshHelp = { description: "Manage SSH host configurations" } satisfies CommandMetadata;

export const tinyModelsHelp = {
	description: "Download tiny local models (session titles)",
} satisfies CommandMetadata;

export const tokenHelp = { description: "Get the API key or OAuth token for a provider" } satisfies CommandMetadata;

export const ttsrHelp = {
	description: "Inspect and test Time-Traveling Stream Rules (TTSR)",
} satisfies CommandMetadata;

export const updateHelp = { description: "Check for and install updates" } satisfies CommandMetadata;

export const usageHelp = {
	description: "Show provider usage limits for every authenticated account",
} satisfies CommandMetadata;

export const worktreeHelp = {
	description: "List or clear agent-managed git worktrees (~/.proto/wt)",
} satisfies CommandMetadata;
