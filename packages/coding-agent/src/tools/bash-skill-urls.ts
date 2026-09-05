import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveContainedPathSync } from "../discovery/contained-path";
import type { Skill } from "../extensibility/skills";
import { type LocalProtocolOptions, resolveFleetUrlToPath, resolveLocalUrlToPath } from "../internal-urls";
import { validateRelativePath } from "../internal-urls/skill-protocol";
import type { InternalResource, ResolveContext } from "../internal-urls/types";
import type { ImageAttachmentEntry } from ".";
import { normalizeLocalScheme } from "./path-utils";
import { ToolError } from "./tool-errors";

const SKILL_URL_PATTERN = /'skill:\/\/[^'\s")`\\]+'|"skill:\/\/[^"\s')`\\]+"|skill:\/\/[^\s'")`\\;&|<>($]+/g;

const INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL =
	/'(?:skill|agent|artifact|memory|rule|local|fleet|attachment):\/\/[^'\s")`\\]+'|"(?:skill|agent|artifact|memory|rule|local|fleet|attachment):\/\/[^"\s')`\\]+"|(?:skill|agent|artifact|memory|rule|local|fleet|attachment):\/\/[^\s'")`\\;&|<>($]+|'local:\/[^'\s")`\\]+'|"local:\/[^"\s')`\\]+"|(?<![./\\\\\w-])local:\/[^\s'")`\\;&|<>($]+/g;

const SUPPORTED_INTERNAL_SCHEMES = [
	"skill",
	"agent",
	"artifact",
	"memory",
	"rule",
	"local",
	"fleet",
	"attachment",
] as const;

type SupportedInternalScheme = (typeof SUPPORTED_INTERNAL_SCHEMES)[number];

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

export function resolveSkillUrlToPath(url: string, skills: readonly Skill[]): string {
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
		return path.resolve(skill.baseDir);
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

	if (skill.containRoot) {
		const contained = resolveContainedPathSync(skill.containRoot, resolvedPath);
		if (contained.status === "outside") {
			throw new ToolError(`skill:// path resolves outside the plugin root: ${url}`);
		}
		if (contained.status === "missing") {
			throw new ToolError(`skill:// path does not exist: ${url}`);
		}
		return contained.realPath;
	}

	return resolvedPath;
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

function extractScheme(url: string): SupportedInternalScheme | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (!match) return undefined;
	const scheme = match[1].toLowerCase();
	if (!SUPPORTED_INTERNAL_SCHEMES.includes(scheme as SupportedInternalScheme)) return undefined;
	return scheme as SupportedInternalScheme;
}

function unquoteToken(token: string): string {
	if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
		return token.slice(1, -1);
	}
	return token;
}

function isInsideShellQuote(
	command: string,
	index: number,
	bodies?: ReadonlyArray<readonly [number, number]>,
): boolean {
	type ShellQuote = "'" | '"' | undefined;
	interface CommandSubstitution {
		kind: "dollar" | "backtick";
		outerQuote: ShellQuote;
		depth: number;
	}

	let quote: ShellQuote;
	const substitutions: CommandSubstitution[] = [];
	for (let i = 0; i < index; i++) {
		if (bodies) {
			const body = bodies.find(([start, end]) => i >= start && i < end);
			if (body) {
				i = body[1] - 1;
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
			substitutions.push({ kind: "dollar", outerQuote: quote, depth: 1 });
			quote = undefined;
			i++;
			continue;
		}
		if (char === "`" && quote !== "'") {
			const top = substitutions.at(-1);
			if (top?.kind === "backtick") {
				substitutions.pop();
				quote = top.outerQuote;
			} else {
				substitutions.push({ kind: "backtick", outerQuote: quote, depth: 0 });
				quote = undefined;
			}
			continue;
		}
		if (quote !== undefined) continue;

		const substitution = substitutions.at(-1);
		if (substitution?.kind !== "dollar") continue;
		if (char === "(") {
			substitution.depth++;
		} else if (char === ")") {
			substitution.depth--;
			if (substitution.depth === 0) {
				quote = substitutions.pop()?.outerQuote;
			}
		}
	}
	return quote !== undefined;
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
	return isInsideShellQuote(command, index, bodies);
}

function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

async function resolveInternalUrlToPath(
	rawUrl: string,
	skills: readonly Skill[],
	attachments: readonly ImageAttachmentEntry[],
	internalRouter?: InternalUrlResolver,
	localOptions?: LocalProtocolOptions,
	ensureLocalParentDirs?: boolean,
	cwd?: string,
): Promise<string> {
	const url = normalizeLocalScheme(rawUrl);
	const scheme = extractScheme(url);
	if (!scheme) {
		throw new ToolError(`Unsupported internal URL in bash command: ${url}`);
	}

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

	if (!internalRouter?.canHandle(url)) {
		throw new ToolError(
			`Cannot resolve ${scheme}:// URL in bash command: ${url}\n` +
				"Internal URL router is unavailable for this protocol in the current session.",
		);
	}

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
// example, a kernel cell referencing `proto_path("fleet://x.py")`) and must
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

export function expandSkillUrls(command: string, skills: readonly Skill[]): string {
	if (skills.length === 0 || !command.includes("skill://")) {
		return command;
	}

	const bodies = heredocBodyRanges(command);
	return command.replace(SKILL_URL_PATTERN, (token, offset: number) => {
		if (isInHeredocBody(bodies, offset)) return token;
		const url = unquoteToken(token);
		const resolvedPath = resolveSkillUrlToPath(url, skills);
		return shellEscape(resolvedPath);
	});
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

		const rawUrl = unquoteToken(token);
		const url = normalizeLocalScheme(rawUrl);
		let resolvedPath: string;
		try {
			resolvedPath = await resolveInternalUrlToPath(
				url,
				options.skills,
				options.attachments ?? [],
				options.internalRouter,
				options.localOptions,
				options.ensureLocalParentDirs,
				options.cwd,
			);
		} catch {
			continue;
		}
		const replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		expanded = `${expanded.slice(0, index)}${replacement}${expanded.slice(index + token.length)}`;
	}

	return expanded;
}
