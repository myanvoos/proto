import * as path from "node:path";
import { $env, BINARY_NAME, logger } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { ServiceTierOpenAISettingValue } from "../config/service-tier";
import { CLI_THINKING_LEVELS, parseCliThinkingLevel, type ThinkingLevel } from "../thinking";
import { normalizeToolNames } from "../tools/builtin-names";
import {
	OPTIONAL_FLAGS,
	OPTIONAL_VALUE_FLAGS,
	type ParseDeps,
	PROFILE_BOOTSTRAP_BOUNDARY_ARG,
	STRING_SETTERS,
	STRING_VALUE_FLAGS,
} from "./flag-tables";
import { getExtraHelpText } from "./help-extra";
import { CliUsageError } from "./usage-error";

export { getExtraHelpText };

export type Mode = "text" | "json" | "rpc" | "acp" | "rpc-ui";

export interface Args {
	cwd?: string;

	addDir?: string[];
	profile?: string;
	alias?: string;
	allowHome?: boolean;
	provider?: string;
	model?: string;
	config?: string[];
	smol?: string;
	slow?: string;
	prewalk?: boolean;
	noPrewalk?: boolean;
	prewalkInto?: string;
	maxTime?: number;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	thinking?: ThinkingLevel;
	serviceTier?: ServiceTierOpenAISettingValue;
	hideThinking?: boolean;
	advisor?: boolean;
	externalThinking?: boolean;
	continue?: boolean;
	resume?: string | true;
	fromClaude?: boolean;
	fromCodex?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	sessionDir?: string;
	providerSessionId?: string;
	providerPromptCacheKey?: string;
	fork?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noLsp?: boolean;
	noPty?: boolean;
	hooks?: string[];
	extensions?: string[];
	trustedExtensions?: string[];
	noExtensions?: boolean;
	pluginDirs?: string[];
	print?: boolean;
	printThoughts?: boolean;
	noSkills?: boolean;
	skills?: string[];
	noRules?: boolean;
	noTitle?: boolean;
	messages: string[];
	fileArgs: string[];

	unknownFlags: Map<string, boolean | string>;

	unrecognizedFlags: string[];
}

const PARSE_DEPS: ParseDeps = {
	logger,
	parseThinking: parseCliThinkingLevel,
	normalizeToolNames,
	thinkingEfforts: CLI_THINKING_LEVELS,
};

const WINDOWS_PATH_VALUE_FLAGS = new Set(["--extension", "-e", "--hook", "--trusted-extension"]);
const WINDOWS_PATH_START_RE =
	/^(?:[A-Za-z]:[\\/]|\\\\[?]\\(?:[A-Za-z]:[\\/]|UNC[\\/])|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/\/[?]\/(?:[A-Za-z]:\/|UNC\/)|\/\/[^/]+\/[^/]+\/)/;
const WINDOWS_MODULE_PATH_SUFFIX_RE = /\.(?:[cm]?[jt]sx?)$/i;

function consumeBuiltInStringValue(flag: string, args: string[], valueIndex: number): { value: string; index: number } {
	const value = args[valueIndex];
	if (
		value === undefined ||
		!WINDOWS_PATH_VALUE_FLAGS.has(flag) ||
		!WINDOWS_PATH_START_RE.test(value) ||
		WINDOWS_MODULE_PATH_SUFFIX_RE.test(value)
	) {
		return { value: value ?? "", index: valueIndex };
	}

	let candidate = value;
	for (let index = valueIndex + 1; index < args.length; index++) {
		const next = args[index];
		if (next === PROFILE_BOOTSTRAP_BOUNDARY_ARG || next.startsWith("-")) break;
		candidate += ` ${next}`;
		if (WINDOWS_MODULE_PATH_SUFFIX_RE.test(candidate)) {
			return { value: candidate, index };
		}
	}

	return { value, index: valueIndex };
}

export function parseArgs(inputArgs: string[], extensionFlags?: Map<string, { type: "boolean" | "string" }>): Args {
	const args = [...inputArgs];
	const parseDeps = PARSE_DEPS;
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		sessionDir: $env.PI_CODING_AGENT_SESSION_DIR || undefined,
	};

	let sawSeparator = false;
	let trustedFlagCount = 0;
	for (let i = 0; i < args.length; i++) {
		let arg = args[i];
		if (sawSeparator) {
			result.messages.push(arg);
			continue;
		}
		if (arg === PROFILE_BOOTSTRAP_BOUNDARY_ARG) {
			continue;
		}
		const flagIndex = i;

		let equalsValueIndex = -1;
		if (arg.startsWith("--") && arg.includes("=")) {
			const eqIdx = arg.indexOf("=");
			const value = arg.slice(eqIdx + 1);
			arg = arg.slice(0, eqIdx);
			args.splice(i + 1, 0, value);
			equalsValueIndex = i + 1;
		}

		const extFlag = arg.startsWith("--") ? extensionFlags?.get(arg.slice(2)) : undefined;
		if (extFlag) {
			const flagName = arg.slice(2);
			if (extFlag.type === "boolean") {
				result.unknownFlags.set(flagName, true);
			} else if (extFlag.type === "string" && i + 1 < args.length) {
				if (equalsValueIndex !== -1 || !args[i + 1].startsWith("-")) {
					result.unknownFlags.set(flagName, args[++i]);
				}
			}
		} else if (STRING_VALUE_FLAGS.has(arg)) {
			if (arg === "--trusted-extension") trustedFlagCount++;

			if (i + 1 < args.length && args[i + 1] !== PROFILE_BOOTSTRAP_BOUNDARY_ARG) {
				const consumed = consumeBuiltInStringValue(arg, args, i + 1);
				i = consumed.index;
				STRING_SETTERS[arg](result, consumed.value, parseDeps);
			}
		} else if (OPTIONAL_VALUE_FLAGS.has(arg)) {
			const config = OPTIONAL_FLAGS[arg];
			const next = args[i + 1];
			const consume =
				next !== undefined && !next.startsWith("-") && !(config.rejectEmpty === true && next.length === 0);
			config.set(result, consume ? args[++i] : undefined);
		} else if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--allow-home") {
			result.allowHome = true;
		} else if (arg === "--profile" && i + 1 < args.length) {
			result.profile = args[++i];
		} else if (arg.startsWith("--profile=")) {
			result.profile = arg.slice("--profile=".length);
		} else if (arg === "--alias" && i + 1 < args.length) {
			result.alias = args[++i];
		} else if (arg.startsWith("--alias=")) {
			result.alias = arg.slice("--alias=".length);
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--from-claude") {
			result.fromClaude = true;
		} else if (arg === "--from-codex") {
			result.fromCodex = true;
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--no-tools") {
			result.noTools = true;
		} else if (arg === "--no-lsp") {
			result.noLsp = true;
		} else if (arg === "--no-pty") {
			result.noPty = true;
		} else if (arg === "--hide-thinking") {
			result.hideThinking = true;
		} else if (arg === "--advisor") {
			result.advisor = true;
		} else if (arg === "--external-thinking") {
			result.externalThinking = true;
		} else if (arg === "--prewalk") {
			result.prewalk = true;
		} else if (arg === "--no-prewalk") {
			result.noPrewalk = true;
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg === "--print-thoughts") {
			result.printThoughts = true;
		} else if (arg === "--no-extensions") {
			result.noExtensions = true;
		} else if (arg === "--no-skills") {
			result.noSkills = true;
		} else if (arg === "--no-rules") {
			result.noRules = true;
		} else if (arg === "--no-title") {
			result.noTitle = true;
		} else if (arg.startsWith("@")) {
			let filePath = arg.slice(1);
			if (filePath.startsWith('"') && filePath.endsWith('"') && filePath.length > 1) {
				filePath = filePath.slice(1, -1);
			} else if (filePath.startsWith("'") && filePath.endsWith("'") && filePath.length > 1) {
				filePath = filePath.slice(1, -1);
			}
			result.fileArgs.push(filePath);
		} else if (!arg.startsWith("-") || arg === "-") {
			result.messages.push(arg);
		} else if (arg === "--") {
			sawSeparator = true;
		} else {
			result.unrecognizedFlags.push(arg);
		}

		if (equalsValueIndex !== -1 && i === flagIndex) {
			args.splice(equalsValueIndex, 1);
		}
	}

	const swallowedTrustedFlag = [...(result.extensions ?? []), ...(result.hooks ?? [])].some(
		value => value === "--trusted-extension" || value.startsWith("--trusted-extension="),
	);
	if ((result.trustedExtensions?.length ?? 0) !== trustedFlagCount || swallowedTrustedFlag) {
		throw new CliUsageError("--trusted-extension requires a non-empty, non-flag value");
	}
	if (trustedFlagCount > 0 && ((result.extensions?.length ?? 0) > 0 || (result.hooks?.length ?? 0) > 0)) {
		throw new CliUsageError("--trusted-extension cannot be combined with --extension, -e, or --hook");
	}
	for (const trustedPath of result.trustedExtensions ?? []) {
		if (trustedPath.length === 0) {
			throw new CliUsageError("--trusted-extension requires a non-empty, non-flag value");
		}
		if (!path.isAbsolute(trustedPath)) {
			throw new CliUsageError(`--trusted-extension requires an absolute path: ${trustedPath}`);
		}
	}

	return result;
}

export function validateToolNames(requested: readonly string[] | undefined, known: readonly string[]): void {
	if (!requested) return;
	const knownNames = new Set(known);
	const unknown = requested.filter(name => !knownNames.has(name));
	if (unknown.length === 0) return;
	throw new CliUsageError(
		`Unknown tool${unknown.length === 1 ? "" : "s"} in --tools: ${unknown.join(", ")}. Valid tools: ${known.join(", ")}.`,
	);
}

export function reportUnrecognizedFlags(
	args: Pick<Args, "unrecognizedFlags">,
	write: (text: string) => void = text => process.stderr.write(text),
): boolean {
	if (args.unrecognizedFlags.length === 0) return false;
	const flags = args.unrecognizedFlags;
	const plural = flags.length === 1 ? "" : "s";
	write(`${chalk.red(`Error: unknown flag${plural}: ${flags.join(", ")}`)}\n`);
	write(`Run \`${BINARY_NAME} --help\` for available flags.\n`);
	return true;
}

export function reportCliUsageError(
	error: unknown,
	write: (text: string) => void = text => process.stderr.write(text),
): boolean {
	if (!(error instanceof CliUsageError)) return false;
	write(`${chalk.red(`Error: ${error.message}`)}\n`);
	write(`Run \`${BINARY_NAME} --help\` for available flags.\n`);
	return true;
}

export function printHelp(): void {
	process.stdout.write(
		`${chalk.bold(BINARY_NAME)} - AI coding assistant\n\n` +
			`Run ${BINARY_NAME} --help for full command and option details.\n` +
			`Run ${BINARY_NAME} <command> --help for command-specific help.\n\n` +
			`${getExtraHelpText()}\n`,
	);
}
