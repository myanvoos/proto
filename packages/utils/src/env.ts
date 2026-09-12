import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, refreshDirsFromEnv } from "./dirs";

export * from "./worker-host";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SESSION_BRIDGE_ENV_NAMES = new Set([
	"PI_ARTIFACTS_DIR",
	"PI_EVAL_LOCAL_ROOTS",
	"PI_KERNEL_BRIDGE_ADDR",
	"PI_KERNEL_BRIDGE_TOKEN",
	"PI_KERNEL_FLEET_ROOT",
	"PI_SESSION_FILE",
	"PI_TOOL_BRIDGE_SESSION",
	"PI_TOOL_BRIDGE_TOKEN",
	"PI_TOOL_BRIDGE_URL",
]);

export function isSessionBridgeEnvName(name: string): boolean {
	return SESSION_BRIDGE_ENV_NAMES.has(name);
}

export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function isMacosMallocStackLoggingEnvName(name: string): boolean {
	return name === "MallocStackLogging" || name === "MallocStackLoggingNoCompact";
}

export function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (
			!isSafeEnvName(key) ||
			isMacosMallocStackLoggingEnvName(key) ||
			value === undefined ||
			!isSafeEnvValue(value)
		) {
			continue;
		}
		result[key] = value;
	}
	return result;
}

function readLaunchEnv(): ReadonlyMap<string, string> | undefined {
	if (process.platform === "linux") {
		try {
			const values = new Map<string, string>();
			for (const entry of fs.readFileSync("/proc/self/environ", "utf8").split("\0")) {
				const separator = entry.indexOf("=");
				if (separator > 0) values.set(entry.slice(0, separator), entry.slice(separator + 1));
			}
			return values;
		} catch {}
	}
	if (!process.execArgv.includes("--no-env-file")) return undefined;
	const values = new Map<string, string>();
	for (const key in Bun.env) {
		const value = Bun.env[key];
		if (value !== undefined) values.set(key, value);
	}
	return values;
}

const launchEnvValues = readLaunchEnv();
const projectEnvNamesLoadedByOmp = new Set<string>();

function expandDotenvValues(values: Record<string, string>, env: Record<string, string>): Record<string, string> {
	const expanded: Record<string, string> = {};
	for (const key in values) {
		expanded[key] = values[key].replace(
			/(\\)?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
			(match, escaped: string | undefined, braced: string | undefined, bare: string | undefined) => {
				if (escaped) return match.slice(1);
				const name = braced ?? bare;
				if (!name) return match;
				return env[name] ?? expanded[name] ?? "";
			},
		);
	}
	return expanded;
}

export function filterChildShellEnv(
	env: Record<string, string | undefined>,
	cwd: string = process.cwd(),
): Record<string, string> {
	const runtimeLaunchEnvValues = env === Bun.env || env === process.env ? launchEnvValues : undefined;
	const result = filterProcessEnv(env);
	for (const name of SESSION_BRIDGE_ENV_NAMES) delete result[name];
	const projectEnv = parseEnvFile(path.join(cwd, ".env"));
	const launchNodeEnv = runtimeLaunchEnvValues ? runtimeLaunchEnvValues.get("NODE_ENV") : env.NODE_ENV;
	const nodeEnvName = `.env.${launchNodeEnv || "development"}`;
	const modeEnv = parseEnvFile(path.join(cwd, nodeEnvName));
	const localEnv = parseEnvFile(path.join(cwd, ".env.local"));
	const modeLocalEnv = parseEnvFile(path.join(cwd, `${nodeEnvName}.local`));
	const launchEnv = { ...projectEnv, ...modeEnv, ...localEnv, ...modeLocalEnv };
	const expandedLaunchEnv = {
		...expandDotenvValues(projectEnv, result),
		...expandDotenvValues(modeEnv, result),
		...expandDotenvValues(localEnv, result),
		...expandDotenvValues(modeLocalEnv, result),
	};
	let fallbackLaunchEnv: Record<string, string> | undefined;
	let expandedFallbackLaunchEnv: Record<string, string> | undefined;
	if (!runtimeLaunchEnvValues && nodeEnvName !== ".env.development") {
		const fallbackModeEnv = parseEnvFile(path.join(cwd, ".env.development"));
		const fallbackModeLocalEnv = parseEnvFile(path.join(cwd, ".env.development.local"));
		const candidate = { ...projectEnv, ...fallbackModeEnv, ...localEnv, ...fallbackModeLocalEnv };
		const expandedCandidate = {
			...expandDotenvValues(projectEnv, result),
			...expandDotenvValues(fallbackModeEnv, result),
			...expandDotenvValues(localEnv, result),
			...expandDotenvValues(fallbackModeLocalEnv, result),
		};
		if (candidate.NODE_ENV === env.NODE_ENV || expandedCandidate.NODE_ENV === env.NODE_ENV) {
			fallbackLaunchEnv = candidate;
			expandedFallbackLaunchEnv = expandedCandidate;
		}
	}
	const allLaunchEnv = fallbackLaunchEnv ? { ...launchEnv, ...fallbackLaunchEnv } : launchEnv;
	for (const key in allLaunchEnv) {
		const launchValue = runtimeLaunchEnvValues?.get(key);
		if (launchValue !== undefined) {
			if (
				result[key] !== launchValue &&
				(result[key] === launchEnv[key] ||
					result[key] === expandedLaunchEnv[key] ||
					result[key] === fallbackLaunchEnv?.[key] ||
					result[key] === expandedFallbackLaunchEnv?.[key])
			) {
				result[key] = launchValue;
			}
			continue;
		}
		if (runtimeLaunchEnvValues || projectEnvNamesLoadedByOmp.has(key)) {
			delete result[key];
		} else if (
			result[key] === launchEnv[key] ||
			result[key] === expandedLaunchEnv[key] ||
			result[key] === fallbackLaunchEnv?.[key] ||
			result[key] === expandedFallbackLaunchEnv?.[key]
		) {
			delete result[key];
		}
	}
	return result;
}

function parseEnvLine(line: string): { key: string; value: string } | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;
	const eqIndex = trimmed.indexOf("=");
	if (eqIndex === -1) return undefined;
	let key = trimmed.slice(0, eqIndex).trim();
	const exported = key.match(/^export[ \t]+(.*)$/);
	if (exported) key = exported[1].trim();
	if (!isValidEnvName(key)) return undefined;
	const raw = trimmed.slice(eqIndex + 1).replace(/^[ \t]+/, "");
	const quote = raw[0];
	if (quote === '"' || quote === "'" || quote === "`") {
		let close = raw.indexOf(quote, 1);
		while (close !== -1 && raw[close - 1] === "\\") close = raw.indexOf(quote, close + 1);
		return { key, value: close === -1 ? raw.slice(1) : raw.slice(1, close) };
	}
	const commentIndex = raw.search(/[ \t]#/);
	return { key, value: (commentIndex === -1 ? raw : raw.slice(0, commentIndex)).trimEnd() };
}

export function parseEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const parsed = parseEnvLine(line);
			if (parsed && isSafeEnvValue(parsed.value)) result[parsed.key] = parsed.value;
		}
	} catch {}

	for (const k in result) {
		if (k.startsWith("PROTO_")) {
			result[`PI_${k.slice("PROTO_".length)}`] = result[k];
		}
	}

	return result;
}

const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
const piEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(process.cwd(), ".env"));

for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || isMacosMallocStackLoggingEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}

for (const file of [projectEnv, agentEnv, piEnv, homeEnv]) {
	for (const key in file) {
		if (!isMacosMallocStackLoggingEnvName(key) && !Bun.env[key]) {
			Bun.env[key] = file[key];
			if (file === projectEnv) projectEnvNamesLoadedByOmp.add(key);
		}
	}
}

refreshDirsFromEnv();

export const $env: Record<string, string> = Bun.env as Record<string, string>;

export function $pickenv(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = Bun.env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

export function $envExact(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const value = env[name];
	if (value === undefined) return undefined;

	for (const key in env) {
		if (key === name) return value;
	}
	return undefined;
}

export function $envpos(name: string, defaultValue: number): number {
	const raw = $env[name];
	if (!raw) return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
	return parsed;
}

const BUN_TEST_ENTRY_PATTERN = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

export function isBunTestRuntime(): boolean {
	if (Bun.env.PI_TEST_RUNTIME === "1") return true;
	const hasTestEnvironment = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	return hasTestEnvironment && BUN_TEST_ENTRY_PATTERN.test(Bun.main);
}

let terminalHeadless = isBunTestRuntime();

export function isTerminalHeadless(): boolean {
	return terminalHeadless;
}

export function setTerminalHeadless(headless: boolean): boolean {
	const previous = terminalHeadless;
	terminalHeadless = headless;
	return previous;
}

let interactiveHost = false;

export function isInteractiveHost(): boolean {
	return interactiveHost;
}

export function setInteractiveHost(interactive: boolean): boolean {
	const previous = interactiveHost;
	interactiveHost = interactive;
	return previous;
}

export function getDbBusyTimeoutMs(): number {
	return isInteractiveHost() ? 5000 : 1000;
}

export function isCompiledBinary(): boolean {
	if (process.env.PI_COMPILED || Bun.env.PI_COMPILED) return true;
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

const TRUTHY: Dict<boolean> = {
	"1": true,
	Y: true,
	y: true,
	TRUE: true,
	true: true,
	YES: true,
	yes: true,
	ON: true,
	on: true,
};

export function parseFlag(value: string | undefined, def = false): boolean {
	if (!value) return def;
	return TRUTHY[value] === true;
}

export function $flag(name: string, def: boolean = false): boolean {
	return parseFlag($env[name], def);
}
