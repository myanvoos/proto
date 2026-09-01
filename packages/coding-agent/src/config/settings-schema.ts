import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import {
	type BlobDestinationId,
	type BlobDestinationMetadata,
	BUILTIN_BLOB_DESTINATIONS,
} from "../blob-broker/destinations";
import {
	COMPACTION_METHOD_CHOICES,
	type CompactionMethod,
	DEFAULT_COMPACTION_METHOD_ORDER,
} from "../session/compaction-methods";
import { getThinkingLevelMetadata } from "../thinking";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "../tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "../tiny/dtype";
import {
	ONLINE_MEMORY_MODEL_KEY,
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_MEMORY_MODEL_OPTIONS,
	TINY_MEMORY_MODEL_VALUES,
	TINY_TITLE_MODEL_OPTIONS,
	TINY_TITLE_MODEL_VALUES,
} from "../tiny/models";
import { IMAGE_PROVIDER_CHOICES, type ImageProvider } from "../tools/image-providers";
import { EDIT_MODES } from "../utils/edit-mode";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	MAX_WEB_SEARCH_TIMEOUT_SECONDS,
	SEARCH_PROVIDER_CHOICES,
	type SearchProviderId,
} from "../web/search/types";
import {
	SERVICE_TIER_ANTHROPIC_OPTIONS,
	SERVICE_TIER_ANTHROPIC_VALUES,
	SERVICE_TIER_GOOGLE_OPTIONS,
	SERVICE_TIER_GOOGLE_VALUES,
	SERVICE_TIER_INHERIT_OPTIONS,
	SERVICE_TIER_INHERIT_SETTING_VALUES,
	SERVICE_TIER_OPENAI_OPTIONS,
	SERVICE_TIER_OPENAI_VALUES,
} from "./service-tier";

const BUILTIN_BLOB_DESTINATION_METADATA: readonly BlobDestinationMetadata<BlobDestinationId>[] =
	Object.values(BUILTIN_BLOB_DESTINATIONS);

const BLOB_BACKEND_CHOICES = BUILTIN_BLOB_DESTINATION_METADATA.filter(
	destination =>
		destination.id === "provider-files" ||
		(destination.directImage && destination.status !== "incompatible" && destination.status !== "defunct"),
).map(destination => ({
	value: destination.id,
	label: destination.label,
	description: destination.reason ?? destination.family,
}));

export type SettingTab =
	| "appearance"
	| "model"
	| "interaction"
	| "context"
	| "files"
	| "shell"
	| "tools"
	| "tasks"
	| "providers";

export const SETTING_TABS: SettingTab[] = [
	"appearance",
	"model",
	"interaction",
	"context",
	"files",
	"shell",
	"tools",
	"tasks",
	"providers",
];

export const TAB_METADATA: Record<SettingTab, { label: string; icon: `tab.${string}` }> = {
	appearance: { label: "Appearance", icon: "tab.appearance" },
	model: { label: "Model", icon: "tab.model" },
	interaction: { label: "Interaction", icon: "tab.interaction" },
	context: { label: "Context", icon: "tab.context" },
	files: { label: "Files", icon: "tab.files" },
	shell: { label: "Shell", icon: "tab.shell" },
	tools: { label: "Tools", icon: "tab.tools" },
	tasks: { label: "Workers", icon: "tab.tasks" },
	providers: { label: "Providers", icon: "tab.providers" },
};

export const TAB_GROUPS: Record<SettingTab, readonly string[]> = {
	appearance: ["Theme", "Composer", "Status Line", "Display", "Images"],
	model: ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Advisor", "Prewalk", "Vision"],
	interaction: [
		"Input",
		"Approvals",
		"Notifications",
		"Speech",
		"Magic Keywords",
		"Startup & Updates",
		"Power (macOS)",
		"Agent",
		"Git",
	],
	context: ["General", "Compaction", "Rules (TTSR)", "Auto-Learn", "Experimental"],
	files: ["Editing", "Reading", "Read Summaries"],
	shell: ["Bash", "Eval & Runtimes"],
	tools: [
		"Available Tools",
		"Todos",
		"Grep & Browser",
		"Computer",
		"GitHub",
		"Output Limits",
		"Execution",
		"Discovery & MCP",
		"Extensions",
		"Developer",
	],
	tasks: ["Modes", "Workers", "Isolation", "Commands & Skills"],
	providers: ["Services", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
};

export type StatusLineSegmentId =
	| "pi"
	| "model"
	| "account"
	| "mode"
	| "path"
	| "git"
	| "pr"
	| "subagents"
	| "token_in"
	| "token_out"
	| "token_total"
	| "token_rate"
	| "cost"
	| "context_pct"
	| "context_total"
	| "time_spent"
	| "time"
	| "session"
	| "hostname"
	| "cache_read"
	| "cache_write"
	| "cache_hit"
	| "session_name"
	| "usage";

export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
};

interface UiBase {
	tab: SettingTab;

	group?: string;
	label: string;
	description: string;

	warning?: string;

	condition?: string;
}

interface UiBoolean extends UiBase {}

interface UiEnum<T extends readonly string[]> extends UiBase {
	options?: ReadonlyArray<SubmenuOption<T[number]>>;
}

interface UiNumber extends UiBase {
	options?: ReadonlyArray<SubmenuOption>;
}

interface UiString extends UiBase {
	secret?: boolean;

	options?: ReadonlyArray<SubmenuOption> | "runtime";
}

interface UiArray extends UiBase {
	options?: ReadonlyArray<SubmenuOption>;

	ordered?: boolean;
}

export type AnyUiMetadata = UiBase & {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
	secret?: boolean;
	ordered?: boolean;
};

interface CredentialMarker {
	credential?: true;
}

interface BooleanDef extends CredentialMarker {
	type: "boolean";
	default: boolean | undefined;
	ui?: UiBoolean;
}

interface StringDef extends CredentialMarker {
	type: "string";
	default: string | undefined;
	ui?: UiString;
}

interface NumberDef extends CredentialMarker {
	type: "number";
	default: number | undefined;
	ui?: UiNumber;
}

interface EnumDef<T extends readonly string[]> extends CredentialMarker {
	type: "enum";
	values: T;
	default: T[number];
	ui?: UiEnum<T>;
}

interface ArrayDef<T> extends CredentialMarker {
	type: "array";
	default: T[];
	ui?: UiArray;
}

interface RecordDef<T> extends CredentialMarker {
	type: "record";
	default: Record<string, T>;
	ui?: UiBase;
}

type SettingDef =
	| BooleanDef
	| StringDef
	| NumberDef
	| EnumDef<readonly string[]>
	| ArrayDef<unknown>
	| RecordDef<unknown>;

interface ModelTagDef {
	name: string;
	color?: string;

	hidden?: boolean;
}

interface ModelTagsSettings {
	[key: string]: ModelTagDef;
}

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_STRING_RECORD: Record<string, string> = {};
const EMPTY_NUMBER_RECORD: Record<string, number> = {};
const DEFAULT_CYCLE_ORDER: string[] = ["smol", "default", "slow"];
const DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS: string[] = ["fleet"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		pattern:
			"^\\s*(echo|printf|cat\\s*<<)\\s+(?:(?:[^\"'>]|\"[^\"]*\"|'[^']*')|(?<!\\|)>{1,2}\\|?\\s*(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))*(?<!\\|)>{1,2}\\|?\\s*(?!(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))[$\\w./~\"'-]",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
	{
		pattern: "^\\s*nohup\\s+|(?<!&)\\&\\s*$",
		tool: "fleet",
		message:
			'Use the `fleet` tool (`op:"start"`) instead of nohup or background shell syntax so the process stays observable and managed.',
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:dev|start)(?:\\s|$)|(?:vite|next\\s+dev|nuxt\\s+dev|nodemon|lldb|gdb|tail\\s+-f)(?:\\s|$)|docker\\s+compose\\s+up(?!.*(?:\\s-d(?:\\s|$)|--detach))(?:\\s|$))",
		tool: "fleet",
		message:
			'Use the `fleet` tool (`op:"start"`) for services, watchers, and debuggers so other proto instances can observe and control them.',
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?\\S+|cargo\\s+watch|watchexec|pytest|vitest|jest|tsc)(?:.|\\n)*(?:--watch|-w)(?:\\s|$)",
		tool: "fleet",
		message: 'Use the `fleet` tool (`op:"start"`) for watch mode so its output, input, and lifecycle stay managed.',
	},
];

const DEFAULT_AGENT_MODEL_OVERRIDES: Record<string, string | string[]> = {};

export const SETTINGS_SCHEMA = {
	setupVersion: { type: "number", default: 0 },

	"auth.broker.url": { type: "string", default: undefined },
	"auth.broker.token": { type: "string", default: undefined, credential: true },

	autoResume: {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Auto Resume",
			description: "Automatically resume the most recent session in the current directory",
		},
	},
	"session.detachedMainSessions": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Agent",
			label: "Keep Thinking In Background",
			description:
				"When switching sessions while the agent is still thinking, keep the previous session running in the background instead of interrupting it. Re-entering that session re-attaches to the live turn.",
		},
	},

	"power.sleepPrevention": {
		type: "enum",
		values: ["off", "idle", "display", "system"] as const,
		default: "idle",
		ui: {
			tab: "interaction",
			group: "Power (macOS)",
			label: "Sleep Prevention",
			description:
				"Prevent macOS sleep during active sessions. Each level is cumulative — it adds the flags of all lower levels.",
			options: [
				{
					value: "off",
					label: "Off",
					description: "Do not prevent any sleep",
				},
				{
					value: "idle",
					label: "Prevent Idle Sleep",
					description: "Keep the system awake while a session is open (caffeinate -i)",
				},
				{
					value: "display",
					label: "Prevent Display Sleep",
					description: "Also keep the display from idle-sleeping (caffeinate -i -d)",
				},
				{
					value: "system",
					label: "Prevent System Sleep",
					description: "Also block all system sleep on AC and declare the user active (caffeinate -i -d -s -u)",
				},
			],
		},
	},
	"advisor.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Enable Advisor",
			description:
				"Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.",
		},
	},
	"prewalk.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Prewalk",
			label: "Enable Prewalk",
			description:
				"Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk.",
		},
	},
	"advisor.syncBacklog": {
		type: "enum",
		values: ["off", "1", "3", "5"] as const,
		default: "off",
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Advisor Sync Backlog",
			description:
				"Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.",
			condition: "advisorEnabled",
		},
	},
	"advisor.immuneTurns": {
		type: "number",
		default: 3,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Advisor Immune Turns",
			description:
				"After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns.",
			options: [
				{ value: "0", label: "0 turns", description: "Allow every concern/blocker to interrupt." },
				{ value: "1", label: "1 turn" },
				{ value: "2", label: "2 turns" },
				{ value: "3", label: "3 turns", description: "Default." },
				{ value: "4", label: "4 turns" },
				{ value: "5", label: "5 turns" },
			],
			condition: "advisorEnabled",
		},
	},
	shellPath: { type: "string", default: undefined },
	"git.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Git",
			label: "Enable Git Integration",
			description: "Show git branch, status, and PR information in the TUI and watch repository metadata.",
		},
	},

	extensions: { type: "array", default: EMPTY_STRING_ARRAY },

	enabledModels: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledProviders: { type: "array", default: EMPTY_STRING_ARRAY },

	"providers.maxInFlightRequests": {
		type: "record",
		default: EMPTY_NUMBER_RECORD,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Max In-Flight Requests",
			description:
				'Maximum concurrent LLM requests per provider id (for example "openai" or "anthropic"), shared across local PROTO processes with this config root. Omitted providers are unlimited.',
		},
	},

	"providers.openai-codex.codeMode": {
		type: "enum",
		values: ["off", "on", "auto"] as const,
		default: "off",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Code Mode",
			description:
				"Route Codex code_mode_only models (GPT-5.6) through the eval tool as a programmatic execution surface: the direct tool surface collapses to eval/ask/todo and every other session tool is invoked from eval cells. Mirrors codex-rs Code Mode. 'auto' follows the model catalog flag.",
		},
	},

	"providers.openai-codex.codeModeDirectTools": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Code Mode Direct Tools",
			description:
				"Extra tool names to keep directly callable alongside eval/ask/todo when Codex Code Mode is active.",
		},
	},

	disabledExtensions: { type: "array", default: EMPTY_STRING_ARRAY },

	modelRoleStorage: {
		type: "enum",
		values: ["global", "project"] as const,
		default: "global",
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Model Role Storage",
			description: "Where model selector role assignments are saved",
			options: [
				{
					value: "global",
					label: "Global",
					description: "Save role models in the active profile config (current behavior)",
				},
				{
					value: "project",
					label: "Per-project",
					description: "Save project role models in .proto/config.yml; missing project roles use global defaults",
				},
			],
		},
	},

	modelRoles: { type: "record", default: EMPTY_STRING_RECORD },

	modelTags: { type: "record", default: EMPTY_MODEL_TAGS_RECORD },

	modelProviderOrder: { type: "array", default: EMPTY_STRING_ARRAY },

	cycleOrder: { type: "array", default: DEFAULT_CYCLE_ORDER },

	"theme.dark": {
		type: "string",
		default: "dark",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Dark Theme",
			description: "Theme used when the terminal has a dark background",
			options: "runtime",
		},
	},

	"theme.light": {
		type: "string",
		default: "light",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Light Theme",
			description: "Theme used when the terminal has a light background",
			options: "runtime",
		},
	},

	colorBlindMode: {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Color-Blind Mode",
			description: "Use blue instead of green for diff additions",
		},
	},
	"statusLine.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Composer Footline",
			description: "The quiet metadata row under the composer (model, mode, path, git, the context gauge).",
		},
	},

	"statusLine.showAccount": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Show Serving Account",
			description: "Name which stored account is serving the active provider (multi-account providers only)",
		},
	},
	"statusLine.separator": {
		type: "enum",
		values: ["powerline", "powerline-thin", "slash", "pipe", "block", "none", "ascii"] as const,
		default: "powerline-thin",
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Status Line Separator",
			description: "Style of separators between segments",
			options: [
				{ value: "powerline", label: "Powerline", description: "Solid arrows (Nerd Font)" },
				{ value: "powerline-thin", label: "Thin chevron", description: "Thin arrows (Nerd Font)" },
				{ value: "slash", label: "Slash", description: "Forward slashes" },
				{ value: "pipe", label: "Pipe", description: "Vertical pipes" },
				{ value: "block", label: "Block", description: "Solid blocks" },
				{ value: "none", label: "None", description: "Space only" },
				{ value: "ascii", label: "ASCII", description: "Greater-than signs" },
			],
		},
	},

	"statusLine.transparent": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Transparent Status Line",
			description:
				"Use the terminal's default background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal.",
		},
	},
	"statusLine.compactThinkingLevel": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Compact Thinking Level",
			description:
				"Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix.",
		},
	},
	"tools.artifactSpillThreshold": {
		type: "number",
		default: 50,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Spill Threshold (KB)",
			description: "Tool output above this size is saved as an artifact; tail is kept inline",
			options: [
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "~5K tokens" },
				{ value: "30", label: "30 KB", description: "~7.5K tokens" },
				{ value: "50", label: "50 KB", description: "Default; ~12.5K tokens" },
				{ value: "75", label: "75 KB", description: "~19K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
				{ value: "500", label: "500 KB", description: "~125K tokens" },
				{ value: "1000", label: "1 MB", description: "~250K tokens" },
			],
		},
	},
	"tools.artifactTailBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Tail Size (KB)",
			description: "Amount of tail content kept inline when output spills to artifact",
			options: [
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
			],
		},
	},
	"tools.artifactHeadBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Head Size (KB)",
			description:
				"Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only.",
			options: [
				{ value: "0", label: "0 KB", description: "Disabled; tail-only truncation" },
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
			],
		},
	},
	"tools.outputMaxColumns": {
		type: "number",
		default: 768,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Output Column Cap",
			description:
				"Per-line byte cap for streaming tool outputs (bash, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables.",
			options: [
				{ value: "0", label: "Off", description: "No per-line cap" },
				{ value: "256", label: "256", description: "Tight" },
				{ value: "512", label: "512" },
				{ value: "768", label: "768", description: "Default" },
				{ value: "1024", label: "1024" },
				{ value: "2048", label: "2048" },
				{ value: "4096", label: "4096", description: "Loose" },
			],
		},
	},
	"tools.artifactTailLines": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Tail Lines",
			description: "Maximum lines of tail content kept inline when output spills to artifact",
			options: [
				{ value: "50", label: "50 lines", description: "~250 tokens" },
				{ value: "100", label: "100 lines", description: "~500 tokens" },
				{ value: "250", label: "250 lines", description: "~1.25K tokens" },
				{ value: "500", label: "500 lines", description: "Default; ~2.5K tokens" },
				{ value: "1000", label: "1000 lines", description: "~5K tokens" },
				{ value: "2000", label: "2000 lines", description: "~10K tokens" },
				{ value: "5000", label: "5000 lines", description: "~25K tokens" },
			],
		},
	},

	"statusLine.showHookStatus": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Show Hook Status",
			description: "Display hook status messages below the status line",
		},
	},

	"statusLine.leftSegments": {
		type: "array",
		default: ["model", "account", "mode", "path", "git", "context_pct"] as StatusLineSegmentId[],
	},

	"statusLine.rightSegments": { type: "array", default: ["session_name"] as StatusLineSegmentId[] },

	"statusLine.segmentOptions": { type: "record", default: {} as Record<string, unknown> },

	"terminal.showImages": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Images",
			label: "Show Inline Images",
			description: "Render images inline in the terminal",
			condition: "hasImageProtocol",
		},
	},

	"images.autoResize": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Images",
			label: "Auto-Resize Images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
		},
	},

	"images.blockImages": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Images",
			label: "Block Images",
			description: "Prevent images from being sent to LLM providers",
		},
	},

	"images.describeForTextModels": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Vision",
			label: "Describe Images for Text Models",
			description:
				"When an image is attached to a model without vision support, save it under local:// and inject a description from a vision-capable model instead of dropping it",
		},
	},

	"images.urls.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Vision",
			label: "Serve Images as URLs",
			description:
				"Publish outgoing images through the configured backend chain and send URL-fetching providers short URLs instead of inline base64. Falls back to inline automatically when every backend or a provider fetch fails",
		},
	},

	"images.urls.backends": {
		type: "array",
		default: ["provider-files", "tailscale", "cloudflared", "litterbox"] as BlobDestinationId[],
		ui: {
			tab: "model",
			group: "Vision",
			label: "Image URL Backends",
			description: "Ordered destinations tried when publishing images for provider access",
			options: BLOB_BACKEND_CHOICES,
			ordered: true,
		},
	},

	"images.urls.options": {
		type: "record",
		default: {} as Partial<Record<BlobDestinationId, Record<string, unknown>>>,
	},

	"images.urls.credentials": {
		type: "record",
		default: {} as Partial<Record<BlobDestinationId, Record<string, string>>>,
		credential: true,
	},

	"images.urls.command": {
		type: "string",
		default: undefined,
		ui: {
			tab: "model",
			group: "Vision",
			label: "Image Upload Command",
			description:
				"Argv template for the command backend; {file} is the image path, {mime}/{ext} optional. The last URL printed on stdout is used (e.g. pasta -b -f {file})",
		},
	},

	"images.urls.publicBaseUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "model",
			group: "Vision",
			label: "Image URL Public Base",
			description: "Externally reachable base URL fronting the blob server (required for ssh, optional for direct)",
		},
	},

	"images.urls.ttlHours": {
		type: "number",
		default: 72,
		ui: {
			tab: "model",
			group: "Vision",
			label: "Image URL Lifetime (hours)",
			description:
				"Serving window for locally hosted image URLs, measured from the last time a conversation sent them; resuming a conversation re-arms the window at the same link. 0 keeps links alive while the broker runs",
		},
	},

	"images.urls.bindHost": {
		type: "string",
		default: "127.0.0.1",
		ui: {
			tab: "model",
			group: "Vision",
			label: "Image URL Bind Host",
			description: "Host the blob server binds to; loopback for tunnels, 0.0.0.0 for direct serving",
		},
	},

	"images.urls.sshTarget": {
		type: "string",
		default: undefined,
		ui: {
			tab: "model",
			group: "Vision",
			label: "Image URL SSH Target",
			description: "user@host destination for the ssh reverse forward",
		},
	},

	"images.urls.sshRemotePort": {
		type: "number",
		default: 8787,
		ui: {
			tab: "model",
			group: "Vision",
			label: "Image URL SSH Remote Port",
			description: "Remote listen port of the ssh reverse forward that your web server proxies to",
		},
	},

	"tui.maxInlineImageColumns": {
		type: "number",
		default: 100,
		description:
			"Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width).",
	},

	"tui.maxInlineImageRows": {
		type: "number",
		default: 20,
		description:
			"Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height).",
	},

	"tui.maxInlineImages": {
		type: "number",
		default: 8,
		description:
			"Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit).",
	},

	"terminal.showProgress": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Native Terminal Progress",
			description: "Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running",
		},
	},

	"tui.textSizing": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Large Headings (Kitty)",
			description:
				"Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default.",
		},
	},

	"tui.renderMermaid": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Render Mermaid Diagrams",
			description: "Render Mermaid fenced code blocks as ASCII diagrams",
		},
	},

	"tui.titleState": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Terminal Title Run State",
			description:
				"Show the agent run state in the terminal title's separator — an animated spinner while working, '>' when it's your turn, '!' when the agent is waiting on you",
		},
	},

	"tui.hyperlinks": {
		type: "enum",
		values: ["off", "auto", "always"] as const,
		default: "auto",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Terminal Hyperlinks",
			description:
				"Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)",
		},
	},
	"tui.tight": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Tight Layout",
			description: "Remove the 1-character horizontal padding from the left and right of the terminal output",
		},
	},
	"tui.scrollbackRebuild": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Rewrite Scrollback",
			description:
				"Erase and replay terminal scrollback when a block's final form replaces its live preview. When off (default), stale preview copies remain in history and the final content is appended below.",
		},
	},
	"tui.resizeScrollback": {
		type: "enum",
		values: ["append", "rebuild", "preserve"] as const,
		default: "append",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Resize Scrollback",
			description:
				"How a settled width resize refreshes terminal scrollback when the pane repaints in place (tmux/screen/zellij, or in-place direct terminals). The host rewraps old output naively on resize; these modes decide whether the transcript is re-emitted at the new width.",
			options: [
				{
					value: "append",
					label: "Append",
					description: "Replay the transcript at the new width below the old history (one fresh copy per resize)",
				},
				{
					value: "rebuild",
					label: "Rebuild",
					description:
						"DESTRUCTIVE: erases the pane's ENTIRE scrollback (including pre-session shell output) and replays the transcript, leaving exactly one current-width copy. Needs a host that honors ED3: tmux does; when nested, the innermost honoring host clears; hosts that ignore it (GNU screen) behave like Append",
				},
				{
					value: "preserve",
					label: "Preserve",
					description: "Repaint the viewport only; history keeps its old-width wrap (zero growth)",
				},
			],
		},
	},

	"display.shimmer": {
		type: "enum",
		values: ["classic", "kitt", "disabled"] as const,
		default: "classic",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Shimmer",
			description: "Animation style for working/loading messages",
			options: [
				{ value: "classic", label: "Classic", description: "Soft cosine wave sweeping across the text" },
				{ value: "kitt", label: "KITT Scanner", description: "Knight Rider 1982 red light bouncing left-right" },
				{ value: "disabled", label: "Disabled", description: "No animation; static muted text" },
			],
		},
	},

	"display.smoothStreaming": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Smooth Streaming",
			description: "Reveal assistant text and streamed tool input smoothly while chunks arrive",
		},
	},

	"display.hideToolActivity": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Hide Tool Activity",
			description: "Hide model-initiated tool calls and results from the transcript",
		},
	},

	"display.showTokenUsage": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Show Token Usage",
			description: "Show per-turn token usage on assistant messages",
		},
	},

	"display.cacheMissMarker": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Cache Miss Marker",
			description: "Show a divider above an assistant turn whose request lost (missed) the prompt cache",
		},
	},

	"display.collapseCompacted": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Collapse Compacted History",
			description:
				"Collapse pre-compaction history behind the summary divider on the live transcript; disable to keep the full transcript inline with dividers at each compaction point",
		},
	},

	showHardwareCursor: {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Show Hardware Cursor",
			description: "Show terminal cursor for IME support",
		},
	},

	"tui.imeSafeCursor": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "IME-Safe Prompt Layout",
			description: "Move the prompt's bottom border to a separate row so macOS IME preedit cannot displace it",
		},
	},

	defaultThinkingLevel: {
		type: "enum",
		values: [...THINKING_EFFORTS],
		default: "high",
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Thinking Level",
			description: "Reasoning depth for thinking-capable models",
			options: [...THINKING_EFFORTS.map(getThinkingLevelMetadata)],
		},
	},

	hideThinkingBlock: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Hide Thinking Blocks",
			description: "Hide thinking blocks in assistant responses",
		},
	},
	proseOnlyThinking: {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Prose Only Thinking",
			description: "Omit code blocks from thinking summaries and replace them with an ellipsis",
		},
	},

	omitThinking: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Omit Thinking summaries",
			description:
				"Instruct upstream providers to completely omit thinking summaries from responses (where supported)",
		},
	},

	externalThinking: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "External Thinking",
			description: "Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning",
			warning:
				"At your own risk: providers have flagged this request shape as abuse, up to account-level enforcement",
		},
	},

	"model.loopGuard.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Loop Guard",
			description: "Enable automatic stream loop detection for model reasoning and prose",
		},
	},

	"model.loopGuard.checkAssistantContent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Loop Guard Scan Prose",
			description: "Apply loop guard to assistant prose messages in addition to thinking logs",
		},
	},

	"model.loopGuard.toolCallReminder": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Loop Guard Tool-Call Reminder",
			description:
				"When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard)",
		},
	},

	"model.toolCallLoopGuard.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Tool-Call Loop Guard",
			description: "Detect consecutive identical tool calls across turns and inject a corrective steer",
		},
	},

	"model.toolCallLoopGuard.threshold": {
		type: "number",
		default: 5,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Tool-Call Loop Threshold",
			description: "Consecutive identical tool calls required before the corrective steer is injected",
		},
	},

	"model.toolCallLoopGuard.exemptTools": {
		type: "array",
		default: DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Tool-Call Loop Exempt Tools",
			description: "Tool names that may repeat consecutively without triggering the cross-turn loop guard",
		},
	},

	inlineToolDescriptors: {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Inline Tool Descriptors",
			description:
				"Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Inline descriptors for Gemini models; keep them in tool schemas otherwise",
				},
				{ value: "on", label: "On", description: "Always inline descriptors in the system prompt" },
				{ value: "off", label: "Off", description: "Keep descriptors in provider tool schemas only" },
			],
		},
	},

	includeModelInPrompt: {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Include Model in Prompt",
			description: "Surface the active model identifier in the system prompt so the agent knows which model it is",
		},
	},

	includeWorkspaceTree: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Include Workspace Tree",
			description:
				"Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified.",
		},
	},

	"workspace.additionalDirectories": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "context",
			group: "General",
			label: "Additional Workspace Dirs",
			description:
				"Extra workspace directories added to every session as additional roots (multi-root workspace). Managed live via /add-dir and /remove-dir. Paths resolve relative to cwd; absolute paths recommended. The agent is told these roots exist and can read/grep/glob them.",
		},
	},

	personality: {
		type: "enum",
		values: ["default", "friendly", "pragmatic", "none"] as const,
		default: "default",
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Personality",
			description: "Communication style rendered into the system prompt's personality block",
			options: [
				{
					value: "default",
					label: "Default",
					description: "Terse, evidence-first engineer; dense, action-oriented replies",
				},
				{
					value: "friendly",
					label: "Friendly",
					description: "Warm, encouraging collaborator focused on momentum and morale",
				},
				{
					value: "pragmatic",
					label: "Pragmatic",
					description: "Direct, efficient engineer focused on clarity and rigor",
				},
				{ value: "none", label: "None", description: "Omit the personality block entirely" },
			],
		},
	},

	temperature: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Temperature",
			description: "Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0", label: "0", description: "Deterministic" },
				{ value: "0.2", label: "0.2", description: "Focused" },
				{ value: "0.5", label: "0.5", description: "Balanced" },
				{ value: "0.7", label: "0.7", description: "Creative" },
				{ value: "1", label: "1", description: "Maximum variety" },
			],
		},
	},

	topP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Top P",
			description: "Nucleus sampling cutoff (0-1, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.1", label: "0.1", description: "Very focused" },
				{ value: "0.3", label: "0.3", description: "Focused" },
				{ value: "0.5", label: "0.5", description: "Balanced" },
				{ value: "0.9", label: "0.9", description: "Broad" },
				{ value: "1", label: "1", description: "No nucleus filtering" },
			],
		},
	},

	topK: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Top K",
			description: "Sample from top-K tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "1", label: "1", description: "Greedy top token" },
				{ value: "20", label: "20", description: "Focused" },
				{ value: "40", label: "40", description: "Balanced" },
				{ value: "100", label: "100", description: "Broad" },
			],
		},
	},

	minP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Min P",
			description: "Minimum probability threshold (0-1, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.01", label: "0.01", description: "Very permissive" },
				{ value: "0.05", label: "0.05", description: "Balanced" },
				{ value: "0.1", label: "0.1", description: "Strict" },
			],
		},
	},

	presencePenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Presence Penalty",
			description: "Penalty for introducing already-present tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0", label: "0", description: "No penalty" },
				{ value: "0.5", label: "0.5", description: "Mild novelty" },
				{ value: "1", label: "1", description: "Encourage novelty" },
				{ value: "2", label: "2", description: "Strong novelty" },
			],
		},
	},

	repetitionPenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Repetition Penalty",
			description: "Penalty for repeated tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.8", label: "0.8", description: "Allow repetition" },
				{ value: "1", label: "1", description: "No penalty" },
				{ value: "1.1", label: "1.1", description: "Mild penalty" },
				{ value: "1.2", label: "1.2", description: "Balanced" },
				{ value: "1.5", label: "1.5", description: "Strong penalty" },
			],
		},
	},

	textVerbosity: {
		type: "enum",
		values: ["low", "medium", "high"] as const,
		default: "medium",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Text Verbosity",
			description: "OpenAI Responses and Codex response verbosity (low, medium, or high)",
			options: [
				{ value: "low", label: "Low", description: "Prefer concise responses" },
				{ value: "medium", label: "Medium", description: "Balance brevity and detail (default)" },
				{ value: "high", label: "High", description: "Prefer detailed responses" },
			],
		},
	},

	"tier.openai": {
		type: "enum",
		values: SERVICE_TIER_OPENAI_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier — OpenAI",
			description:
				"Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`.",
			options: SERVICE_TIER_OPENAI_OPTIONS,
		},
	},

	"tier.anthropic": {
		type: "enum",
		values: SERVICE_TIER_ANTHROPIC_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier — Anthropic",
			description:
				'Processing tier for Claude requests. `priority` realizes fast mode (`speed: "fast"`) on supported direct Anthropic models; ignored on Bedrock/Vertex Claude and via OpenRouter.',
			options: SERVICE_TIER_ANTHROPIC_OPTIONS,
		},
	},

	"tier.google": {
		type: "enum",
		values: SERVICE_TIER_GOOGLE_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier — Google",
			description:
				"Processing tier for Gemini (Google AI Studio + Vertex) requests, and Google-family models routed via OpenRouter (none = omit). Sent as the top-level `serviceTier` field.",
			options: SERVICE_TIER_GOOGLE_OPTIONS,
		},
	},

	"tier.subagent": {
		type: "enum",
		values: SERVICE_TIER_INHERIT_SETTING_VALUES,
		default: "inherit",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier — Subagent",
			description:
				"Service Tier for spawned worker/eval subagents. Inherit = match the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to.",
			options: SERVICE_TIER_INHERIT_OPTIONS,
		},
	},

	"tier.advisor": {
		type: "enum",
		values: SERVICE_TIER_INHERIT_SETTING_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier — Advisor",
			description:
				"Service Tier for the advisor model. None = standard processing; Inherit = match the main agent's live per-family tiers; pick a value to apply it to the advisor model's family.",
			options: SERVICE_TIER_INHERIT_OPTIONS,
			condition: "advisorEnabled",
		},
	},

	"retry.enabled": { type: "boolean", default: true },

	"retry.maxRetries": {
		type: "number",
		default: 10,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Attempts",
			description: "Maximum retry attempts on API errors",
			options: [
				{ value: "1", label: "1 retry" },
				{ value: "2", label: "2 retries" },
				{ value: "3", label: "3 retries" },
				{ value: "5", label: "5 retries" },
				{ value: "10", label: "10 retries" },
			],
		},
	},

	"retry.baseDelayMs": { type: "number", default: 500 },
	"retry.maxDelayMs": {
		type: "number",
		default: 5 * 60 * 1000,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Max Retry Delay",
			description:
				"Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows).",
		},
	},
	"retry.modelFallback": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Model Fallback",
			description: "Allow retry recovery to switch to configured fallback models",
		},
	},
	"retry.usageAwareFallback": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Usage-Aware Fallback",
			description:
				"Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded.",
		},
	},
	"retry.usageReservePct": {
		type: "number",
		default: 10,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Reserve Margin",
			description:
				"Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model.",
			condition: "usageAwareFallbackEnabled",
			options: [
				{ value: "5", label: "5%", description: "Act only when nearly exhausted" },
				{ value: "10", label: "10%", description: "Balanced safety margin" },
				{ value: "15", label: "15%", description: "Conservative" },
				{ value: "20", label: "20%", description: "Early protection" },
				{ value: "25", label: "25%", description: "Very conservative" },
			],
		},
	},
	"retry.usageReservePolicy": {
		type: "enum",
		values: ["confirm", "auto", "fail-closed"] as const,
		default: "confirm",
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Reserve Policy",
			description: "What to do when every same-provider coding-plan account is inside the reserve margin.",
			condition: "usageAwareFallbackEnabled",
			options: [
				{
					value: "confirm",
					label: "Confirm interactively",
					description: "Keep interactive sessions on the primary until confirmed; background agents auto-fallback",
				},
				{
					value: "auto",
					label: "Auto-fallback",
					description: "Always select the next eligible configured fallback",
				},
				{
					value: "fail-closed",
					label: "Fail closed",
					description: "Do not spend reserve quota or select a fallback",
				},
			],
		},
	},
	"retry.fallbackChains": {
		type: "record",
		default: {} as Record<string, string[]>,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Fallback Chains",
			description:
				'JSON object mapping model roles, model selectors ("provider/model-id"), or provider wildcards ("provider/*") to ordered fallback selectors, e.g. {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}. Model-oriented keys apply whenever that model/provider is active, regardless of role; a "provider/*" entry keeps the failing model\'s id and swaps the provider. An id-prefixed wildcard ("openrouter/google/*") re-prefixes the failing model\'s bare id (google-antigravity/gemini-x -> openrouter/google/gemini-x) and, used as a key, matches only that provider\'s ids under the prefix.',
		},
	},
	"retry.fallbackRevertPolicy": {
		type: "enum",
		values: ["cooldown-expiry", "never"] as const,
		default: "cooldown-expiry",
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Fallback Revert Policy",
			description: "When to return to the primary model after a fallback",
			options: [
				{
					value: "cooldown-expiry",
					label: "Cooldown expiry",
					description: "Return to the primary model after its suppression window ends",
				},
				{ value: "never", label: "Never", description: "Stay on the fallback model until manually changed" },
			],
		},
	},

	"providers.anthropic.serverSideFallback": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Anthropic Server-Side Fallback (Fable 5)",
			description:
				"When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 4.8 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request.",
		},
	},

	steeringMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Steering Mode",
			description: "How to process queued messages while agent is working",
		},
	},

	followUpMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Follow-Up Mode",
			description: "How to drain follow-up messages after a turn completes",
		},
	},

	interruptMode: {
		type: "enum",
		values: ["immediate", "wait"] as const,
		default: "immediate",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Interrupt Mode",
			description: "When steering messages interrupt tool execution",
		},
	},

	"loop.mode": {
		type: "enum",
		values: ["prompt", "compact", "reset"] as const,
		default: "prompt",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Loop Mode",
			description: "What happens between /loop iterations before re-submitting the prompt",
			options: [
				{
					value: "prompt",
					label: "Prompt",
					description: "Re-submit the prompt as a follow-up message (current behavior)",
				},
				{
					value: "compact",
					label: "Compact",
					description: "Compact the session context, then re-submit the prompt",
				},
				{ value: "reset", label: "Reset", description: "Start a new session, then re-submit the prompt" },
			],
		},
	},

	doubleEscapeAction: {
		type: "enum",
		values: ["branch", "tree", "none"] as const,
		default: "tree",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Double-Escape Action",
			description: "Action when pressing Escape twice with empty editor",
		},
	},

	treeFilterMode: {
		type: "enum",
		values: ["default", "no-tools", "user-only", "labeled-only", "all"] as const,
		default: "default",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Session Tree Filter",
			description: "Default filter mode when opening the session tree",
		},
	},

	autocompleteMaxVisible: {
		type: "number",
		default: 10,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Autocomplete Items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			options: [
				{ value: "3", label: "3 items" },
				{ value: "5", label: "5 items" },
				{ value: "7", label: "7 items" },
				{ value: "10", label: "10 items" },
				{ value: "15", label: "15 items" },
				{ value: "20", label: "20 items" },
			],
		},
	},

	"spelling.typoDetection": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Typo Detection (macOS)",
			description: "Mark misspelled prompt words with the active macOS dictionaries",
			condition: "macOS",
		},
	},

	"spelling.autocomplete": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Word Autocomplete (macOS)",
			description: "Show macOS dictionary word completions as inline hints accepted with Tab",
			condition: "macOS",
		},
	},

	"spelling.autocorrect": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Autocorrect (macOS)",
			description: "Apply confident macOS spelling corrections after completed words",
			condition: "macOS",
		},
	},

	emojiAutocomplete: {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Emoji Autocomplete",
			description: "Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`",
		},
	},

	"paste.largeMenuThreshold": {
		type: "number",
		default: 100,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Large Paste Menu",
			description:
				"When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker).",
			options: [
				{ value: "0", label: "Off" },
				{ value: "100", label: "100 lines" },
				{ value: "250", label: "250 lines" },
				{ value: "500", label: "500 lines" },
				{ value: "1000", label: "1000 lines" },
			],
		},
	},

	"startup.quiet": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Quiet Startup",
			description: "Skip welcome screen and startup status messages",
		},
	},

	"startup.clearScrollback": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Clear Scrollback on Startup",
			description:
				"Erase the terminal's saved scrollback when proto starts, so the session begins on an empty terminal. This also erases what was on screen before you launched, and it cannot be undone. Off still starts you on a clear screen; it just leaves your history reachable by scrolling up.",
		},
	},

	"startup.setupWizard": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Setup Wizard",
			description: "Show newly added onboarding steps once per setup version",
		},
	},

	"startup.checkUpdate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Check for Updates",
			description: "Check for proto updates on startup",
		},
	},

	"marketplace.autoUpdate": {
		type: "enum",
		values: ["off", "notify", "auto"] as const,
		default: "notify",
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Marketplace Auto-Update",
			description: "Check for plugin updates on startup",
			options: [
				{ value: "off", label: "Off", description: "Don't check for plugin updates" },
				{ value: "notify", label: "Notify", description: "Check on startup and notify when updates are available" },
				{ value: "auto", label: "Auto", description: "Check on startup and auto-install updates" },
			],
		},
	},

	"startup.changelogMode": {
		type: "enum",
		values: ["summary", "expanded", "hidden"] as const,
		default: "summary",
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Startup Changelog",
			description: "Choose whether update notes start as a summary, full details, or stay hidden",
			options: [
				{
					value: "summary",
					label: "Summary",
					description: "Show release and change counts with a /changelog hint",
				},
				{
					value: "expanded",
					label: "Expanded",
					description: "Show the recent release notes in full",
				},
				{
					value: "hidden",
					label: "Hidden",
					description: "Do not show release notes on startup",
				},
			],
		},
	},

	"magicKeywords.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Magic Keywords",
			description: "Enable hidden notices for standalone ultrathink and workflowz keywords",
		},
	},

	"magicKeywords.ultrathink": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Ultrathink Keyword",
			description: "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
		},
	},

	"magicKeywords.workflow": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Workflow Keyword",
			description: "Let standalone workflowz append its hidden eval workflow notice",
		},
	},

	"completion.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Completion Notification",
			description: "Notify when the agent finishes a turn",
		},
	},

	"error.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "off",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Error Notification",
			description: "Notify when the agent stops with an error",
		},
	},

	"ask.timeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Ask Timeout",
			description: "Auto-select the recommended ask option after this many seconds (0 disables)",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "15", label: "15 seconds" },
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "60 seconds" },
				{ value: "120", label: "120 seconds" },
			],
		},
	},

	"ask.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Ask Notification",
			description: "Notify when the ask tool is waiting for input",
		},
	},

	"recap.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Idle Recap",
			description: "Generate a brief LLM recap of where things stand after the terminal has been idle",
		},
	},

	"recap.idleSeconds": {
		type: "number",
		default: 240,
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Idle Recap Delay",
			description: "Seconds to wait while idle before showing the recap",
			options: [
				{ value: "60", label: "1 minute" },
				{ value: "120", label: "2 minutes" },
				{ value: "240", label: "4 minutes" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
			],
		},
	},

	"contextPromotion.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "General",
			label: "Auto-Promote Context",
			description: "Promote to a larger-context model on context overflow instead of compacting",
		},
	},

	extendedContext: {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "General",
			label: "Extended Context",
			description:
				"Use premium long-context windows on models that bill extra past a threshold (e.g. GPT-5.6 1M charges 2x input above 272K); off caps them at the standard-pricing window",
		},
	},

	"compaction.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Auto-Compact",
			description: "Automatically compact context when it gets too large",
		},
	},

	"compaction.midTurnEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Mid-Turn Compaction",
			description: "Check thresholds at safe mid-turn tool-loop boundaries before the next provider request",
		},
	},

	"compaction.methodOrder": {
		type: "array",
		default: [...DEFAULT_COMPACTION_METHOD_ORDER],
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Compaction Method Order",
			description:
				"Preferred fallback order for automatic context maintenance; unavailable or failed methods advance to the next choice",
			options: COMPACTION_METHOD_CHOICES,
			ordered: true,
		},
	},

	"compaction.thresholdPercent": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Compaction Threshold",
			description: "Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior",
			options: [
				{ value: "default", label: "Default", description: "Legacy reserve-based threshold" },
				{ value: "10", label: "10%", description: "Extremely early maintenance" },
				{ value: "20", label: "20%", description: "Very early maintenance" },
				{ value: "30", label: "30%", description: "Early maintenance" },
				{ value: "40", label: "40%", description: "Moderately early maintenance" },
				{ value: "50", label: "50%", description: "Halfway point" },
				{ value: "60", label: "60%", description: "Moderate context usage" },
				{ value: "70", label: "70%", description: "Balanced" },
				{ value: "75", label: "75%", description: "Slightly aggressive" },
				{ value: "80", label: "80%", description: "Typical threshold" },
				{ value: "85", label: "85%", description: "Aggressive context usage" },
				{ value: "90", label: "90%", description: "Very aggressive" },
				{ value: "95", label: "95%", description: "Near context limit" },
			],
		},
	},
	"compaction.thresholdTokens": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Compaction Token Limit",
			description: "Fixed token limit for context maintenance; overrides percentage if set",
			options: [
				{ value: "default", label: "Default", description: "Use percentage-based threshold" },
				{ value: "25000", label: "25K tokens", description: "Quarter of a 200K window" },
				{ value: "50000", label: "50K tokens", description: "Half of a 200K window" },
				{ value: "100000", label: "100K tokens", description: "Half of a 200K window" },
				{ value: "150000", label: "150K tokens", description: "Three-quarters of a 200K window" },
				{ value: "200000", label: "200K tokens", description: "Full standard context window" },
				{ value: "300000", label: "300K tokens", description: "Large context window" },
				{ value: "500000", label: "500K tokens", description: "Very large context window" },
			],
		},
	},

	"compaction.remoteStreamingV2Enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Remote Compaction V2",
			description: "Use Responses streaming compaction for compatible remote compaction models",
		},
	},

	"compaction.asyncEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Async Compaction",
			description:
				"Speculatively summarize in the background as context nears the compaction threshold, then splice the ready result in when the threshold is crossed",
		},
	},

	"compaction.reserveTokens": { type: "number", default: undefined },

	"compaction.keepRecentTokens": { type: "number", default: 20000 },

	"compaction.autoContinue": { type: "boolean", default: true },

	"compaction.remoteEndpoint": { type: "string", default: undefined },

	"compaction.v2RetainedMessageBudget": { type: "number", default: 64000 },

	"compaction.idleEnabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Idle Compaction",
			description: "Compact context while idle when token count exceeds threshold",
		},
	},

	"compaction.idleThresholdTokens": {
		type: "number",
		default: 200000,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Idle Compaction Threshold",
			description: "Token count above which idle compaction triggers",
			options: [
				{ value: "100000", label: "100K tokens" },
				{ value: "200000", label: "200K tokens" },
				{ value: "300000", label: "300K tokens" },
				{ value: "400000", label: "400K tokens" },
				{ value: "500000", label: "500K tokens" },
				{ value: "600000", label: "600K tokens" },
				{ value: "700000", label: "700K tokens" },
				{ value: "800000", label: "800K tokens" },
				{ value: "900000", label: "900K tokens" },
			],
		},
	},

	"compaction.idleTimeoutSeconds": {
		type: "number",
		default: 300,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Idle Compaction Delay",
			description: "Seconds to wait while idle before compacting",
			options: [
				{ value: "60", label: "1 minute" },
				{ value: "120", label: "2 minutes" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
				{ value: "1800", label: "30 minutes" },
				{ value: "3600", label: "1 hour" },
			],
		},
	},

	"compaction.supersedeReads": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Supersede Stale Reads",
			description: "Prune older read results when the same file is read again (cache-aware, runs every turn)",
		},
	},

	"compaction.dropUseless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Elide Uneventful Results",
			description:
				"Prune tool results flagged contextually useless (no matches, timed-out waits) once consumed (cache-aware)",
		},
	},

	"tools.format": {
		type: "enum",
		values: [
			"auto",
			"native",
			"glm",
			"hermes",
			"kimi",
			"xml",
			"anthropic",
			"deepseek",
			"harmony",
			"qwen3",
			"gemini",
			"gemma",
			"minimax",
		] as const,
		default: "auto",
		ui: {
			tab: "context",
			group: "Experimental",
			label: "Tool Calling Mode",
			description:
				"Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect. Applies on session start.",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Use native tool calls unless the model is known not to support them.",
				},
				{ value: "native", label: "Native", description: "Use provider-native tool calls." },
				{ value: "glm", label: "GLM", description: "Use GLM-style in-band tool calls." },
				{ value: "hermes", label: "Hermes", description: "Use Hermes-style in-band tool calls." },
				{ value: "kimi", label: "Kimi", description: "Use Kimi-style in-band tool calls." },
				{ value: "xml", label: "XML", description: "Use generic XML in-band tool calls." },
				{ value: "anthropic", label: "Anthropic", description: "Use Anthropic-style in-band tool calls." },
				{ value: "deepseek", label: "DeepSeek", description: "Use DeepSeek-style in-band tool calls." },
				{ value: "harmony", label: "Harmony", description: "Use Harmony-style in-band tool calls." },
				{ value: "qwen3", label: "Qwen3", description: "Use the Qwen3 owned dialect." },
				{ value: "gemini", label: "Gemini", description: "Use the Gemini owned dialect." },
				{ value: "gemma", label: "Gemma", description: "Use the Gemma owned dialect." },
				{ value: "minimax", label: "MiniMax", description: "Use the MiniMax owned dialect." },
			],
		},
	},

	"branchSummary.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "General",
			label: "Branch Summaries",
			description: "Prompt to summarize when leaving a branch",
		},
	},

	"branchSummary.reserveTokens": { type: "number", default: 16384 },

	"autolearn.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Auto-Learn",
			label: "Auto-Learn (experimental)",
			description: "After the agent stops, nudge it to capture lessons and create/enhance isolated managed skills",
		},
	},
	"autolearn.autoContinue": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Auto-Learn",
			label: "Auto-run capture at stop",
			description:
				"When on, auto-run one private capture turn at stop (uses extra tokens). When off, only standing auto-learn guidance remains.",
			condition: "autolearnActive",
		},
	},

	"autolearn.minToolCalls": { type: "number", default: 5 },

	"ttsr.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR",
			description: "Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules)",
		},
	},

	"ttsr.contextMode": {
		type: "enum",
		values: ["discard", "keep"] as const,
		default: "discard",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Context Mode",
			description: "What to do with partial output when TTSR triggers",
		},
	},

	"ttsr.interruptMode": {
		type: "enum",
		values: ["never", "prose-only", "tool-only", "always"] as const,
		default: "always",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Interrupt Mode",
			description: "When to interrupt mid-stream vs inject warning after completion",
			options: [
				{ value: "always", label: "always", description: "Interrupt on prose and tool streams" },
				{ value: "prose-only", label: "prose-only", description: "Interrupt only on reply/thinking matches" },
				{ value: "tool-only", label: "tool-only", description: "Interrupt only on tool-call argument matches" },
				{ value: "never", label: "never", description: "Never interrupt; inject warning after completion" },
			],
		},
	},

	"ttsr.repeatMode": {
		type: "enum",
		values: ["once", "after-gap"] as const,
		default: "once",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Repeat Mode",
			description: "How rules can repeat: once per session or after a message gap",
		},
	},

	"ttsr.repeatGap": {
		type: "number",
		default: 10,
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Repeat Gap",
			description: "Messages before a rule can trigger again",
			options: [
				{ value: "5", label: "5 messages" },
				{ value: "10", label: "10 messages" },
				{ value: "15", label: "15 messages" },
				{ value: "20", label: "20 messages" },
				{ value: "30", label: "30 messages" },
			],
		},
	},

	"ttsr.builtinRules": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "Built-in Rules",
			description: "Load the default rules shipped with the agent (override individually with ttsr.disabledRules)",
		},
	},

	"ttsr.disabledRules": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "Disabled Rules",
			description: "Rule names to ignore entirely (applies to bundled defaults and your own rules)",
		},
	},

	"edit.mode": {
		type: "enum",
		values: EDIT_MODES,
		default: "hashline",
		ui: {
			tab: "files",
			group: "Editing",
			label: "Edit Mode",
			description: "Select the edit tool variant (replace, patch, hashline, or apply_patch)",
		},
	},

	"edit.fuzzyMatch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "Editing",
			label: "Fuzzy Match",
			description: "Accept high-confidence fuzzy matches for whitespace differences",
		},
	},

	"edit.fuzzyThreshold": {
		type: "number",
		default: 0.95,
		ui: {
			tab: "files",
			group: "Editing",
			label: "Fuzzy Match Threshold",
			description: "Similarity threshold (0-1) for accepting fuzzy matches",
			options: [
				{ value: "0.85", label: "0.85", description: "Lenient" },
				{ value: "0.90", label: "0.90", description: "Moderate" },
				{ value: "0.95", label: "0.95", description: "Default" },
				{ value: "0.98", label: "0.98", description: "Strict" },
			],
		},
	},

	"edit.streamingAbort": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Editing",
			label: "Abort on Failed Preview",
			description: "Abort streaming edit tool calls when patch preview fails",
		},
	},

	"edit.blockAutoGenerated": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "Editing",
			label: "Block Auto-Generated Files",
			description: "Prevent editing of files that appear to be auto-generated (protoc, sqlc, swagger, etc.)",
		},
	},

	"edit.enforceSeenLines": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Editing",
			label: "Enforce Seen-Line Guard",
			description: "Reject edits anchored on lines a prior read/search never displayed in full",
		},
	},
	"edit.blackbox.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Editing",
			label: "Record Parse Regressions",
			description: "Append full before/after source when an edit introduces an AST parse failure",
		},
	},

	readLineNumbers: {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Reading",
			label: "Line Numbers",
			description: "Prepend line numbers to read tool output by default",
		},
	},

	"read.defaultLimit": {
		type: "number",
		default: 300,
		ui: {
			tab: "files",
			group: "Reading",
			label: "Default Read Limit",
			description: "Default number of lines returned when agent calls read without a limit",
			options: [
				{ value: "200", label: "200 lines" },
				{ value: "300", label: "300 lines" },
				{ value: "500", label: "500 lines" },
				{ value: "1000", label: "1000 lines" },
				{ value: "5000", label: "5000 lines" },
			],
		},
	},

	"read.renderMarkdown": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Reading",
			label: "Markdown Previews",
			description: "Render Markdown read results as formatted terminal Markdown previews instead of raw source",
		},
	},

	"read.summarize.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summaries",
			description: "Return structural code summaries when read is called without an explicit selector",
		},
	},

	"read.summarize.prose": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Prose Summaries",
			description: "Return structural summaries for Markdown and plain text reads",
		},
	},

	"read.summarize.minBodyLines": {
		type: "number",
		default: 4,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summary Body Lines",
			description: "Minimum multiline body or literal length before read summaries collapse it",
		},
	},

	"read.summarize.minCommentLines": {
		type: "number",
		default: 6,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summary Comment Lines",
			description: "Minimum multiline block comment length before read summaries collapse it",
		},
	},

	"read.summarize.minTotalLines": {
		type: "number",
		default: 100,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summary Minimum File Length",
			description: "Files with fewer total lines are read verbatim instead of structurally summarized",
		},
	},

	"read.summarize.unfoldUntil": {
		type: "number",
		default: 50,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summary Unfold Target",
			description:
				"BFS-unfold elidable spans until the summary is at least this many visible lines. 0 keeps only the outermost elisions.",
		},
	},

	"read.summarize.unfoldLimit": {
		type: "number",
		default: 100,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summary Unfold Ceiling",
			description:
				"Hard ceiling on summary size while BFS-unfolding. An unfold whose revealed lines would exceed this is skipped (that span stays folded) and unfolding continues with the remaining spans.",
		},
	},

	"read.toolResultPreview": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Reading",
			label: "Inline Read Previews",
			description: "Render read tool results inline in the transcript instead of summary rows",
		},
	},

	"bash.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash",
			description: "Enable the bash tool for shell command execution",
		},
	},

	"bash.autoBackground.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash Auto-Background",
			description: "Automatically background long-running bash commands and deliver the result later",
		},
	},

	"bashInterceptor.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash Interceptor",
			description: "Block shell commands that have dedicated tools",
		},
	},
	"bashInterceptor.patterns": { type: "array", default: DEFAULT_BASH_INTERCEPTOR_RULES },

	"bash.direnv": {
		type: "enum",
		values: ["auto", "off"] as const,
		default: "auto",
		ui: {
			tab: "shell",
			group: "Bash",
			label: "direnv Auto-Load",
			description:
				"Auto-load a repo's direnv/devenv `.envrc` into the bash session so devenv tools and env vars are present without manual `direnv exec`. Honors direnv's allow list: an `.envrc` you haven't `direnv allow`ed is never executed",
		},
	},
	"bash.direnvLoadTimeoutMs": {
		type: "number",
		default: 30_000,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "direnv Load Timeout (ms)",
			description:
				"Max wait for the first `direnv export` (a cold devenv shell can be slow); on timeout the session runs without the direnv env",
		},
	},

	"shellMinimizer.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Shell Minimizer",
			description: "Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent",
		},
	},
	"shellMinimizer.settingsPath": {
		type: "string",
		default: undefined,
	},
	"shellMinimizer.only": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.except": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.maxCaptureBytes": {
		type: "number",
		default: 4 * 1024 * 1024,
	},
	"shellMinimizer.sourceOutlineLevel": {
		type: "enum",
		values: ["default", "aggressive"] as const,
		default: "default",
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Shell Minimizer Source Outline",
			description: "Source outline mode for cat/read of source files: default or aggressive",
		},
	},
	"shellMinimizer.legacyFilters": {
		type: "boolean",
		default: undefined,
	},

	"eval.py": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Python Eval Backend",
			description: "Allow the eval tool to dispatch Python cells to the IPython kernel",
		},
	},

	"eval.js": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "JavaScript Eval Backend",
			description: "Allow the eval tool to dispatch JavaScript cells to the in-process runtime",
		},
	},

	"eval.autoBackground.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Eval Auto-Background",
			description: "Automatically background long-running eval cells and deliver the result later",
		},
	},

	"eval.autoBackground.thresholdMs": {
		type: "number",
		default: 60_000,
	},

	"python.kernelMode": {
		type: "enum",
		values: ["session", "per-call"] as const,
		default: "session",
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Python Kernel Mode",
			description: "Keep the IPython kernel alive across eval calls or start fresh each time",
		},
	},
	"python.interpreter": {
		type: "string",
		default: "",
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Python Interpreter",
			description:
				"Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.",
		},
	},
	"todo.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Todos",
			description: "Enable the todo tool for task tracking",
		},
	},

	"todo.reminders": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Reminders",
			description: "Remind the agent to complete todos before stopping",
		},
	},

	"todo.remindersMax": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Reminder Limit",
			description: "Maximum number of todo reminders before giving up",
			options: [
				{ value: "1", label: "1 reminder" },
				{ value: "2", label: "2 reminders" },
				{ value: "3", label: "3 reminders" },
				{ value: "5", label: "5 reminders" },
			],
		},
	},

	"todo.eager": {
		type: "enum",
		values: ["default", "preferred", "always"] as const,
		default: "default",
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Create Todos Automatically",
			description: "How strongly to push automatic todo-list creation after the first message",
			options: [
				{ value: "default", label: "Default", description: "Model decides; no automatic todo list" },
				{
					value: "preferred",
					label: "Preferred",
					description: "Suggests a todo list on the first message (reminder, not forced)",
				},
				{ value: "always", label: "Always", description: "Forces a comprehensive todo list on the first message" },
			],
		},
	},

	"launch.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Launch",
			description: "Enable the launch tool for supervising shared long-running project processes",
		},
	},
	"generate_image.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Generate Image",
			description:
				"Enable the generate_image tool (text-to-image generation and editing). Exposed as an xd:// device when tools.xdev is on.",
		},
	},

	"inspect_media.enabled": {
		type: "boolean",
		default: false,
	},

	"inspect_media.mode": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Inspect Media",
			description:
				"Controls the inspect_media tool, which delegates image/audio/video understanding to a capable model. 'auto' exposes it only when the active model lacks native image input; 'on' always exposes it; 'off' never does.",
			options: [
				{ value: "auto", label: "Auto (only for models without native image input)" },
				{ value: "on", label: "On" },
				{ value: "off", label: "Off" },
			],
		},
	},

	"computer.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Computer",
			description: "Enable the scriptable host-desktop control tool (screenshots, input, accessibility)",
		},
	},

	"computer.display": {
		type: "string",
		default: "all",
		ui: {
			tab: "tools",
			group: "Computer",
			label: "Computer Display",
			description: "Composite all displays or select a native display id",
		},
	},

	"computer.maxWidth": {
		type: "number",
		default: 3840,
		ui: {
			tab: "tools",
			group: "Computer",
			label: "Computer Screenshot Width",
			description: "Maximum composite screenshot width in pixels",
		},
	},

	"computer.maxHeight": {
		type: "number",
		default: 2400,
		ui: {
			tab: "tools",
			group: "Computer",
			label: "Computer Screenshot Height",
			description: "Maximum composite screenshot height in pixels",
		},
	},

	"inspect_media.timeoutMs": {
		type: "number",
		default: 300_000,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Inspect Media Timeout",
			description:
				"Per-request timeout for the inspect_media model call, in milliseconds. A stalled provider fails fast with a timeout error instead of blocking until manual abort. Set to 0 to disable the timeout.",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "60000", label: "1 minute" },
				{ value: "120000", label: "2 minutes" },
				{ value: "180000", label: "3 minutes" },
				{ value: "300000", label: "5 minutes" },
			],
		},
	},

	"checkpoint.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Checkpoint/Rewind",
			description: "Enable the checkpoint and rewind tools for context checkpointing",
		},
	},

	"fetch.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Read URLs",
			description: "Allow the read tool to fetch and process URLs",
		},
	},

	"vault.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Obsidian Vault",
			description:
				"Enable the vault:// internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted from the system prompt.",
		},
	},

	"github.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "GitHub CLI",
			description:
				"Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows)",
		},
	},

	"github.cache.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "GitHub",
			label: "GitHub View Cache",
			description:
				"Cache rendered issue/PR view output in ~/.proto/cache/github-cache.db so repeated reads are free",
		},
	},

	"github.cache.softTtlSec": {
		type: "number",
		default: 300,
		ui: {
			tab: "tools",
			group: "GitHub",
			label: "GitHub Cache Soft TTL",
			description:
				"Within this window, cached issue/PR view rows are returned directly (seconds; default 5 minutes)",
		},
	},

	"github.cache.hardTtlSec": {
		type: "number",
		default: 604800,
		ui: {
			tab: "tools",
			group: "GitHub",
			label: "GitHub Cache Hard TTL",
			description:
				"Past the soft TTL the cached row is returned and refreshed in the background; past the hard TTL it is dropped (seconds; default 7 days)",
		},
	},

	"web_search.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Web Search",
			description: "Enable the web_search tool for live web results",
		},
	},

	"ask.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Ask",
			description: "Enable the ask tool for interactive user questions",
		},
	},

	"browser.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Browser",
			description: "Enable the browser tool for scripted Chromium automation (puppeteer)",
		},
	},

	"browser.cdpUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Browser CDP URL",
			description:
				"Default HTTP CDP discovery endpoint (for example http://127.0.0.1:9222) to attach to instead of launching a browser. Explicit app.cdp_url or app.path on the tool call take precedence.",
		},
	},

	"browser.relay": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Browser Relay",
			description:
				"Drive your own Chrome tabs through the proto browser relay. Install the extension once (`proto browser-relay install`); the relay server auto-starts when the browser tool needs it. Takes precedence over Browser CDP URL; set PI_BROWSER_RELAY=0 or PI_BROWSER_RELAY=1 to override.",
		},
	},

	"browser.relayUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Browser Relay URL",
			description: "proto browser relay endpoint (default http://127.0.0.1:9224).",
		},
	},

	"browser.headless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Headless Browser",
			description: "Launch browser in headless mode (disable to show browser UI)",
		},
	},

	"browser.cmux": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "cmux Browser",
			description:
				"Use cmux WKWebView surfaces for browser automation when a cmux socket is available. Set PI_BROWSER_CMUX=0 or PI_BROWSER_CMUX=1 to override.",
		},
	},
	"browser.screenshotDir": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Screenshot Directory",
			description:
				"Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android)",
		},
	},

	"tools.intentTracing": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Intent Tracing",
			description: "Ask the agent to describe the intent of each tool call before executing it",
		},
	},
	"tools.abortOnFabricatedResult": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Abort On Fabricated Tool Result",
			description:
				"With in-band tool calls, stop the model immediately when it starts hallucinating a tool result mid-turn. Disable to let the model finish generating and discard the fabricated continuation instead.",
		},
	},

	"tools.maxTimeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Max Tool Timeout",
			description: "Maximum timeout in seconds the agent can set for any tool (0 = no limit)",
			options: [
				{ value: "0", label: "No limit" },
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "60 seconds" },
				{ value: "120", label: "120 seconds" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
			],
		},
	},

	"async.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Async Execution",
			description: "Enable async bash commands and background worker execution",
		},
	},

	"async.maxJobs": {
		type: "number",
		default: 100,
	},

	"async.pollWaitDuration": {
		type: "enum",
		values: ["5s", "10s", "30s", "1m", "5m", "smart"] as const,
		default: "smart",
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Max Poll Time",
			description:
				"How long a `fleet` wait watches background jobs before returning the current state. A fixed value waits that exact duration every time. `smart` adapts: it starts at 5s and lengthens with each back-to-back wait (up to 5m), then resets to 5s after about a minute without waiting.",
			options: [
				{ value: "5s", label: "5 seconds" },
				{ value: "10s", label: "10 seconds" },
				{ value: "30s", label: "30 seconds" },
				{ value: "1m", label: "1 minute" },
				{ value: "5m", label: "5 minutes" },
				{ value: "smart", label: "Smart", description: "Default — adaptive 5s→5m, resets when you stop polling" },
			],
		},
	},

	"irc.timeoutMs": {
		type: "number",
		default: 120_000,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "IRC Timeout",
			description:
				"Default timeout for fleet message waits (and send await:true) in milliseconds; 0 disables the timeout",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "30000", label: "30 seconds" },
				{ value: "60000", label: "1 minute" },
				{ value: "120000", label: "2 minutes" },
				{ value: "300000", label: "5 minutes" },
			],
		},
	},

	"bash.autoBackground.thresholdMs": {
		type: "number",
		default: 60_000,
	},

	"tools.xdev": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "xd:// Tools",
			description:
				"Mount rarely-used (discoverable) tools under xd:// device URLs driven via read/write instead of shipping their schemas on every request. Sessions without a granted write tool skip mounting and expose every tool top-level. Disable to expose every enabled tool top-level.",
		},
	},

	"tools.xdevDocs": {
		type: "enum",
		values: ["inline", "builtins", "catalog"] as const,
		default: "builtins",
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "xd:// Prompt Docs",
			description:
				"Choose which mounted-device docs and schemas are inlined in the system prompt. Built-ins keeps core tools inline while MCP and extension tools stay on-demand.",
			options: [
				{ value: "inline", label: "All Devices", description: "Inline docs and schemas for every mounted device." },
				{
					value: "builtins",
					label: "Built-ins Only",
					description: "Inline built-in docs; fetch MCP and extension docs on demand.",
				},
				{ value: "catalog", label: "Catalog Only", description: "List every device; fetch all docs on demand." },
			],
		},
	},

	"tools.xdevInlineDevices": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "xd:// Inline Devices",
			description:
				"When xd:// Prompt Docs is Built-ins Only, inline dynamic devices whose names match these glob patterns (for example mcp__context_mode_*). Catalog Only ignores this setting.",
		},
	},

	"mcp.enableProjectConfig": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Project Config",
			description: "Load .mcp.json/mcp.json from project root",
		},
	},

	"mcp.renderMarkdownResults": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Markdown Results",
			description: "Render non-JSON MCP text results as Markdown in the transcript",
		},
	},

	"mcp.notifications": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Update Injection",
			description: "Inject MCP resource updates into the agent conversation",
		},
	},

	"mcp.notificationDebounceMs": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Notification Debounce",
			description:
				"Debounce window in milliseconds for MCP resource updates before injecting them into the conversation",
		},
	},

	"goal.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Goal Mode",
			description: "Enable per-session goal mode and the hidden goal tool",
		},
	},

	"goal.statusInFooter": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Goal Status in Footer",
			description: "Show token budget alongside the goal indicator in the status line",
		},
	},

	"goal.continuationModes": {
		type: "array",
		default: ["interactive"],
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Goal Continuation Modes",
			description: "Run modes where active goals may auto-continue between turns",
		},
	},

	"conductor.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Conductor",
			description:
				"Pend goal completion until an independent conductor (assigned to the 'conductor' role) audits the repo and rules on the claim, instead of letting the primary agent grade itself.",
		},
	},

	"conductor.gateTimeoutSeconds": {
		type: "number",
		default: 300,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Conductor Gate Timeout",
			description:
				"Seconds to wait for a verification verdict before escalating to the user. Never resolves to silent acceptance.",
			condition: "conductorEnabled",
		},
	},

	"conductor.maxRejections": {
		type: "number",
		default: 3,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Conductor Max Rejections",
			description:
				"Consecutive verification rejections before the conductor stops auto-verifying and escalates to the user.",
			condition: "conductorEnabled",
		},
	},

	"conductor.approveContract": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Conductor Contract Approval",
			description:
				"Show the contract the conductor drafts from `/conduct <rough ask>` and wait for approval before the goal is created. Off starts the stretch as soon as the contract is drafted.",
			condition: "conductorEnabled",
		},
	},

	"title.refreshOnReplan": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Refresh Title on Replan",
			description: "Refresh generated session titles after todo init replans unless the title was set by the user",
		},
	},

	"orchestrator.isolation.mode": {
		type: "enum",
		values: ["none", "auto", "apfs", "btrfs", "zfs", "reflink", "overlayfs", "rcopy"] as const,
		default: "none",
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Isolation Mode",
			description:
				'Isolation backend for workers. "auto" lets the native PAL pick the best available backend (CoW-aware filesystems, then overlayfs/ProjFS, then a git worktree / recursive-copy fallback).',
			options: [
				{ value: "none", label: "None", description: "No isolation" },
				{ value: "auto", label: "Auto", description: "Let the PAL pick the best available backend" },
				{ value: "apfs", label: "APFS", description: "macOS clonefile reflink (APFS)" },
				{ value: "btrfs", label: "btrfs", description: "btrfs subvolume snapshot" },
				{ value: "zfs", label: "ZFS", description: "ZFS snapshot + clone" },
				{ value: "reflink", label: "Reflink", description: "Linux FICLONE per-file reflink" },
				{
					value: "rcopy",
					label: "Recursive copy",
					description: "git worktree if available, otherwise recursive copy",
				},
			],
		},
	},

	"orchestrator.isolation.apply": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Apply Isolated Changes",
			description:
				"Automatically apply successful isolated worker changes to the parent checkout; disable to retain patch or branch artifacts",
		},
	},

	"orchestrator.isolation.merge": {
		type: "enum",
		values: ["patch", "branch"] as const,
		default: "patch",
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Isolation Merge Strategy",
			description: "How isolated worker changes are integrated (patch apply or branch merge)",
			options: [
				{ value: "patch", label: "Patch", description: "Combine diffs and git apply" },
				{ value: "branch", label: "Branch", description: "Commit per worker, merge with --no-ff" },
			],
		},
	},

	"orchestrator.isolation.commits": {
		type: "enum",
		values: ["generic", "ai"] as const,
		default: "generic",
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Isolation Commit Style",
			description: "Commit message style for nested repo changes (generic or AI-generated)",
			options: [
				{ value: "generic", label: "Generic", description: "Static commit message" },
				{ value: "ai", label: "AI", description: "AI-generated commit message from diff" },
			],
		},
	},

	"worktree.base": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Worktree Base Directory",
			description:
				"Base directory for agent-managed worktrees — worker-isolation copies, `github` PR checkouts, and `proto worktree` cleanup all live here. Unset uses ~/.proto/wt. Must be an absolute or ~-relative path; relative paths are ignored. The PROTO_WORKTREE_DIR env var overrides this.",
		},
	},

	"orchestrator.maxConcurrency": {
		type: "number",
		default: 32,
		ui: {
			tab: "tasks",
			group: "Workers",
			label: "Max Concurrent Worker Turns",
			description: "Maximum number of workers running concurrently",
			options: [
				{ value: "0", label: "Unlimited" },
				{ value: "1", label: "1 worker" },
				{ value: "2", label: "2 workers" },
				{ value: "4", label: "4 workers" },
				{ value: "8", label: "8 workers" },
				{ value: "16", label: "16 workers" },
				{ value: "32", label: "32 workers" },
				{ value: "64", label: "64 workers" },
			],
		},
	},

	"orchestrator.maxRecursionDepth": {
		type: "number",
		default: 2,
		ui: {
			tab: "tasks",
			group: "Workers",
			label: "Max Worker Recursion",
			description: "How many levels deep workers can spawn their own workers",
			options: [
				{ value: "-1", label: "Unlimited" },
				{ value: "0", label: "None" },
				{ value: "1", label: "Single" },
				{ value: "2", label: "Double" },
				{ value: "3", label: "Triple" },
			],
		},
	},

	"orchestrator.maxRuntimeMs": {
		type: "number",
		default: 0,
		ui: {
			tab: "tasks",
			group: "Workers",
			label: "Max Worker Runtime",
			description:
				"Hard wall-clock limit per worker (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal worker abort with a 'timed out' reason.",
			options: [
				{ value: "0", label: "Unlimited", description: "Default" },
				{ value: "300000", label: "5 minutes" },
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
				{ value: "3600000", label: "1 hour" },
			],
		},
	},

	"orchestrator.agentIdleTtlMs": {
		type: "number",
		default: 420_000,
		ui: {
			tab: "tasks",
			group: "Workers",
			label: "Agent Idle TTL",
			description:
				"How long an idle worker stays live in memory before being parked to disk (ms). Parked agents are revived automatically when messaged or resumed. 0 keeps idle agents live until exit.",
		},
	},

	"orchestrator.softRequestBudget": {
		type: "number",
		default: 200,
		ui: {
			tab: "tasks",
			group: "Workers",
			label: "Soft Worker Request Budget",
			description:
				"Soft per-worker request budget (assistant requests per run). Crossing it injects a wrap-up steering notice (see orchestrator.softRequestBudgetNotice); at 1.5x the budget the run is force-stopped and the agent must yield its partial findings. 0 disables the guard. Bundled scout/lightbot agents cap out at a lower built-in budget, so a value below that cap still applies to them.",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "90", label: "90 requests" },
				{ value: "150", label: "150 requests" },
				{ value: "200", label: "200 requests", description: "Default" },
			],
		},
	},

	"orchestrator.softRequestBudgetNotice": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Workers",
			label: "Soft Request Budget Notice",
			description:
				"Inject one steering notice when a worker crosses its soft request budget, asking it to wrap up before the 1.5x forced-yield stop.",
		},
	},

	"orchestrator.maxEffort": {
		type: "enum",
		values: THINKING_EFFORTS,
		default: "max",
		ui: {
			tab: "tasks",
			group: "Workers",
			label: "Maximum Per-Spawn Effort",
			description:
				"Maximum reasoning effort allowed for the orchestrate_spawn per-worker effort hint. Lower values prevent callers from escalating workers above this ceiling; the default preserves the model's full range.",
			options: THINKING_EFFORTS.map(getThinkingLevelMetadata),
		},
	},

	"orchestrator.disabledAgents": {
		type: "array",
		default: [] as string[],
	},

	"orchestrator.agentModelOverrides": {
		type: "record",
		default: DEFAULT_AGENT_MODEL_OVERRIDES,
	},
	"orchestrator.agentPrewalk": {
		type: "record",
		default: {} as Record<string, string>,
	},
	"orchestrator.agentAdvisor": {
		type: "record",
		default: {} as Record<string, string>,
	},
	"orchestrator.prewalk": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Workers",
			label: "Generic Worker Prewalk",
			description:
				"Arm prewalk for the bundled generic `worker` agent: it starts on its resolved model, plans and begins the implementation, then hands off to the 'smol' role at its first edit/write. Per-agent overrides (orchestrator.agentPrewalk, configured from the /agents hub) and user agent `prewalk` frontmatter apply regardless of this toggle.",
		},
	},

	"tasks.todoClearDelay": {
		type: "number",
		default: 60,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Auto-Clear Delay",
			description: "Delay before completed or abandoned todos are removed from the todo widget",
			options: [
				{ value: "0", label: "Instant" },
				{ value: "60", label: "1 minute", description: "Default" },
				{ value: "300", label: "5 minutes" },
				{ value: "900", label: "15 minutes" },
				{ value: "1800", label: "30 minutes" },
				{ value: "3600", label: "1 hour" },
				{ value: "-1", label: "Never" },
			],
		},
	},

	"orchestrator.showResolvedModelBadge": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Show Resolved Model Badge",
			description: "Display the actual model ID used by each worker in the worker widget status line",
		},
	},

	"skills.enabled": { type: "boolean", default: true },

	"skills.enableSkillCommands": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Skill Commands",
			description: "Register skills as /skill:name commands",
		},
	},

	"skills.enableCodexUser": { type: "boolean", default: true },

	"skills.enableClaudeUser": { type: "boolean", default: true },

	"skills.enableClaudeProject": { type: "boolean", default: true },

	"skills.enablePiUser": { type: "boolean", default: true },

	"skills.enablePiProject": { type: "boolean", default: true },

	"skills.enableAgentsUser": { type: "boolean", default: true },

	"skills.enableAgentsProject": { type: "boolean", default: true },

	"skills.customDirectories": { type: "array", default: [] as string[] },

	"skills.ignoredSkills": { type: "array", default: [] as string[] },

	"skills.includeSkills": { type: "array", default: [] as string[] },

	"commands.enableClaudeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Claude User Commands",
			description: "Load commands from ~/.claude/commands/",
		},
	},

	"commands.enableClaudeProject": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Claude Project Commands",
			description: "Load commands from .claude/commands/",
		},
	},

	"commands.enableOpencodeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "OpenCode User Commands",
			description: "Load commands from ~/.config/opencode/commands/",
		},
	},

	"commands.enableOpencodeProject": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "OpenCode Project Commands",
			description: "Load commands from .opencode/commands/",
		},
	},

	"secrets.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Privacy",
			label: "Hide Secrets",
			description: "Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers",
		},
	},

	"providers.ollama-cloud.maxConcurrency": {
		type: "number",
		default: 3,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Ollama Cloud Max Concurrency",
			description: "Maximum concurrent Ollama Cloud worker runs per process; 0 disables the provider-specific limit",
		},
	},
	"providers.webSearchOrder": {
		type: "array",
		default: [] as SearchProviderId[],
		ui: {
			tab: "providers",
			group: "Services",
			label: "Web Search Provider Order",
			description:
				"Prioritized providers for the web_search tool; unlisted providers retain their default order afterward",
			options: SEARCH_PROVIDER_CHOICES,
			ordered: true,
		},
	},
	"providers.webSearchExclude": {
		type: "array",
		default: [] as SearchProviderId[],
		ui: {
			tab: "providers",
			group: "Services",
			label: "Excluded Web Search Providers",
			description: "Providers that web_search should never use, even as fallbacks",
			options: SEARCH_PROVIDER_CHOICES,
		},
	},
	"providers.webSearchTimeoutSeconds": {
		type: "number",
		default: DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Web Search Timeout",
			description: `Hard timeout for each provider's search transport before web_search advances to the next fallback, in seconds (maximum ${MAX_WEB_SEARCH_TIMEOUT_SECONDS})`,
			options: [
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "1 minute" },
				{ value: "120", label: "2 minutes" },
				{ value: "180", label: "3 minutes" },
				{ value: "300", label: "5 minutes" },
			],
		},
	},
	"providers.webSearchGeminiModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Gemini web_search model",
			description: "Model ID for Gemini Google Search grounding. Defaults to gemini-2.5-flash.",
		},
	},
	"providers.antigravityEndpoint": {
		type: "enum",
		values: ["auto", "production", "sandbox"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Antigravity Endpoint Mode",
			description: "Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery)",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Try production endpoint, fail over to sandbox on 5xx/429",
				},
				{
					value: "production",
					label: "Production Only",
					description: "Force production endpoint only",
				},
				{
					value: "sandbox",
					label: "Sandbox Only",
					description: "Force sandbox endpoint only",
				},
			],
		},
	},
	"providers.imageOrder": {
		type: "array",
		default: [] as ImageProvider[],
		ui: {
			tab: "providers",
			group: "Services",
			label: "Image Provider Order",
			description:
				"Prioritized providers for image generation; unlisted providers follow the active session provider and the built-in order",
			options: IMAGE_PROVIDER_CHOICES,
			ordered: true,
		},
	},
	"providers.fireworksTier": {
		type: "enum",
		values: ["standard", "priority"] as const,
		default: "standard",
		ui: {
			tab: "providers",
			group: "Fireworks",
			label: "Fireworks Tier",
			description:
				'Serving path for Fireworks requests. Priority sends `service_tier: "priority"` for higher reliability during peak traffic at a higher price; Standard omits it. Fast (`-fast`) models ignore this — Fast is its own serving path.',
			options: [
				{ value: "standard", label: "Standard", description: "Default serving path (no service_tier)" },
				{
					value: "priority",
					label: "Priority",
					description: "Priority serving path: higher reliability, premium per-token pricing",
				},
			],
		},
	},
	"providers.tinyModel": {
		type: "enum",
		values: TINY_TITLE_MODEL_VALUES,
		default: ONLINE_TINY_TITLE_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Tiny Model",
			description:
				"Session-title model: online (the TINY role from /models, else @smol) by default, or a local on-device model",
			options: TINY_TITLE_MODEL_OPTIONS,
		},
	},
	"providers.tinyModelDevice": {
		type: "enum",
		values: TINY_MODEL_DEVICE_SETTING_VALUES,
		default: TINY_MODEL_DEVICE_DEFAULT,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Tiny Model Device",
			description:
				"ONNX execution provider for local tiny models (titles + memory). Default uses CPU-only inference. The PI_TINY_DEVICE env var overrides this.",
			options: TINY_MODEL_DEVICE_SETTING_OPTIONS,
		},
	},
	"providers.tinyModelDtype": {
		type: "enum",
		values: TINY_MODEL_DTYPE_SETTING_VALUES,
		default: TINY_MODEL_DTYPE_DEFAULT,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Tiny Model Precision",
			description:
				"ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. The PI_TINY_DTYPE env var overrides this.",
			options: TINY_MODEL_DTYPE_SETTING_OPTIONS,
		},
	},
	"features.unexpectedStopDetection": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Agent",
			label: "Detect unexpected stops",
			description:
				"Use a small model to detect when the assistant says it will continue but stops without tool calls; automatically prompt it to continue.",
		},
	},
	"providers.unexpectedStopModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Unexpected Stop Model",
			description:
				"Classifier for unexpected-stop detection: online (the TINY role from /models, else smol) by default, or a local on-device model.",
			condition: "unexpectedStopDetection",
			options: TINY_MEMORY_MODEL_OPTIONS,
		},
	},

	"providers.kimiApiFormat": {
		type: "enum",
		values: ["auto", "openai", "anthropic"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "Kimi API Format",
			description: "API format for Kimi Code provider (auto follows live model metadata)",
			options: [
				{ value: "auto", label: "Auto", description: "Use the model's server-declared protocol" },
				{ value: "openai", label: "OpenAI", description: "api.kimi.com" },
				{ value: "anthropic", label: "Anthropic", description: "api.moonshot.ai" },
			],
		},
	},

	"providers.openaiWebsockets": {
		type: "enum",
		values: ["auto", "off", "on"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "OpenAI WebSockets",
			description: "Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)",
			options: [
				{ value: "auto", label: "Auto", description: "Use model/provider default websocket behavior" },
				{ value: "off", label: "Off", description: "Disable websockets for OpenAI Codex models" },
				{ value: "on", label: "On", description: "Force websockets for OpenAI Codex models" },
			],
		},
	},

	"providers.cacheRetention": {
		type: "enum",
		values: ["auto", "short", "long", "none"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "Prompt Cache Retention",
			description:
				"Prompt-cache retention forwarded to providers that support it (Anthropic, Bedrock, OpenRouter, OpenAI)",
			options: [
				{
					value: "auto",
					label: "Auto",
					description:
						"Provider default — Anthropic uses 5m entries kept warm by idle keep-alive refreshes; PI_CACHE_RETENTION still applies",
				},
				{
					value: "short",
					label: "Short (5m)",
					description:
						"Cheapest cache writes; Anthropic keeps the entry warm with bounded keep-alive refreshes while idle",
				},
				{
					value: "long",
					label: "Long (1h)",
					description: "1h TTL where the provider supports it; pricier writes, no keep-alive refresh requests",
				},
				{ value: "none", label: "Off", description: "Disable prompt caching and cache-affinity routing" },
			],
		},
	},

	"providers.streamFirstEventTimeoutSeconds": {
		type: "number",
		default: -1,
		ui: {
			tab: "providers",
			group: "Timeouts",
			label: "Stream First Event Timeout",
			description:
				"Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog",
			options: [
				{ value: "-1", label: "Auto", description: "Use provider defaults and PI_* timeout env vars" },
				{ value: "0", label: "Off", description: "Disable first-event timeout" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
				{ value: "1800", label: "30 minutes" },
			],
		},
	},

	"providers.streamIdleTimeoutSeconds": {
		type: "number",
		default: -1,
		ui: {
			tab: "providers",
			group: "Timeouts",
			label: "Stream Idle Timeout",
			description:
				"Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog",
			options: [
				{ value: "-1", label: "Auto", description: "Use provider defaults and PI_* timeout env vars" },
				{ value: "0", label: "Off", description: "Disable idle timeout" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
				{ value: "1800", label: "30 minutes" },
			],
		},
	},

	"providers.openrouterVariant": {
		type: "enum",
		values: ["default", "nitro", "floor", "online", "exacto"] as const,
		default: "default",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "OpenRouter Routing",
			description:
				"Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant)",
			options: [
				{ value: "default", label: "Default", description: "No suffix; use OpenRouter's default routing" },
				{ value: "nitro", label: ":nitro", description: "Prioritize throughput / lowest latency" },
				{ value: "floor", label: ":floor", description: "Prioritize cheapest available provider" },
				{ value: "online", label: ":online", description: "Enable OpenRouter's web-search plugin" },
				{
					value: "exacto",
					label: ":exacto",
					description: "Cherry-picked high-quality providers (only defined for select models)",
				},
			],
		},
	},
	"providers.fetch": {
		type: "enum",
		values: ["auto", "native", "trafilatura", "lynx", "parallel", "jina"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Fetch Provider",
			description: "Reader backend priority for the fetch/read URL tool",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Priority: native > trafilatura > lynx > parallel > jina",
				},
				{ value: "native", label: "Native", description: "In-process HTML→Markdown converter (always available)" },
				{ value: "trafilatura", label: "Trafilatura", description: "Auto-installs via uv/pip" },
				{ value: "lynx", label: "Lynx", description: "Requires lynx system package" },
				{ value: "parallel", label: "Parallel", description: "Requires PARALLEL_API_KEY" },
				{ value: "jina", label: "Jina", description: "Uses r.jina.ai reader (JINA_API_KEY optional)" },
			],
		},
	},

	"codexResets.autoRedeem": {
		type: "enum",
		values: ["unset", "yes", "no"] as const,
		default: "unset" as const,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Auto-Redeem Saved Resets",
			description:
				"Spend saved Codex rate-limit resets automatically: restore an account blocked by an exhausted 5h or weekly window when a turn is stuck and no other account can take over, and salvage credits that are about to expire. unset asks before the first spend, yes spends without prompting, and no disables both checks.",
			options: [
				{
					value: "unset",
					label: "Unset",
					description: "Check eligibility, then ask before spending the first saved reset.",
				},
				{ value: "yes", label: "Yes", description: "Spend eligible saved resets without prompting." },
				{ value: "no", label: "No", description: "Do not run the saved-reset auto-redeem check." },
			],
		},
	},
	"codexResets.minBlockedMinutes": {
		type: "number",
		default: 60,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Auto-Redeem Min Block",
			description:
				"Only auto-redeem when the natural unblock — the latest reset among the exhausted 5h/weekly windows — is at least this many minutes away (don't spend a scarce credit to save a short wait). Raise it (e.g. 360) to ignore 5h-only blocks.",
		},
	},
	"codexResets.keepCredits": {
		type: "number",
		default: 0,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Auto-Redeem Reserve",
			description:
				"Never auto-spend below this many saved resets (0 = the last credit may be spent automatically). Credits about to expire are exempt — a reserved credit that expires preserves nothing.",
		},
	},
	"codexResets.salvageHorizonHours": {
		type: "number",
		default: 12,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Reset Salvage Horizon",
			description:
				"Spend a saved Codex reset automatically when it would otherwise expire within this many hours and either chat window (5h or weekly) has meaningful usage to restore (0 disables expiry salvage).",
		},
	},
	"provider.appendOnlyContext": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "Append-Only Context",
			description:
				"Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers.",
			options: [
				{ value: "auto", label: "Auto", description: "Enable for known prefix-cache providers (recommended)" },
				{ value: "on", label: "On", description: "Always enable append-only context" },
				{ value: "off", label: "Off", description: "Disable append-only context" },
			],
		},
	},

	"exa.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa",
			description: "Enable the Exa web search provider",
		},
	},

	"exa.searchDelayMs": {
		type: "number",
		default: 1_000,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa Search Delay",
			description: "Minimum delay between Exa web search requests in milliseconds; set 0 to disable pacing",
		},
	},

	"searxng.endpoint": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			group: "Services",
			label: "SearXNG Endpoint",
			description: "Base URL of a self-hosted SearXNG instance used for web search",
		},
	},

	"searxng.token": {
		type: "string",
		default: undefined,
		credential: true,
	},

	"searxng.basicUsername": {
		type: "string",
		default: undefined,
	},

	"searxng.basicPassword": {
		type: "string",
		default: undefined,
		credential: true,
	},

	"searxng.categories": {
		type: "string",
		default: undefined,
	},

	"searxng.engines": {
		type: "string",
		default: undefined,
	},

	"searxng.language": {
		type: "string",
		default: undefined,
	},

	"searxng.safesearch": {
		type: "number",
		default: undefined,
	},

	"commit.mapReduceEnabled": { type: "boolean", default: true },

	"commit.mapReduceMinFiles": { type: "number", default: 4 },

	"commit.mapReduceMaxFileTokens": { type: "number", default: 50000 },

	"commit.mapReduceTimeoutMs": { type: "number", default: 120000 },

	"commit.mapReduceMaxConcurrency": { type: "number", default: 5 },

	"commit.changelogMaxDiffChars": { type: "number", default: 120000 },

	"extensionHandlers.toolCallTimeoutMs": {
		type: "number",
		default: 30_000,
		ui: {
			tab: "tools",
			group: "Extensions",
			label: "Tool Call Handler Timeout (ms)",
			description:
				"Positive finite active-work timeout for extension tool_call handlers; invalid values use 30000ms, and time awaiting PROTO-owned dialogs does not count",
		},
	},

	"dev.autoqa": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Developer",
			label: "Auto QA",
			description:
				"Automated tool issue reporting (xd://report_issue). On by default; the first report asks for consent, and denying it disables reporting until re-enabled explicitly",
		},
	},

	"dev.autoqaPush.endpoint": {
		type: "string",
		default: "https://qa.proto.sh/v1/grievances" as const,
		ui: {
			tab: "tools",
			group: "Developer",
			label: "Auto QA Push Endpoint",
			description: "Full URL receiving Auto QA JSON reports (default https://qa.proto.sh/v1/grievances)",
		},
	},

	"dev.autoqaPush.token": {
		type: "string",
		default: undefined,
		credential: true,
	},

	"dev.autoqaConsent": {
		type: "enum",
		values: ["unset", "granted", "denied"] as const,
		default: "unset" as const,
	},

	"gc.blobs": { type: "boolean", default: true },

	"gc.archive": { type: "boolean", default: true },

	"gc.wal": { type: "boolean", default: true },

	"gc.coldArchiveAfterDays": { type: "number", default: 30 },

	"gc.retainNewestGlobal": { type: "number", default: 20 },

	"gc.retainNewestPerCwd": { type: "number", default: 10 },

	"thinkingBudgets.minimal": { type: "number", default: 1024 },

	"thinkingBudgets.low": { type: "number", default: 2048 },

	"thinkingBudgets.medium": { type: "number", default: 8192 },

	"thinkingBudgets.high": { type: "number", default: 16384 },

	"thinkingBudgets.xhigh": { type: "number", default: 32768 },

	"thinkingBudgets.max": { type: "number", default: 32768 },
} as const;

type Schema = typeof SETTINGS_SCHEMA;

export type SettingPath = keyof Schema;

export type SettingValue<P extends SettingPath> = Schema[P] extends { type: "boolean"; default: undefined }
	? boolean | undefined
	: Schema[P] extends { type: "boolean" }
		? boolean
		: Schema[P] extends { type: "string" }
			? string | undefined
			: Schema[P] extends { type: "number"; default: undefined }
				? number | undefined
				: Schema[P] extends { type: "number" }
					? number
					: Schema[P] extends { type: "enum"; values: infer V }
						? V extends readonly string[]
							? V[number]
							: never
						: Schema[P] extends { type: "array"; default: infer D }
							? D
							: Schema[P] extends { type: "record"; default: infer D }
								? D
								: never;

export function getDefault<P extends SettingPath>(path: P): SettingValue<P> {
	return SETTINGS_SCHEMA[path].default as SettingValue<P>;
}

export function isCredential(path: SettingPath): boolean {
	const def = SETTINGS_SCHEMA[path];
	if ("credential" in def && def.credential === true) return true;

	return getUi(path)?.secret === true;
}

export function getUi(path: SettingPath): AnyUiMetadata | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "ui" in def ? (def.ui as AnyUiMetadata) : undefined;
}

export function getPathsForTab(tab: SettingTab): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(path => {
		const ui = getUi(path);
		return ui?.tab === tab;
	});
}

export function getType(path: SettingPath): SettingDef["type"] {
	return SETTINGS_SCHEMA[path].type;
}

export function getEnumValues(path: SettingPath): readonly string[] | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "values" in def ? (def.values as readonly string[]) : undefined;
}

export type StatusLineSeparatorStyle = SettingValue<"statusLine.separator">;

export type TreeFilterMode = SettingValue<"treeFilterMode">;

export type Personality = SettingValue<"personality">;

export interface CompactionSettings {
	enabled: boolean;
	methodOrder: CompactionMethod[];
	thresholdPercent: number;
	thresholdTokens: number;
	reserveTokens: number | undefined;
	keepRecentTokens: number;
	midTurnEnabled: boolean;
	asyncEnabled: boolean;
	autoContinue: boolean;
	remoteEndpoint: string | undefined;
	remoteStreamingV2Enabled: boolean;
	v2RetainedMessageBudget: number;
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
	supersedeReads: boolean;
	dropUseless: boolean;
}

interface RecapSettings {
	enabled: boolean;
	idleSeconds: number;
}

interface TitleSettings {
	refreshOnReplan: boolean;
}

interface ContextPromotionSettings {
	enabled: boolean;
}
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	modelFallback: boolean;
	usageAwareFallback: boolean;
	usageReservePct: number;
	usageReservePolicy: "confirm" | "auto" | "fail-closed";
}

interface MemoriesSettings {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

interface BranchSummarySettings {
	enabled: boolean;
	reserveTokens: number;
}

export interface SkillsSettings {
	enabled?: boolean;
	enableSkillCommands?: boolean;
	enableCodexUser?: boolean;
	enableClaudeUser?: boolean;
	enableClaudeProject?: boolean;
	enablePiUser?: boolean;
	enablePiProject?: boolean;
	enableAgentsUser?: boolean;
	enableAgentsProject?: boolean;
	customDirectories?: string[];
	ignoredSkills?: string[];
	includeSkills?: string[];
	disabledExtensions?: string[];
}

interface CommitSettings {
	mapReduceEnabled: boolean;
	mapReduceMinFiles: number;
	mapReduceMaxFileTokens: number;
	mapReduceTimeoutMs: number;
	mapReduceMaxConcurrency: number;
	changelogMaxDiffChars: number;
}

export interface TtsrSettings {
	enabled: boolean;
	contextMode: "discard" | "keep";
	interruptMode: "never" | "prose-only" | "tool-only" | "always";
	repeatMode: "once" | "after-gap";
	repeatGap: number;

	builtinRules?: boolean;

	disabledRules?: string[];
}

interface ExaSettings {
	enabled: boolean;
	searchDelayMs: number;
}

export interface StatusLineSettings {
	enabled: boolean;
	showAccount: boolean;
	separator: StatusLineSeparatorStyle;
	showHookStatus: boolean;
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	segmentOptions: Record<string, unknown>;
}

interface ThinkingBudgetsSettings {
	minimal: number;
	low: number;
	medium: number;
	high: number;
	xhigh: number;
	max: number;
}
export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	allowSubcommands?: string[];
}

export interface ShellMinimizerSettings {
	enabled: boolean;
	settingsPath: string | undefined;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
	sourceOutlineLevel: "default" | "aggressive";
	legacyFilters: boolean | undefined;
}
export type CodexAutoRedeemMode = "unset" | "yes" | "no";

interface CodexResetsSettings {
	autoRedeem: CodexAutoRedeemMode;
	minBlockedMinutes: number;
	keepCredits: number;
	salvageHorizonHours: number;
}

interface GcSettings {
	blobs: boolean;
	archive: boolean;
	wal: boolean;
	coldArchiveAfterDays: number;
	retainNewestGlobal: number;
	retainNewestPerCwd: number;
}

export interface GroupTypeMap {
	compaction: CompactionSettings;
	recap: RecapSettings;
	title: TitleSettings;
	contextPromotion: ContextPromotionSettings;
	retry: RetrySettings;
	memories: MemoriesSettings;
	branchSummary: BranchSummarySettings;
	skills: SkillsSettings;
	commit: CommitSettings;
	ttsr: TtsrSettings;
	exa: ExaSettings;
	statusLine: StatusLineSettings;
	thinkingBudgets: ThinkingBudgetsSettings;
	modelRoles: Record<string, string>;
	modelTags: ModelTagsSettings;
	cycleOrder: string[];
	shellMinimizer: ShellMinimizerSettings;
	codexResets: CodexResetsSettings;
	gc: GcSettings;
}

export type GroupPrefix = keyof GroupTypeMap;
