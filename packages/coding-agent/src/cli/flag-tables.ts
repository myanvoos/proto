import { isServiceTierOpenAISettingValue, SERVICE_TIER_OPENAI_VALUES } from "../config/service-tier";
import type { ThinkingLevel } from "../thinking";
import type { Args } from "./args";
import { CliUsageError } from "./usage-error";

export interface ParseDeps {
	logger: { warn: (message: string, meta?: Record<string, unknown>) => void };
	parseThinking: (value: string | null | undefined) => ThinkingLevel | undefined;
	normalizeToolNames: (values: Iterable<string>) => string[];
	thinkingEfforts: readonly string[];
}

type StringSetter = (result: Args, value: string, deps: ParseDeps) => void;

type OptionalSetter = (result: Args, value: string | undefined) => void;

interface OptionalFlagConfig {
	set: OptionalSetter;
	rejectEmpty?: boolean;
}

const setExtension: StringSetter = (result, value) => {
	result.extensions = result.extensions ?? [];
	result.extensions.push(value);
};

const setResume: OptionalSetter = (result, value) => {
	result.resume = value !== undefined ? value : true;
};

const MAX_TIME_DURATION_RE = /^(\d+(?:\.\d+)?)([smh])$/;

function maxTimeMultiplier(unit: string | undefined): number {
	if (unit === "h") return 3600;
	if (unit === "m") return 60;
	return 1;
}

function parseMaxTimeSeconds(value: string): number {
	const trimmed = value.trim();
	const duration = MAX_TIME_DURATION_RE.exec(trimmed);
	const seconds = duration ? Number(duration[1]) * maxTimeMultiplier(duration[2]) : Number(trimmed);
	if (Number.isFinite(seconds) && seconds > 0) return seconds;
	throw new CliUsageError(
		`Invalid --max-time value: ${JSON.stringify(value)}. Expected a positive number of seconds or duration like "5s", "10m", "1h".`,
	);
}

export const STRING_SETTERS: Record<string, StringSetter> = {
	"--cwd": (result, value) => {
		result.cwd = value;
	},
	"--config": (result, value) => {
		result.config = [...(result.config ?? []), value];
	},
	"--add-dir": (result, value) => {
		result.addDir = [...(result.addDir ?? []), value];
	},
	"--mode": (result, value) => {
		if (value === "text" || value === "json" || value === "rpc" || value === "acp" || value === "rpc-ui") {
			result.mode = value;
		}
	},
	"--fork": (result, value) => {
		result.fork = value;
	},
	"--provider": (result, value) => {
		result.provider = value;
	},
	"--model": (result, value) => {
		result.model = value;
	},
	"--smol": (result, value) => {
		result.smol = value;
	},
	"--slow": (result, value) => {
		result.slow = value;
	},
	"--prewalk-into": (result, value) => {
		result.prewalkInto = value;
	},
	"--max-time": (result, value) => {
		result.maxTime = parseMaxTimeSeconds(value);
	},
	"--service-tier": (result, value) => {
		if (!isServiceTierOpenAISettingValue(value)) {
			throw new CliUsageError(
				`Invalid --service-tier value: ${JSON.stringify(value)}. Expected one of: ${SERVICE_TIER_OPENAI_VALUES.join(", ")}.`,
			);
		}
		result.serviceTier = value;
	},
	"--api-key": (result, value) => {
		result.apiKey = value;
	},
	"--system-prompt": (result, value) => {
		result.systemPrompt = value;
	},
	"--append-system-prompt": (result, value) => {
		result.appendSystemPrompt = value;
	},
	"--provider-session-id": (result, value) => {
		result.providerSessionId = value;
	},
	"--prompt-cache-key": (result, value) => {
		result.providerPromptCacheKey = value;
	},
	"--session-dir": (result, value) => {
		result.sessionDir = value;
	},
	"--models": (result, value) => {
		result.models = value.split(",").map(s => s.trim());
	},
	"--tools": (result, value, deps) => {
		const names = deps.normalizeToolNames(
			value
				.split(",")
				.map(s => s.trim())
				.filter(Boolean),
		);

		result.tools = names;
	},
	"--thinking": (result, value, deps) => {
		const thinking = deps.parseThinking(value);
		if (thinking !== undefined) {
			result.thinking = thinking;
		} else {
			deps.logger.warn("Invalid thinking level passed to --thinking", {
				level: value,
				validThinkingLevels: deps.thinkingEfforts,
			});
		}
	},
	"--hook": (result, value) => {
		result.hooks = result.hooks ?? [];
		result.hooks.push(value);
	},
	"--extension": setExtension,
	"-e": setExtension,
	"--trusted-extension": (result, value) => {
		result.trustedExtensions = result.trustedExtensions ?? [];
		result.trustedExtensions.push(value);
	},
	"--plugin-dir": (result, value) => {
		result.pluginDirs = result.pluginDirs ?? [];
		result.pluginDirs.push(value);
	},
	"--skills": (result, value) => {
		result.skills = value.split(",").map(s => s.trim());
	},
};

export const OPTIONAL_FLAGS: Record<string, OptionalFlagConfig> = {
	"--resume": { set: setResume, rejectEmpty: true },
	"-r": { set: setResume, rejectEmpty: true },
	"--session": { set: setResume, rejectEmpty: true },
};

export const STRING_VALUE_FLAGS: ReadonlySet<string> = new Set(Object.keys(STRING_SETTERS));

export const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(Object.keys(OPTIONAL_FLAGS));

export const PROFILE_BOOTSTRAP_BOUNDARY_ARG = "--proto-profile-boundary";

export const VALUELESS_FLAGS: ReadonlySet<string> = new Set([
	"--help",
	"--version",
	"--allow-home",
	"--continue",
	"--from-claude",
	"--from-codex",
	"--no-session",
	"--no-tools",
	"--no-lsp",
	"--no-pty",
	"--hide-thinking",
	"--advisor",
	"--external-thinking",
	"--prewalk",
	"--no-prewalk",
	"--print",
	"--print-thoughts",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-title",
	"--auto-approve",
	"--yolo",
]);

export function isUnknownLongValueCandidate(arg: string): boolean {
	return (
		arg.startsWith("--") &&
		!arg.includes("=") &&
		!STRING_VALUE_FLAGS.has(arg) &&
		!OPTIONAL_VALUE_FLAGS.has(arg) &&
		!VALUELESS_FLAGS.has(arg)
	);
}

export function flagConsumesValue(flag: string, next: string | undefined): boolean {
	if (flag.startsWith("--") && flag.includes("=")) return false;
	if (next === undefined) return false;

	if (STRING_VALUE_FLAGS.has(flag)) return true;
	const valueLike = !next.startsWith("-");
	if (OPTIONAL_VALUE_FLAGS.has(flag)) {
		const config = OPTIONAL_FLAGS[flag];
		return valueLike && !(config.rejectEmpty === true && next.length === 0);
	}
	if (isUnknownLongValueCandidate(flag)) return valueLike;
	return false;
}
