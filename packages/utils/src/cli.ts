import * as fs from "node:fs";
import { parseArgs as nodeParseArgs } from "node:util";

function startupMarker(text: string): void {
	if (!process.env.PI_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {}
}

/**
 * `node:util.parseArgs` has no notion of negative numbers: it reads `-42` as a short-option cluster
 * and `--days -5` as a missing option argument. Every token that can only be a number is swapped for
 * an opaque placeholder before parsing and restored afterwards, so values and positionals keep the
 * form the user typed without needing `--`.
 */
const NEGATIVE_NUMBER = /^-(?:\d+(?:\.\d+)?|\.\d+)$/;
const NEGATIVE_PLACEHOLDER = (index: number) => `\u0000neg${index}\u0000`;

function maskNegativeNumbers(
	argv: string[],
	shorts: ReadonlySet<string>,
): { argv: string[]; restore: Map<string, string> } {
	const restore = new Map<string, string>();
	let afterDoubleDash = false;
	const masked = argv.map((token, index) => {
		if (afterDoubleDash) return token;
		if (token === "--") {
			afterDoubleDash = true;
			return token;
		}
		if (!NEGATIVE_NUMBER.test(token)) return token;
		// A digit declared as a short flag still wins: `-1` stays the flag it was defined as.
		if (shorts.has(token.slice(1, 2))) return token;
		const placeholder = NEGATIVE_PLACEHOLDER(index);
		restore.set(placeholder, token);
		return placeholder;
	});
	return { argv: masked, restore };
}

function unmaskNegativeNumbers<T>(value: T, restore: Map<string, string>): T {
	if (restore.size === 0) return value;
	if (typeof value === "string") return (restore.get(value) ?? value) as T;
	if (Array.isArray(value)) return value.map(item => unmaskNegativeNumbers(item, restore)) as T;
	return value;
}

/** The offending token as the user typed it: Node reports `4` for the cluster `-42`. */
function findUnknownOptionToken(
	argv: string[],
	known: ReadonlySet<string>,
	shorts: ReadonlySet<string>,
): string | undefined {
	for (const token of argv) {
		if (token === "--") return undefined;
		if (!token.startsWith("-") || token === "-") continue;
		if (token.startsWith("--")) {
			const name = token.slice(2).split("=", 1)[0] ?? "";
			if (!known.has(name)) return token;
			continue;
		}
		const cluster = token.slice(1);
		if ([...cluster].some(char => !shorts.has(char))) return token;
	}
	return undefined;
}

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export interface FlagDescriptor<K extends "string" | "boolean" | "integer" = "string" | "boolean" | "integer"> {
	kind: K;
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
}

export interface ArgDescriptor {
	kind: "string";
	description?: string;
	required?: boolean;
	multiple?: boolean;
	options?: readonly string[];
}

interface FlagInput {
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
}

interface ArgInput {
	description?: string;
	required?: boolean;
	multiple?: boolean;
	options?: readonly string[];
}

export const Flags = {
	string<T extends FlagInput>(opts?: T): FlagDescriptor<"string"> & T {
		return { kind: "string" as const, ...opts } as FlagDescriptor<"string"> & T;
	},
	boolean<T extends FlagInput>(opts?: T): FlagDescriptor<"boolean"> & T {
		return { kind: "boolean" as const, ...opts } as FlagDescriptor<"boolean"> & T;
	},
	integer<T extends FlagInput & { default?: number }>(opts?: T): FlagDescriptor<"integer"> & T {
		return { kind: "integer" as const, ...opts } as FlagDescriptor<"integer"> & T;
	},
};

export const Args = {
	string<T extends ArgInput>(opts?: T): ArgDescriptor & T {
		return { kind: "string" as const, ...opts } as ArgDescriptor & T;
	},
};

type FlagValue<D extends FlagDescriptor> = D["kind"] extends "boolean"
	? D extends { default: boolean }
		? boolean
		: boolean | undefined
	: D["kind"] extends "integer"
		? D extends { default: number }
			? number
			: number | undefined
		: D extends { multiple: true }
			? string[] | undefined
			: string | undefined;

type ArgValue<D extends ArgDescriptor> = D extends { multiple: true } ? string[] | undefined : string | undefined;

type FlagValues<T extends Record<string, FlagDescriptor>> = { [K in keyof T]: FlagValue<T[K]> };
type ArgValues<T extends Record<string, ArgDescriptor>> = { [K in keyof T]: ArgValue<T[K]> };

export interface ParseOutput<
	F extends Record<string, FlagDescriptor> = Record<string, FlagDescriptor>,
	A extends Record<string, ArgDescriptor> = Record<string, ArgDescriptor>,
> {
	flags: FlagValues<F>;
	args: ArgValues<A>;
	argv: string[];
}

export interface CommandMetadata {
	description?: string;
	hidden?: boolean;
	flags?: Record<string, FlagDescriptor>;
	args?: Record<string, ArgDescriptor>;
	examples?: string[];
}

export interface CommandCtor extends CommandMetadata {
	new (argv: string[], config: CliConfig): Command;
	strict?: boolean;
	aliases?: string[];
}

export interface CliConfig<TCommand extends CommandMetadata = CommandCtor> {
	bin: string;
	version: string;

	commands: Map<string, TCommand>;
}

export abstract class Command {
	argv: string[];
	config: CliConfig;

	constructor(argv: string[], config: CliConfig) {
		this.argv = argv;
		this.config = config;
	}

	abstract run(): Promise<void>;

	async parse<C extends CommandCtor>(
		_Cmd: C,
	): Promise<
		ParseOutput<
			NonNullable<C["flags"]> extends Record<string, FlagDescriptor>
				? NonNullable<C["flags"]>
				: Record<string, FlagDescriptor>,
			NonNullable<C["args"]> extends Record<string, ArgDescriptor>
				? NonNullable<C["args"]>
				: Record<string, ArgDescriptor>
		>
	> {
		const Cmd = _Cmd as CommandCtor;
		const flagDefs = (Cmd.flags ?? {}) as Record<string, FlagDescriptor>;
		const argDefs = (Cmd.args ?? {}) as Record<string, ArgDescriptor>;
		const strict = Cmd.strict !== false;

		const options: Record<
			string,
			{ type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean }
		> = {};
		for (const [name, desc] of Object.entries(flagDefs)) {
			const opt: (typeof options)[string] = {
				type: desc.kind === "boolean" ? "boolean" : "string",
			};
			if (desc.char) opt.short = desc.char;
			if (desc.multiple) opt.multiple = true;
			if (desc.default !== undefined) {
				opt.default = desc.kind === "boolean" ? Boolean(desc.default) : String(desc.default);
			}
			options[name] = opt;
		}

		const shorts = new Set(
			Object.values(options)
				.map(option => option.short)
				.filter((short): short is string => short !== undefined),
		);
		const masked = maskNegativeNumbers(this.argv, shorts);

		const { values: rawValues, positionals } = (() => {
			try {
				return nodeParseArgs({
					args: masked.argv,
					options,
					allowPositionals: true,
					strict,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const unknown =
					(error as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
						? findUnknownOptionToken(masked.argv, new Set(Object.keys(options)), shorts)
						: undefined;
				if (unknown === undefined) throw new CliUsageError(message);
				// Node names the cluster character and mis-quotes it in its own suggestion; quote the
				// token the user actually typed, so following the advice literally does the right thing.
				const command = [this.config.bin, ...this.config.commands.keys()].join(" ");
				const rest = this.argv.filter(token => token !== unknown && token !== "--");
				throw new CliUsageError(
					`Unknown option '${unknown}'. If it is a value and not a flag, pass it after '--':\n  ${command} ${[...rest, "--", JSON.stringify(unknown)].join(" ")}`,
				);
			}
		})();
		for (const key of Object.keys(rawValues)) {
			rawValues[key] = unmaskNegativeNumbers(rawValues[key], masked.restore);
		}
		const restoredPositionals = positionals.map(value => unmaskNegativeNumbers(value, masked.restore));

		const flags: Record<string, unknown> = {};
		for (const [name, desc] of Object.entries(flagDefs)) {
			const raw = rawValues[name];
			if (desc.kind === "integer") {
				if (raw === undefined || typeof raw === "boolean") {
					flags[name] = desc.default ?? undefined;
				} else {
					const n = Number.parseInt(raw as string, 10);
					if (Number.isNaN(n)) {
						throw new CliUsageError(`Expected integer for --${name}, got "${raw}"`);
					}
					flags[name] = n;
				}
			} else if (desc.kind === "boolean") {
				flags[name] =
					raw !== undefined ? Boolean(raw) : desc.default !== undefined ? Boolean(desc.default) : undefined;
			} else {
				const val = raw !== undefined && typeof raw !== "boolean" ? raw : (desc.default ?? undefined);

				if (val !== undefined && desc.options && !Array.isArray(val)) {
					if (!desc.options.includes(val as string)) {
						throw new CliUsageError(
							`Expected --${name} to be one of: ${[...desc.options].join(", ")}; got "${val}"`,
						);
					}
				}
				flags[name] = val;
			}

			if (desc.required && flags[name] === undefined) {
				throw new CliUsageError(`Missing required flag: --${name}`);
			}
		}

		const args: Record<string, unknown> = {};
		let posIdx = 0;
		for (const [argName, desc] of Object.entries(argDefs)) {
			if (desc.multiple) {
				const val = restoredPositionals.slice(posIdx);
				args[argName] = val.length > 0 ? val : undefined;
				posIdx = restoredPositionals.length;
			} else {
				const val = restoredPositionals[posIdx];
				args[argName] = val;
				posIdx++;
			}

			if (desc.required && args[argName] === undefined) {
				throw new CliUsageError(`Missing required argument: ${argName}`);
			}

			const argVal = args[argName];
			if (argVal !== undefined && desc.options && typeof argVal === "string") {
				if (!desc.options.includes(argVal)) {
					throw new CliUsageError(
						`Expected ${argName} to be one of: ${[...desc.options].join(", ")}; got "${argVal}"`,
					);
				}
			}
		}

		// Positionals past the declared arguments used to vanish, so `models find a b c` searched for
		// "a" and reported success. A command that wants the tail declares a `multiple` arg or opts
		// out with `strict = false`.
		if (strict && posIdx < restoredPositionals.length) {
			const extra = restoredPositionals.slice(posIdx);
			throw new CliUsageError(
				`Unexpected argument${extra.length === 1 ? "" : "s"}: ${extra.map(value => JSON.stringify(value)).join(", ")}`,
			);
		}

		return { flags, args, argv: restoredPositionals } as never;
	}
}

export function renderRootHelp(config: CliConfig<CommandMetadata>): void {
	const { bin, version, commands } = config;
	const lines: string[] = [];
	lines.push(`${bin} v${version}\n`);
	lines.push("USAGE");
	lines.push(`  $ ${bin} [COMMAND]\n`);

	const defaultCmd = [...commands.values()].find(command => command.hidden);
	if (defaultCmd) {
		renderCommandBody(lines, defaultCmd);
	}

	const visible = [...commands.entries()].filter(([, C]) => !C.hidden);
	if (visible.length > 0) {
		lines.push("COMMANDS");
		const maxLen = Math.max(...visible.map(([n]) => n.length));
		for (const [name, command] of visible.sort((a, b) => a[0].localeCompare(b[0]))) {
			lines.push(`  ${name.padEnd(maxLen + 2)}${command.description ?? ""}`);
		}
		lines.push("");
	}

	process.stdout.write(lines.join("\n"));
}

function formatUsageArgs(Cmd: CommandMetadata): string {
	const entries = Object.entries(Cmd.args ?? {});
	if (entries.length === 0) return "";
	const parts = entries.map(([name, desc]) => {
		const label = `${name.toUpperCase()}${desc.multiple ? "..." : ""}`;
		return desc.required ? label : `[${label}]`;
	});
	return ` ${parts.join(" ")}`;
}

export function commandUsageLine(bin: string, id: string, Cmd: CommandMetadata): string {
	const hasFlags = Object.keys(Cmd.flags ?? {}).length > 0;
	return `$ ${bin} ${id}${formatUsageArgs(Cmd)}${hasFlags ? " [FLAGS]" : ""}`;
}

export function renderCommandHelp(bin: string, id: string, Cmd: CommandMetadata): void {
	const lines: string[] = [];
	if (Cmd.description) lines.push(`${Cmd.description}\n`);
	lines.push("USAGE");
	lines.push(`  ${commandUsageLine(bin, id, Cmd)}\n`);
	renderCommandBody(lines, Cmd);
	process.stdout.write(lines.join("\n"));
}

function renderCommandBody(lines: string[], command: CommandMetadata): void {
	const argDefs = command.args ?? {};
	const flagDefs = command.flags ?? {};

	const argEntries = Object.entries(argDefs);
	if (argEntries.length > 0) {
		lines.push("ARGUMENTS");
		const maxLen = Math.max(...argEntries.map(([n]) => n.length));
		for (const [name, desc] of argEntries) {
			const parts = [name.toUpperCase().padEnd(maxLen + 2)];
			if (desc.description) parts.push(desc.description);
			if (desc.options) parts.push(`(${[...desc.options].join("|")})`);
			lines.push(`  ${parts.join(" ")}`);
		}
		lines.push("");
	}

	const flagEntries = Object.entries(flagDefs);
	if (flagEntries.length > 0) {
		lines.push("FLAGS");
		const formatted: [string, string][] = [];
		for (const [name, desc] of flagEntries) {
			const charPart = desc.char ? `-${desc.char}, ` : "    ";
			const namePart = `--${name}`;
			const typePart = desc.kind === "boolean" ? "" : desc.kind === "integer" ? "=<int>" : "=<value>";
			formatted.push([`  ${charPart}${namePart}${typePart}`, desc.description ?? ""]);
		}
		const maxLeft = Math.max(...formatted.map(([l]) => l.length));
		for (const [left, right] of formatted) {
			lines.push(`${left.padEnd(maxLeft + 2)}${right}`);
		}
		lines.push("");
	}

	if (command.examples && command.examples.length > 0) {
		lines.push("EXAMPLES");
		for (const ex of command.examples) {
			for (const line of ex.split("\n")) {
				lines.push(`  ${line}`);
			}
		}
		lines.push("");
	}
}

export interface CommandEntry {
	name: string;
	load: () => Promise<CommandCtor>;
	help?: CommandMetadata;
	aliases?: string[];
}

export interface RunOptions {
	bin: string;
	version: string;
	argv: string[];
	commands: CommandEntry[];

	help?: (config: CliConfig) => Promise<void> | void;

	metadataHelp?: (config: CliConfig<CommandMetadata>) => Promise<void> | void;

	/**
	 * Name of the command that backs a bare invocation. `<bin> <rootCommand> --version` answers from
	 * here instead of loading the command, which otherwise pulls in the whole runtime graph.
	 */
	rootCommand?: string;
}

function findEntry(commands: CommandEntry[], id: string): CommandEntry | undefined {
	return commands.find(e => e.name === id) ?? commands.find(e => e.aliases?.includes(id));
}

/** Env var that turns the user-facing error report back into a full stack trace. */
const DEBUG_ERRORS_ENV = "PI_DEBUG_ERRORS";

/**
 * Render a thrown value the way a CLI user needs it: the message first, the cause chain under it,
 * and the stack only when `PI_DEBUG_ERRORS` is set.
 */
export function formatCliError(error: unknown): string {
	if (!(error instanceof Error)) return `error: ${String(error)}\n`;
	const lines = [`error: ${error.message || error.name}`];
	const seen = new Set<unknown>([error]);
	let cause: unknown = error.cause;
	while (cause instanceof Error && !seen.has(cause)) {
		seen.add(cause);
		lines.push(`  caused by: ${cause.message || cause.name}`);
		cause = cause.cause;
	}
	if (process.env[DEBUG_ERRORS_ENV] && error.stack) {
		lines.push(error.stack);
	} else {
		lines.push(`Run with ${DEBUG_ERRORS_ENV}=1 for a stack trace.`);
	}
	return `${lines.join("\n")}\n`;
}

export async function run(opts: RunOptions): Promise<void> {
	const { bin, version, argv } = opts;

	const commandId = argv[0] ?? "";
	const commandArgv = argv.slice(1);

	if (commandId === "--help" || commandId === "-h" || commandId === "help" || commandId === "") {
		if (opts.help) {
			await opts.help(await loadAllCommands(opts));
		} else {
			const config = await loadAllCommandMetadata(opts);
			if (opts.metadataHelp) {
				await opts.metadataHelp(config);
			} else {
				renderRootHelp(config);
			}
		}
		return;
	}

	if (commandId === "--version" || commandId === "-v") {
		process.stdout.write(`${bin}/${version}\n`);
		return;
	}

	if (
		opts.rootCommand !== undefined &&
		commandId === opts.rootCommand &&
		(commandArgv.includes("--version") || commandArgv.includes("-v"))
	) {
		process.stdout.write(`${version}\n`);
		return;
	}

	if (commandArgv.includes("--help") || commandArgv.includes("-h")) {
		const entry = findEntry(opts.commands, commandId);
		if (entry) {
			const metadata = entry.help ?? (await loadEntry(entry));
			renderCommandHelp(bin, entry.name, metadata);
		} else {
			process.stderr.write(`Unknown command: ${commandId}\n`);
		}
		return;
	}

	const entry = findEntry(opts.commands, commandId);

	if (!entry) {
		process.stderr.write(`Error: command ${commandId} not found\n`);
		process.exitCode = 1;
		return;
	}

	const Cmd = await loadEntry(entry);
	const config: CliConfig = { bin, version, commands: new Map([[entry.name, Cmd]]) };
	const instance = new Cmd(commandArgv, config);
	try {
		await instance.run();
	} catch (error) {
		if (error instanceof CliUsageError) {
			process.stderr.write(`error: ${error.message}\n\n`);
			process.stderr.write(`USAGE\n  ${commandUsageLine(bin, entry.name, Cmd)}\n`);
			process.stderr.write(`\nRun \`${bin} ${entry.name} --help\` for details.\n`);
			process.exitCode = 1;
			return;
		}
		// Anything else is a failure the user still has to read: report it as a message, never as a
		// source dump from the default handler.
		process.stderr.write(formatCliError(error));
		process.exitCode = 1;
	}
}

async function loadEntry(entry: CommandEntry): Promise<CommandCtor> {
	startupMarker(`cli:load:${entry.name}:start`);
	const Cmd = await entry.load();
	startupMarker(`cli:load:${entry.name}:done`);
	return Cmd;
}

async function loadAllCommands(opts: RunOptions): Promise<CliConfig> {
	const loaded = await Promise.all(opts.commands.map(async entry => [entry.name, await loadEntry(entry)] as const));
	return { bin: opts.bin, version: opts.version, commands: new Map(loaded) };
}

async function loadAllCommandMetadata(opts: RunOptions): Promise<CliConfig<CommandMetadata>> {
	const loaded = await Promise.all(
		opts.commands.map(async entry => [entry.name, entry.help ?? (await loadEntry(entry))] as const),
	);
	return { bin: opts.bin, version: opts.version, commands: new Map(loaded) };
}
