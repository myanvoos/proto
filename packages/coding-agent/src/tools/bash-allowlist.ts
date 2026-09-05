import { withoutLeadingEnvironmentAssignments } from "./bash-interceptor";
import { extractFlatShellCommandSegments } from "./shell-tokenize";

/**
 * Exploratory, read-only programs a restricted bash (the conductor's commissioning turn) may run. Every other
 * program is rejected outright.
 */
export const READ_ONLY_EXPLORATORY_COMMANDS: readonly string[] = [
	"cat",
	"cd",
	"du",
	"fd",
	"file",
	"find",
	"grep",
	"head",
	"ls",
	"rg",
	"stat",
	"tail",
	"tree",
	"wc",
];

/**
 * Flags that turn otherwise read-only exploratory programs into file-mutating or code-executing ones
 * (`find -delete`, `fd --exec`, `rg --pre`, ...). An allowlisted program carrying one of these is rejected;
 * long flags are also matched in their `--flag=value` form.
 */
const DENIED_FLAGS: Record<string, readonly string[]> = {
	fd: ["-X", "-x", "--exec", "--exec-batch"],
	find: ["-delete", "-exec", "-execdir", "-fls", "-fprint", "-fprint0", "-fprintf", "-ok", "-okdir"],
	rg: ["--pre", "--pre-glob"],
};

export interface BashAllowlistVerdict {
	allowed: boolean;
	reason?: string;
}

function stripQuotes(word: string): string {
	if (word.length >= 2 && ((word[0] === '"' && word.at(-1) === '"') || (word[0] === "'" && word.at(-1) === "'"))) {
		return word.slice(1, -1);
	}
	return word;
}

/**
 * Scans outside quotes for output redirections. Descriptor dups (`2>&1`, `>&2`) and input redirects are fine;
 * any write redirect must target `/dev/null`. Substitutions and heredocs are refused upstream by the segment
 * tokenizer, so plain scanning is sufficient here.
 */
function forbiddenOutputRedirect(command: string): string | null {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") i++;
			else if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch !== ">") continue;
		if (command[i + 1] === "&") {
			i++;
			continue;
		}
		if (command[i + 1] === "<") return "`<>` redirection opens the target for writing";
		let j = i + (command[i + 1] === ">" ? 2 : 1);
		while (command[j] === " " || command[j] === "\t") j++;
		let target = "";
		while (j < command.length && !/[ \t\n;&|<>]/.test(command[j])) {
			target += command[j];
			j++;
		}
		if (stripQuotes(target) !== "/dev/null") {
			return `output redirection to '${target || command.slice(i + 1, i + 12)}' writes to the filesystem`;
		}
		i = j - 1;
	}
	return null;
}

/**
 * Enforces a read-only command allowlist: every shell segment must be one of `allowlist` (after leading
 * environment assignments), must not carry a mutation/exec flag, and the command must not write via output
 * redirection. Unparseable commands fail closed.
 */
export function checkBashCommandAllowlist(command: string, allowlist: readonly string[]): BashAllowlistVerdict {
	const redirect = forbiddenOutputRedirect(command);
	if (redirect) return { allowed: false, reason: `Blocked by read-only policy: ${redirect}` };

	const segments = extractFlatShellCommandSegments(command);
	if (segments.length === 0) {
		return {
			allowed: false,
			reason:
				"Blocked by read-only policy: command could not be parsed into plain segments (substitutions, grouping, and heredocs are not allowed)",
		};
	}

	const allowed = new Set(allowlist);
	for (const segment of segments) {
		const text = withoutLeadingEnvironmentAssignments(segment.text) ?? segment.text;
		const words = text.split(/[ \t\n]+/).filter(Boolean);
		if (words.length === 0) continue;
		const program = stripQuotes(words[0]);
		if (program.includes("/") || !allowed.has(program)) {
			return {
				allowed: false,
				reason: `Blocked by read-only policy: '${program}' is not an allowlisted command. Allowed: ${allowlist.join(", ")}`,
			};
		}
		const denied = DENIED_FLAGS[program];
		if (!denied) continue;
		for (const word of words.slice(1)) {
			if (denied.includes(word) || (word.startsWith("--") && denied.some(flag => word.startsWith(`${flag}=`)))) {
				return { allowed: false, reason: `Blocked by read-only policy: '${program}' may not use '${word}'` };
			}
		}
	}
	return { allowed: true };
}

/** A command guard installed by a host for a bounded bash turn. */
export type BashCommandPolicy = (command: string) => BashAllowlistVerdict;

/**
 * Allows exact single-command entries from a commissioned Verification section, plus the normal read-only grant.
 * Exact matching prevents a model from appending a second command to an approved test command.
 */
export function checkBashVerificationCommand(
	command: string,
	verificationCommands: readonly string[],
): BashAllowlistVerdict {
	const exploratory = checkBashCommandAllowlist(command, READ_ONLY_EXPLORATORY_COMMANDS);
	if (exploratory.allowed) return exploratory;
	const normalized = command.trim();
	if (!verificationCommands.some(expected => expected.trim() === normalized)) {
		return {
			allowed: false,
			reason: "Blocked by verification policy: command is not an exact commissioned verification command.",
		};
	}
	if (forbiddenOutputRedirect(command)) {
		return { allowed: false, reason: "Blocked by verification policy: output redirection is not allowed." };
	}
	const segments = extractFlatShellCommandSegments(command);
	if (segments.length !== 1) {
		return {
			allowed: false,
			reason: "Blocked by verification policy: shell chaining, pipes, substitutions, and grouping are not allowed.",
		};
	}
	const text = withoutLeadingEnvironmentAssignments(segments[0]!.text) ?? segments[0]!.text;
	const program = stripQuotes(text.split(/[ \t\n]+/).filter(Boolean)[0] ?? "");
	if (!program || program.includes("/")) {
		return { allowed: false, reason: "Blocked by verification policy: path-qualified commands are not allowed." };
	}
	return { allowed: true };
}
