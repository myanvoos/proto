import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ContainedPathResolution, resolveContainedPath } from "../discovery/contained-path";
import type { Skill } from "../extensibility/skills";
import { type LocalProtocolOptions, resolveFleetUrlToPath, resolveLocalUrlToPath } from "../internal-urls";
import { validateRelativePath } from "../internal-urls/skill-protocol";
import type { InternalResource, ResolveContext } from "../internal-urls/types";
import type { ImageAttachmentEntry } from ".";
import { normalizeLocalScheme, splitInternalUrlSel } from "./path-utils";
import { ToolError } from "./tool-errors";

const INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL =
	/'(?:[a-z][a-z0-9+.-]*):\/\/[^'\s")`\\]*'|"(?:[a-z][a-z0-9+.-]*):\/\/[^"\s')`\\]*"|(?:[a-z][a-z0-9+.-]*):\/\/[^\s'")`\\;&|<>($]*|'local:\/[^'\s")`\\]*'|"local:\/[^"\s')`\\]*"|(?<![./\\\\\w-])local:\/[^\s'")`\\;&|<>($]*/gi;

interface InternalUrlResolver {
	canHandle(input: string): boolean;
	resolve(input: string, context?: ResolveContext): Promise<InternalResource>;
}

export interface InternalUrlExpansionOptions {
	skills: readonly Skill[];
	attachments?: readonly ImageAttachmentEntry[];
	noEscape?: boolean;
	internalRouter?: InternalUrlResolver;
	localOptions?: LocalProtocolOptions;
	cwd?: string;
	ensureLocalParentDirs?: boolean;
}

function containedSkillPath(url: string, contained: ContainedPathResolution): string {
	if (contained.status === "outside") {
		throw new ToolError(`skill:// path resolves outside the plugin root: ${url}`);
	}
	if (contained.status === "missing") {
		throw new ToolError(`skill:// path does not exist: ${url}`);
	}
	return contained.realPath;
}

async function resolveSkillUrlToPath(url: string, skills: readonly Skill[]): Promise<string> {
	const parsed = /^skill:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(url);
	if (!parsed) {
		throw new ToolError(`Invalid skill:// URL: ${url}`);
	}

	let rawSkillSegment = parsed[1];
	if (!rawSkillSegment) {
		throw new ToolError(`skill:// URL requires a skill name: ${url}`);
	}

	try {
		rawSkillSegment = decodeURIComponent(rawSkillSegment);
	} catch {}

	const { skill, suffix } = matchSkillName(rawSkillSegment, skills);
	if (!skill) {
		const available = skills.map(s => s.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new ToolError(`Unknown skill: ${rawSkillSegment}. Available: ${availableStr}`);
	}

	const rawPath = (parsed[2] ?? "") + (suffix ? `/${suffix}` : "");
	const hasRelativePath = rawPath !== "" && rawPath !== "/";

	if (!hasRelativePath) {
		const baseDir = path.resolve(skill.baseDir);
		if (!skill.containRoot) return baseDir;
		return containedSkillPath(url, await resolveContainedPath(skill.containRoot, baseDir));
	}

	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPath.slice(1));
	} catch {
		throw new ToolError(`Invalid skill:// URL path encoding: ${url}`);
	}
	try {
		validateRelativePath(relativePath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ToolError(message);
	}

	const targetPath = path.join(skill.baseDir, relativePath);
	const resolvedPath = path.resolve(targetPath);
	const resolvedBaseDir = path.resolve(skill.baseDir);
	if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
		throw new ToolError("Path traversal is not allowed in skill:// URLs");
	}

	if (!skill.containRoot) return resolvedPath;
	return containedSkillPath(url, await resolveContainedPath(skill.containRoot, resolvedPath));
}

function matchSkillName(
	rawSegment: string,
	skills: readonly Skill[],
): { skill: Skill | undefined; suffix: string | undefined } {
	const exact = skills.find(s => s.name === rawSegment);
	if (exact) return { skill: exact, suffix: undefined };

	let candidate = rawSegment;
	while (true) {
		const lastColon = candidate.lastIndexOf(":");
		if (lastColon <= 0) break;
		candidate = candidate.slice(0, lastColon);
		const match = skills.find(s => s.name === candidate);
		if (match) {
			const suffix = rawSegment.slice(lastColon + 1);
			return { skill: match, suffix };
		}
	}

	return { skill: undefined, suffix: undefined };
}

function unquoteToken(token: string): string {
	if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
		return token.slice(1, -1);
	}
	return token;
}

const COMMAND_SEPARATORS: Record<string, true> = { ";": true, "&": true, "|": true, "\n": true, "(": true, ")": true };

interface ShellContext {
	/** The index sits inside an open shell quote. */
	quoted: boolean;
	/** Where the simple command containing the index begins. */
	commandStart: number;
}

function shellContextAt(
	command: string,
	index: number,
	bodies?: ReadonlyArray<readonly [number, number]>,
): ShellContext {
	type ShellQuote = "'" | '"' | undefined;
	interface CommandSubstitution {
		kind: "dollar" | "backtick";
		outerQuote: ShellQuote;
		outerCommandStart: number;
		depth: number;
	}

	let quote: ShellQuote;
	let commandStart = 0;
	const substitutions: CommandSubstitution[] = [];
	for (let i = 0; i < index; i++) {
		if (bodies) {
			const body = bodies.find(([start, end]) => i >= start && i < end);
			if (body) {
				i = body[1] - 1;
				commandStart = body[1];
				continue;
			}
		}
		const char = command[i];

		if (
			char === "\\" &&
			command[i + 1] === '"' &&
			quote !== "'" &&
			substitutions.at(-1)?.kind === "backtick" &&
			substitutions.at(-1)?.outerQuote === '"'
		) {
			quote = quote === '"' ? undefined : '"';
			i++;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (char === "'" && quote !== '"') {
			quote = quote === "'" ? undefined : "'";
			continue;
		}
		if (char === '"' && quote !== "'") {
			quote = quote === '"' ? undefined : '"';
			continue;
		}
		if (char === "$" && command[i + 1] === "(" && quote !== "'") {
			substitutions.push({ kind: "dollar", outerQuote: quote, outerCommandStart: commandStart, depth: 1 });
			quote = undefined;
			i++;
			commandStart = i + 1;
			continue;
		}
		if (char === "`" && quote !== "'") {
			const top = substitutions.at(-1);
			if (top?.kind === "backtick") {
				substitutions.pop();
				quote = top.outerQuote;
				commandStart = top.outerCommandStart;
			} else {
				substitutions.push({ kind: "backtick", outerQuote: quote, outerCommandStart: commandStart, depth: 0 });
				quote = undefined;
				commandStart = i + 1;
			}
			continue;
		}
		if (quote !== undefined) continue;

		const substitution = substitutions.at(-1);
		if (substitution?.kind === "dollar" && (char === "(" || char === ")")) {
			substitution.depth += char === "(" ? 1 : -1;
			if (substitution.depth === 0) {
				substitutions.pop();
				quote = substitution.outerQuote;
				commandStart = substitution.outerCommandStart;
				continue;
			}
		}
		if (COMMAND_SEPARATORS[char]) commandStart = i + 1;
	}
	return { quoted: quote !== undefined, commandStart };
}

const PROTOLENS_COMMAND_HEAD = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*protolens\s/;

/**
 * `protolens` devices resolve internal URLs themselves, with the same
 * selectors and generated views as a direct tool call.
 */
function isProtolensArgument(
	command: string,
	index: number,
	bodies?: ReadonlyArray<readonly [number, number]>,
): boolean {
	const { commandStart } = shellContextAt(command, index, bodies);
	return PROTOLENS_COMMAND_HEAD.test(command.slice(commandStart, index));
}

function isEscapedCharacter(command: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && command[i] === "\\"; i--) backslashes++;
	return backslashes % 2 === 1;
}

function isJsonDocument(value: string): boolean {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null && typeof parsed === "object";
	} catch {
		return false;
	}
}

function isEmbeddedInQuotedText(
	command: string,
	token: string,
	index: number,
	bodies?: ReadonlyArray<readonly [number, number]>,
): boolean {
	const startsWithQuote = token.startsWith("'") || token.startsWith('"');
	const precedingQuote = command[index - 1];
	const escapedOpeningQuote = startsWithQuote
		? isEscapedCharacter(command, index)
		: (precedingQuote === "'" || precedingQuote === '"') && isEscapedCharacter(command, index - 1);
	if (escapedOpeningQuote) {
		return true;
	}
	// A match may begin with a JSON quote nested inside an outer shell quote;
	// the quote-state scan distinguishes that from a shell quote opening here.
	return shellContextAt(command, index, bodies).quoted;
}

function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

// Transport URLs belong to the programs that take them (curl, git, ssh, rsync),
// even when the router can also read them (`ssh://`).
const TRANSPORT_URL = /^(?:https?|ftp|sftp|file|git|ssh):\/\//i;

/**
 * Filesystem path for a harness-owned URL. `undefined` means the scheme is
 * not the harness's (`s3://`, `postgres://`, …) and the token stays as typed.
 */
async function resolveInternalUrlToPath(
	rawUrl: string,
	skills: readonly Skill[],
	attachments: readonly ImageAttachmentEntry[],
	internalRouter?: InternalUrlResolver,
	localOptions?: LocalProtocolOptions,
	ensureLocalParentDirs?: boolean,
	cwd?: string,
): Promise<string | undefined> {
	const url = normalizeLocalScheme(rawUrl);
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
	if (!scheme || TRANSPORT_URL.test(url)) return undefined;

	if (scheme === "skill") {
		return resolveSkillUrlToPath(url, skills);
	}

	if (scheme === "attachment") {
		const attachment = attachments.find(entry => entry.uri === url);
		if (!attachment) {
			throw new ToolError(`Unknown attachment URL in bash command: ${url}`);
		}
		return path.resolve(attachment.sourcePath);
	}

	if (scheme === "local" || scheme === "fleet") {
		if (!localOptions) {
			throw new ToolError(
				`Cannot resolve ${scheme}:// URL in bash command: local protocol options are unavailable for this session.`,
			);
		}
		const resolved =
			scheme === "fleet" ? resolveFleetUrlToPath(url, localOptions) : resolveLocalUrlToPath(url, localOptions);
		if (ensureLocalParentDirs) {
			await fs.mkdir(path.dirname(resolved), { recursive: true });
		}
		return resolved;
	}

	if (["agent", "history", "mcp", "protolens"].includes(scheme)) {
		throw new ToolError(`${url} is a generated view, not a filesystem path.`);
	}
	if (!internalRouter?.canHandle(url)) return undefined;

	let resource: InternalResource;
	try {
		resource = await internalRouter.resolve(url, { cwd, pathOnly: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Failed to resolve ${scheme}:// URL in bash command: ${url}\n${message}`);
	}

	if (!resource.sourcePath) {
		throw new ToolError(`${scheme}:// URL resolved without a filesystem path and cannot be used in bash: ${url}`);
	}

	return path.resolve(resource.sourcePath);
}

// Heredoc bodies are stdin data for the command that follows them — never
// command position. A scheme URL there is content (a script body, a doc
// example, a kernel cell containing a literal `fleet://x.py` URL) and must
// survive URL expansion untouched, exactly like the rest of the data stream.
const HEREDOC_OPERATOR_RE = /^<<(-?)(?:\\([A-Za-z_][A-Za-z0-9_]*)|(["']?)([A-Za-z_][A-Za-z0-9_]*)\3)/;

export function heredocBodyRanges(command: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let quote: "'" | '"' | undefined;
	let pendingBodyEnd: number | undefined;
	let i = 0;
	while (i < command.length) {
		if (pendingBodyEnd !== undefined) {
			// Inside a heredoc body: quotes are data; jump to the terminator.
			if (command[i] === "\n") {
				i = pendingBodyEnd;
				pendingBodyEnd = undefined;
				continue;
			}
			i++;
			continue;
		}
		const char = command[i]!;
		if (char === "\n") {
			i++;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			i += 2;
			continue;
		}
		if (char === "'" && quote !== '"') {
			quote = quote === "'" ? undefined : "'";
			i++;
			continue;
		}
		if (char === '"' && quote !== "'") {
			quote = quote === '"' ? undefined : '"';
			i++;
			continue;
		}
		if (
			quote === undefined &&
			char === "<" &&
			command[i - 1] !== "<" &&
			command[i + 1] === "<" &&
			command[i + 2] !== "<"
		) {
			const operator = HEREDOC_OPERATOR_RE.exec(command.slice(i));
			if (operator) {
				const delimiter = operator[2] ?? operator[4]!;
				const dash = operator[1] === "-";
				const newline = command.indexOf("\n", i);
				if (newline === -1) {
					i = command.length;
					continue;
				}
				const bodyStart = newline + 1;
				// Scan for the terminator line: the delimiter alone on a line,
				// with leading tabs stripped only for `<<-` (bash is strict —
				// trailing whitespace keeps a line in the body).
				let bodyEnd = -1;
				let afterTerminator = -1;
				let pos = bodyStart;
				while (pos <= command.length) {
					const nl = command.indexOf("\n", pos);
					const lineEnd = nl === -1 ? command.length : nl;
					const line = command.slice(pos, lineEnd);
					const stripped = dash ? line.replace(/^\t+/, "") : line;
					if (stripped === delimiter) {
						bodyEnd = pos;
						afterTerminator = nl === -1 ? command.length : nl + 1;
						break;
					}
					if (nl === -1) break;
					pos = nl + 1;
				}
				if (bodyEnd >= 0) {
					// The operator line after the delimiter still carries shell
					// syntax (redirects, `&&`, …); track its quotes, then jump
					// past the body once its newline arrives.
					let j = i + operator[0].length;
					while (j < newline) {
						const c = command[j]!;
						if (c === "\\" && quote !== "'") {
							j += 2;
							continue;
						}
						if (c === "'" && quote !== '"') quote = quote === "'" ? undefined : "'";
						else if (c === '"' && quote !== "'") quote = quote === '"' ? undefined : '"';
						j++;
					}
					ranges.push([bodyStart, bodyEnd]);
					pendingBodyEnd = afterTerminator;
					i = newline;
					continue;
				}
				// Unterminated heredoc: the body runs to the end of the command.
				ranges.push([bodyStart, command.length]);
				i = command.length;
				continue;
			}
		}
		i++;
	}
	return ranges;
}

function isInHeredocBody(ranges: ReadonlyArray<readonly [number, number]>, index: number): boolean {
	return ranges.some(([start, end]) => index >= start && index < end);
}

export async function expandInternalUrls(command: string, options: InternalUrlExpansionOptions): Promise<string> {
	if (!command.includes("://") && !command.includes("local:/")) return command;
	// A complete JSON document is data, not shell syntax. This also preserves
	// JSON passed through environment values, which have no shell quote context.
	if (isJsonDocument(command)) return command;

	const matches = Array.from(command.matchAll(INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL));
	if (matches.length === 0) return command;

	// Heredoc bodies are data (see heredocBodyRanges): URLs there must not
	// expand, even though they sit inside the raw command string.
	const bodies = heredocBodyRanges(command);

	let expanded = command;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;

		if (isInHeredocBody(bodies, index)) continue;
		if (isEmbeddedInQuotedText(command, token, index, bodies)) continue;

		const url = normalizeLocalScheme(unquoteToken(token));
		// A trailing read selector (`:1-40`, `:raw`) is not part of the resource:
		// resolve the resource and keep the selector on the path, as read does.
		const target = splitInternalUrlSel(url);
		let resolvedPath: string | undefined;
		try {
			resolvedPath = await resolveInternalUrlToPath(
				target.path,
				options.skills,
				options.attachments ?? [],
				options.internalRouter,
				options.localOptions,
				options.ensureLocalParentDirs,
				options.cwd,
			);
		} catch (error) {
			if (isProtolensArgument(command, index, bodies)) continue;
			throw new ToolError(`${error instanceof Error ? error.message : String(error)}
Use read({path: ${JSON.stringify(url)}}) for internal resources without a filesystem path.`);
		}
		if (resolvedPath === undefined) continue;
		if (target.sel !== undefined) resolvedPath = `${resolvedPath}:${target.sel}`;
		const replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		expanded = `${expanded.slice(0, index)}${replacement}${expanded.slice(index + token.length)}`;
	}

	return expanded;
}
