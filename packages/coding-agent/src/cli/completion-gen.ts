import type { ArgDescriptor, CliConfig, CommandMetadata, FlagDescriptor } from "@oh-my-pi/pi-utils/cli";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin-names";

export type Shell = "bash" | "zsh" | "fish";

export type ValueSource =
	| { kind: "flag" }
	| { kind: "value" }
	| { kind: "enum"; values: readonly string[] }
	| { kind: "list"; values: readonly string[] }
	| { kind: "models"; multiple: boolean }
	| { kind: "sessions" }
	| { kind: "file" }
	| { kind: "dir" };

interface CompletionFlag {
	name: string;

	char?: string;
	description: string;
	value: ValueSource;

	repeatable: boolean;
}

interface CompletionArg {
	name: string;
	description: string;
	value: ValueSource;
}

interface CompletionCommand {
	name: string;
	aliases: readonly string[];
	description: string;
	flags: CompletionFlag[];
	args: CompletionArg[];
}

export interface CompletionSpec {
	bin: string;

	root: { flags: CompletionFlag[]; args: CompletionArg[] };
	commands: CompletionCommand[];
}

const MODEL_FLAGS: Record<string, true> = { model: true, smol: true, slow: true };

const SESSION_FLAGS: Record<string, true> = { resume: true, fork: true, session: true };

const DIR_FLAGS: Record<string, true> = { "session-dir": true, "plugin-dir": true };

function flagValue(name: string, desc: FlagDescriptor): ValueSource {
	if (desc.kind === "boolean") return { kind: "flag" };
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	if (MODEL_FLAGS[name]) return { kind: "models", multiple: false };
	if (name === "models") return { kind: "models", multiple: true };
	if (SESSION_FLAGS[name]) return { kind: "sessions" };
	if (name === "tools") return { kind: "list", values: BUILTIN_TOOL_NAMES };
	if (DIR_FLAGS[name]) return { kind: "dir" };
	if (desc.kind === "integer") return { kind: "value" };
	return { kind: "file" };
}

function argValue(desc: ArgDescriptor): ValueSource {
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	return { kind: "file" };
}

function buildFlags(command: CommandMetadata): CompletionFlag[] {
	const out: CompletionFlag[] = [];
	const flags = command.flags ?? {};
	for (const name in flags) {
		const desc = flags[name];
		out.push({
			name,
			char: desc.char,
			description: desc.description ?? "",
			value: flagValue(name, desc),
			repeatable: Boolean(desc.multiple),
		});
	}
	return out;
}

function buildArgs(command: CommandMetadata): CompletionArg[] {
	const out: CompletionArg[] = [];
	const args = command.args ?? {};
	for (const name in args) {
		const desc = args[name];
		out.push({ name, description: desc.description ?? "", value: argValue(desc) });
	}
	return out;
}

export function buildSpec(
	config: CliConfig,
	rootName: string,
	aliasMap: Map<string, readonly string[]>,
): CompletionSpec {
	const commands: CompletionCommand[] = [];
	let root: CompletionSpec["root"] = { flags: [], args: [] };
	for (const [name, Cmd] of config.commands) {
		const flags = buildFlags(Cmd);
		const args = buildArgs(Cmd);
		if (name === rootName) {
			root = { flags, args };
			continue;
		}
		if (Cmd.hidden) continue;
		commands.push({
			name,
			aliases: aliasMap.get(name) ?? [],
			description: Cmd.description ?? "",
			flags,
			args,
		});
	}
	commands.sort((a, b) => a.name.localeCompare(b.name));
	return { bin: config.bin, root, commands };
}

function takesValue(v: ValueSource): boolean {
	return v.kind !== "flag";
}

function commandTokens(c: CompletionCommand): string[] {
	return [c.name, ...c.aliases];
}

export function generateCompletion(shell: Shell, spec: CompletionSpec): string {
	switch (shell) {
		case "bash":
			return generateBash(spec);
		case "zsh":
			return generateZsh(spec);
		case "fish":
			return generateFish(spec);
	}
}

function bashWords(values: readonly string[]): string {
	return values.join(" ").replace(/"/g, '\\"');
}

function bashValueBranch(bin: string, v: ValueSource): string {
	switch (v.kind) {
		case "flag":
		case "value":
			return "return 0";
		case "enum":
			return `COMPREPLY=( $(compgen -W "${bashWords(v.values)}" -- "$cur") ); return 0`;
		case "list":
			return `_proto_comma "${bashWords(v.values)}"; return 0`;
		case "models":
			return v.multiple
				? `_proto_comma "$(command ${bin} __complete models 2>/dev/null | cut -f1)"; return 0`
				: `COMPREPLY=( $(compgen -W "$(command ${bin} __complete models -- "$cur" 2>/dev/null | cut -f1)" -- "$cur") ); return 0`;
		case "sessions":
			return `COMPREPLY=( $(compgen -W "$(command ${bin} __complete sessions -- "$cur" 2>/dev/null | cut -f1)" -- "$cur") ); return 0`;
		case "file":
			return `COMPREPLY=( $(compgen -f -- "$cur") ); compopt -o filenames; return 0`;
		case "dir":
			return `COMPREPLY=( $(compgen -d -- "$cur") ); compopt -o filenames; return 0`;
	}
}

function bashFlagCase(bin: string, flags: CompletionFlag[]): string {
	const lines: string[] = [];
	for (const f of flags) {
		if (!takesValue(f.value)) continue;
		const labels = [`--${f.name}`, ...(f.char ? [`-${f.char}`] : [])];
		lines.push(`\t\t${labels.join("|")})\n\t\t\t${bashValueBranch(bin, f.value)}\n\t\t\t;;`);
	}
	return lines.join("\n");
}

function bashFlagWords(flags: CompletionFlag[]): string {
	const words: string[] = [];
	for (const f of flags) {
		words.push(`--${f.name}`);
		if (f.char) words.push(`-${f.char}`);
	}
	return words.join(" ");
}

function generateBash(spec: CompletionSpec): string {
	const { bin } = spec;
	const parts: string[] = [];
	parts.push(`# bash completion for ${bin} — generated by \`${bin} completions bash\``);
	parts.push("");

	parts.push(`_proto_comma() {
	local words="$1" realcur prefix
	realcur="\${cur##*,}"
	prefix="\${cur%"$realcur"}"
	local -a matches
	matches=( $(compgen -W "$words" -- "$realcur") )
	local i
	for (( i=0; i < \${#matches[@]}; i++ )); do matches[i]="$prefix\${matches[i]}"; done
	COMPREPLY=( "\${matches[@]}" )
	compopt -o nospace 2>/dev/null
}`);
	parts.push("");

	const subTokens = spec.commands.flatMap(commandTokens).sort();
	parts.push(`_proto_root() {
	case "$prev" in
${bashFlagCase(bin, spec.root.flags)}
	esac
	if [[ "$cur" == -* ]]; then
		COMPREPLY=( $(compgen -W "${bashFlagWords(spec.root.flags)}" -- "$cur") )
	else
		COMPREPLY=( $(compgen -W "${bashWords(subTokens)} ${bashFlagWords(spec.root.flags)}" -- "$cur") )
	fi
}`);
	parts.push("");

	for (const c of spec.commands) {
		const argEnum = c.args.find(a => a.value.kind === "enum");
		const argWords = argEnum && argEnum.value.kind === "enum" ? bashWords(argEnum.value.values) : "";
		const fileArg = c.args.some(a => a.value.kind === "file");
		const elseBranch = argWords
			? `COMPREPLY=( $(compgen -W "${argWords}" -- "$cur") )`
			: fileArg
				? `COMPREPLY=( $(compgen -f -- "$cur") ); compopt -o filenames`
				: ":";
		parts.push(`_proto_cmd_${bashFn(c.name)}() {
	case "$prev" in
${bashFlagCase(bin, c.flags)}
	esac
	if [[ "$cur" == -* ]]; then
		COMPREPLY=( $(compgen -W "${bashFlagWords(c.flags)}" -- "$cur") )
	else
		${elseBranch}
	fi
}`);
		parts.push("");
	}

	const dispatch: string[] = [];
	for (const c of spec.commands) {
		dispatch.push(`\t\t${commandTokens(c).join("|")})\n\t\t\t_proto_cmd_${bashFn(c.name)}\n\t\t\t;;`);
	}
	parts.push(`_proto() {
	local cur prev cmd i
	cur="\${COMP_WORDS[COMP_CWORD]}"
	prev="\${COMP_WORDS[COMP_CWORD-1]}"
	cmd=""
	for (( i=1; i < COMP_CWORD; i++ )); do
		case "\${COMP_WORDS[i]}" in
			-*) ;;
			*) cmd="\${COMP_WORDS[i]}"; break ;;
		esac
	done
	case "$cmd" in
${dispatch.join("\n")}
		*) _proto_root ;;
	esac
}
complete -F _proto ${bin}`);
	parts.push("");
	return `${parts.join("\n")}\n`;
}

function bashFn(name: string): string {
	return name.replace(/[^A-Za-z0-9]/g, "_");
}

function zshDesc(s: string): string {
	return s
		.replace(/'/g, "’")
		.replace(/\[/g, "(")
		.replace(/\]/g, ")")
		.replace(/[\r\n]+/g, " ")
		.replace(/:/g, " ")
		.trim();
}

function zshAction(v: ValueSource): string {
	switch (v.kind) {
		case "flag":
			return "";
		case "value":
			return ":value:";
		case "enum":
			return `:value:(${v.values.join(" ")})`;
		case "list":
			return ":value:_proto_tools";
		case "models":
			return v.multiple ? ":models:_proto_models_list" : ":model:_proto_call models";
		case "sessions":
			return ":session:_proto_call sessions";
		case "file":
			return ":file:_files";
		case "dir":
			return ":dir:_files -/";
	}
}

function zshFlagSpec(f: CompletionFlag): string {
	const body = `[${zshDesc(f.description)}]${zshAction(f.value)}`;
	if (f.char && f.repeatable) return `'*'{-${f.char},--${f.name}}'${body}'`;
	if (f.char) return `'(-${f.char} --${f.name})'{-${f.char},--${f.name}}'${body}'`;
	if (f.repeatable) return `'*--${f.name}${body}'`;
	return `'--${f.name}${body}'`;
}

function zshArgSpec(f: CompletionArg): string {
	switch (f.value.kind) {
		case "enum":
			return `':${f.name}:(${f.value.values.join(" ")})'`;
		default:
			return `':${f.name}:_files'`;
	}
}

function generateZsh(spec: CompletionSpec): string {
	const { bin } = spec;

	const listFlag = [...spec.root.flags, ...spec.commands.flatMap(c => c.flags)].find(f => f.value.kind === "list");
	const toolNames = listFlag?.value.kind === "list" ? listFlag.value.values.join(" ") : "";
	const parts: string[] = [];
	parts.push(`#compdef ${bin}`);
	parts.push(`# zsh completion for ${bin} — generated by \`${bin} completions zsh\``);
	parts.push("");

	parts.push(`_proto_call() {
	local kind=$1
	local -a items
	local line
	for line in "\${(@f)$(command ${bin} __complete $kind -- "$PREFIX" 2>/dev/null)}"; do
		[[ -z $line ]] && continue
		items+=( "\${line//$'\\t'/:}" )
	done
	_describe -t "$kind" "$kind" items
}
_proto_models_list() {
	local -a items
	local line
	for line in "\${(@f)$(command ${bin} __complete models 2>/dev/null)}"; do
		[[ -z $line ]] && continue
		items+=( "\${line%%$'\\t'*}" )
	done
	_values -s , 'models' $items
}
_proto_tools() { _values -s , 'tools' ${toolNames} }`);
	parts.push("");

	const cmdRows = spec.commands.map(c => `\t\t'${c.name}:${zshDesc(c.description)}'`).join("\n");
	parts.push(`_proto_commands() {
	local -a commands
	commands=(
${cmdRows}
	)
	_describe -t commands 'command' commands
}`);
	parts.push("");

	for (const c of spec.commands) {
		const specs = ["'(-h --help)'{-h,--help}'[Show help]'", ...c.flags.map(zshFlagSpec), ...c.args.map(zshArgSpec)];
		parts.push(`_proto_cmd_${bashFn(c.name)}() {
	_arguments -s \\
		${specs.join(" \\\n\t\t")}
}`);
		parts.push("");
	}

	const aliasArms = spec.commands
		.map(c => `\t\t\t${commandTokens(c).join("|")}) _proto_cmd_${bashFn(c.name)} ;;`)
		.join("\n");
	const rootSpecs = [
		"'(-h --help)'{-h,--help}'[Show help]'",
		"'(-v --version)'{-v,--version}'[Show version]'",
		...spec.root.flags.map(zshFlagSpec),
		"'1: :_proto_commands'",
		"'*::arg:->args'",
	];
	parts.push(`_proto() {
	local curcontext="$curcontext" state line
	typeset -A opt_args
	_arguments -C -s \\
		${rootSpecs.join(" \\\n\t\t")}
	case $state in
		args)
			case $line[1] in
${aliasArms}
			esac
			;;
	esac
}
# Works both ways: autoloaded from $fpath (file named _proto) or eval'd from a
# startup file. When autoloaded, funcstack[1] is _proto and we invoke it; when
# sourced/eval'd we register it with compdef instead.
if [ "$funcstack[1]" = "_proto" ]; then
	_proto "$@"
else
	compdef _proto ${bin}
fi`);
	parts.push("");
	return `${parts.join("\n")}\n`;
}

function fishDesc(s: string): string {
	return s
		.replace(/'/g, "’")
		.replace(/[\r\n]+/g, " ")
		.trim();
}

function fishValue(bin: string, v: ValueSource): string {
	switch (v.kind) {
		case "flag":
			return "";
		case "value":
			return "-x";
		case "enum":
		case "list":
			return `-x -a '${v.values.join(" ")}'`;
		case "models":
			return `-x -a '(command ${bin} __complete models -- (commandline -ct))'`;
		case "sessions":
			return `-x -a '(command ${bin} __complete sessions -- (commandline -ct))'`;
		case "file":
			return "-r -F";
		case "dir":
			return "-x -a '(__fish_complete_directories (commandline -ct))'";
	}
}

function fishFlagLine(bin: string, cond: string, f: CompletionFlag): string {
	const segs = [`complete -c ${bin}`, `-n '${cond}'`];
	if (f.char) segs.push(`-s ${f.char}`);
	segs.push(`-l ${f.name}`);
	if (f.description) segs.push(`-d '${fishDesc(f.description)}'`);
	const val = fishValue(bin, f.value);
	if (val) segs.push(val);
	return segs.join(" ");
}

function generateFish(spec: CompletionSpec): string {
	const { bin } = spec;
	const lines: string[] = [];
	lines.push(`# fish completion for ${bin} — generated by \`${bin} completions fish\``);
	lines.push("");

	const allTokens = spec.commands.flatMap(commandTokens);
	lines.push(`function __fish_proto_no_subcommand`);
	lines.push(`\tfor i in (commandline -opc)`);
	lines.push(`\t\tif contains -- $i ${allTokens.join(" ")}`);
	lines.push(`\t\t\treturn 1`);
	lines.push(`\t\tend`);
	lines.push(`\tend`);
	lines.push(`\treturn 0`);
	lines.push(`end`);
	lines.push("");

	const rootCond = "__fish_proto_no_subcommand";

	for (const c of spec.commands) {
		for (const token of commandTokens(c)) {
			lines.push(`complete -c ${bin} -f -n '${rootCond}' -a '${token}' -d '${fishDesc(c.description)}'`);
		}
	}
	lines.push("");

	for (const f of spec.root.flags) {
		lines.push(fishFlagLine(bin, rootCond, f));
	}
	lines.push("");

	for (const c of spec.commands) {
		const cond = `__fish_seen_subcommand_from ${commandTokens(c).join(" ")}`;
		for (const f of c.flags) {
			lines.push(fishFlagLine(bin, cond, f));
		}

		const enumArgs = c.args.filter(a => a.value.kind === "enum");
		if (enumArgs.length > 0) {
			for (const a of enumArgs) {
				if (a.value.kind !== "enum") continue;
				lines.push(
					`complete -c ${bin} -f -n '${cond}' -a '${a.value.values.join(" ")}' -d '${fishDesc(a.description)}'`,
				);
			}
		} else if (c.args.some(a => a.value.kind === "file")) {
			lines.push(`complete -c ${bin} -F -n '${cond}'`);
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
