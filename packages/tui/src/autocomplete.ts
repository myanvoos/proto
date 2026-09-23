import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fuzzyFind } from "@oh-my-pi/pi-natives";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function buildAutocompleteFuzzyDiscoveryProfile(
	query: string,
	basePath: string,
	signal?: AbortSignal,
): {
	query: string;
	path: string;
	maxResults: number;
	hidden: boolean;
	gitignore: boolean;
	cache: boolean;
	signal?: AbortSignal;
} {
	return {
		query,
		path: basePath,
		maxResults: 100,
		hidden: true,
		gitignore: true,
		cache: true,
		...(signal ? { signal } : {}),
	};
}

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) {
			return i;
		}
	}
	return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

export function findLeadingSlashCommandStart(text: string): number | null {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("/")) return null;
	return text.length - trimmed.length;
}

export function findTrailingSlashCommandStart(text: string): number | null {
	const match = /(?:^|\s)\/([^\s/]*)$/.exec(text);
	if (!match || match.index === undefined) return null;
	const slashOffset = match[0].indexOf("/");
	return match.index + slashOffset;
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) {
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	if (prefix.startsWith('"')) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	if (prefix.startsWith("@")) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

/**
 * Whether an autocomplete value names a directory: trailing slash or
 * backslash, optionally followed by a closing quote for quoted paths. Shared
 * by the provider suffix logic and the editor chain-on-accept behavior so Tab
 * and Enter acceptance stay in sync.
 */
export function isDirectoryCompletionValue(value: string): boolean {
	return /[\\/]["']?$/.test(value);
}

function buildCompletionValue(
	path: string,
	options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
	const needsQuotes = options.isQuotedPrefix || path.includes(" ");
	const prefix = options.isAtPrefix ? "@" : "";

	if (!needsQuotes) {
		return `${prefix}${path}`;
	}

	const openQuote = `${prefix}"`;
	const closeQuote = options.isDirectory ? "" : '"';
	return `${openQuote}${path}${closeQuote}`;
}

function fuzzyMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	if (query.length > target.length) return false;

	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) qi++;
	}
	return qi === query.length;
}

function fuzzyScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (target === query) return 100;
	if (target.startsWith(query)) return 80;
	if (target.includes(query)) return 60;

	let qi = 0;
	let gaps = 0;
	let lastMatchIdx = -1;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) {
			if (lastMatchIdx >= 0 && ti - lastMatchIdx > 1) gaps++;
			lastMatchIdx = ti;
			qi++;
		}
	}
	if (qi !== query.length) return 0;

	return Math.max(1, 40 - gaps * 5);
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;

	icon?: string;

	hint?: string;

	/**
	 * Matched only via description/keywords; Enter must not accept it unless
	 * the user explicitly navigated to it.
	 */
	weakMatch?: boolean;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	argumentHint?: string;

	allowArgs?: boolean;

	getAutocompleteDescription?: () => string | undefined;

	getArgumentCompletions?(argumentPrefix: string, signal?: AbortSignal): Awaitable<AutocompleteItem[] | null>;

	getInlineHint?(argumentText: string): string | null;
}

export interface AutocompleteProvider {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{
		items: AutocompleteItem[];
		prefix: string;
	} | null>;

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	};

	getInlineHint?(lines: string[], cursorLine: number, cursorCol: number): string | null;

	trySyncSlashCompletion?(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null;

	trySyncInlineReplace?(textBeforeCursor: string): { replaceLen: number; insert: string } | null;

	getForceFileSuggestions?(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null>;

	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

type CommandEntry = SlashCommand | AutocompleteItem;

export interface CombinedAutocompleteOptions {
	commandUsage?: (name: string) => number;
}

function getCommandName(cmd: CommandEntry): string | undefined {
	return "name" in cmd ? cmd.name : cmd.value;
}

function getCommandAliases(cmd: CommandEntry): string[] {
	if (!("aliases" in cmd) || !Array.isArray(cmd.aliases)) return [];
	return cmd.aliases.filter(alias => typeof alias === "string" && alias.length > 0);
}

function getStaticCommandDescription(cmd: CommandEntry): string {
	return cmd.description ?? "";
}

function getAutocompleteCommandDescription(cmd: CommandEntry): string {
	if ("getAutocompleteDescription" in cmd && typeof cmd.getAutocompleteDescription === "function") {
		return cmd.getAutocompleteDescription() ?? cmd.description ?? "";
	}
	return cmd.description ?? "";
}

function commandMatchesNameOrAlias(cmd: CommandEntry, commandName: string): boolean {
	const name = getCommandName(cmd);
	if (name === commandName) return true;
	return getCommandAliases(cmd).includes(commandName);
}

export function scoreCommandTextMatch(lowerPrefix: string, lowerTarget: string): number {
	if (lowerPrefix.length === 0) return 1;
	if (lowerPrefix === lowerTarget) return 1000;

	if (lowerTarget.startsWith(lowerPrefix)) return 900;
	return fuzzyMatch(lowerPrefix, lowerTarget) ? fuzzyScore(lowerPrefix, lowerTarget) : 0;
}

function buildSlashCommandCompletions(
	commands: CommandEntry[],
	lowerPrefix: string,
	commandUsage?: (name: string) => number,
): AutocompleteItem[] {
	return commands
		.flatMap(cmd => {
			const name = getCommandName(cmd);
			if (!name) return [];
			const usage = commandUsage?.(name) ?? 0;
			const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
			const staticDesc = getStaticCommandDescription(cmd);
			let fullDescMemo: string | undefined;
			let fullDescComputed = false;

			const resolveFullDesc = (): string | undefined => {
				if (!fullDescComputed) {
					const displayDesc = getAutocompleteCommandDescription(cmd);
					fullDescMemo = hint ? (displayDesc ? `${hint} - ${displayDesc}` : hint) : displayDesc;
					fullDescComputed = true;
				}
				return fullDescMemo;
			};
			let best: (AutocompleteItem & { score: number; usage: number }) | undefined;

			const isSkillCommand = name.startsWith(SKILL_NAMESPACE);
			// Skills also match by bare name so a broken-out or mid-prompt skill
			// ranks at prefix strength (`/batch` → `skill:batch`) instead of a
			// weak full-name fuzzy hit.
			const nameScore =
				lowerPrefix.length === 0 && isSkillCommand
					? 950
					: isSkillCommand
						? Math.max(
								scoreCommandTextMatch(lowerPrefix, name.toLowerCase()),
								skillBareNameBreakoutTier(lowerPrefix, name.slice(SKILL_NAMESPACE.length).toLowerCase()),
							)
						: scoreCommandTextMatch(lowerPrefix, name.toLowerCase());
			const lowerDesc = staticDesc.toLowerCase();
			const descScore =
				lowerDesc && fuzzyMatch(lowerPrefix, lowerDesc) ? fuzzyScore(lowerPrefix, lowerDesc) * 0.5 : 0;
			const primaryScore = Math.max(nameScore, descScore);
			if (primaryScore > 0) {
				const fullDesc = resolveFullDesc();
				best = {
					value: name,
					label: "name" in cmd ? cmd.name : cmd.label,
					score: primaryScore,
					usage,
					...(fullDesc && { description: fullDesc }),
				};
			}

			let aliasMatched = false;
			if (lowerPrefix.length > 0) {
				for (const alias of getCommandAliases(cmd)) {
					if (alias === name) continue;
					const aliasScore = scoreCommandTextMatch(lowerPrefix, alias.toLowerCase());
					if (aliasScore === 0) continue;
					aliasMatched = true;
					if (best && aliasScore <= best.score) continue;
					const fullDesc = resolveFullDesc();
					best = {
						value: alias,
						label: alias,
						score: aliasScore,
						usage,
						...(fullDesc && { description: fullDesc }),
					};
				}
			}

			if (!best) return [];
			// A description-only hit is kept for discovery but flagged so the
			// editor never lets a plain Enter run a command the user did not type.
			if (nameScore === 0 && !aliasMatched) best.weakMatch = true;
			return [best];
		})
		.sort((a, b) => {
			// Name/alias matches always outrank description-only discovery hits.
			return Number(a.weakMatch === true) - Number(b.weakMatch === true) || b.score - a.score || b.usage - a.usage;
		})
		.map(({ score: _, usage: _usage, ...rest }) => rest);
}

function hasPromptTextBeforeSlash(
	lines: string[],
	cursorLine: number,
	textBeforeCursor: string,
	slashStart: number,
): boolean {
	for (let i = 0; i < cursorLine; i += 1) {
		if ((lines[i] || "").trim() !== "") return true;
	}
	return textBeforeCursor.slice(0, slashStart).trim() !== "";
}

export const SKILL_NAMESPACE = "skill:";

/** Exact/leading-prefix tier for ordinary command names and aliases. */
function commandBreakoutTier(lowerPrefix: string, lowerTarget: string): number {
	if (lowerPrefix === lowerTarget) return 1000;
	if (lowerTarget.startsWith(lowerPrefix)) return 900;
	return 0;
}

/**
 * Match a bare skill name from the beginning of the name or any
 * hyphen-delimited segment (`/last` → `research-last30days`). Scans segment
 * boundaries in place without materializing split arrays.
 */
function skillBareNameBreakoutTier(lowerPrefix: string, lowerBareName: string): number {
	if (lowerPrefix.length === 0) return 0;
	if (lowerPrefix === lowerBareName) return 1000;
	if (lowerBareName.startsWith(lowerPrefix)) return 900;

	let segmentStart = 0;
	while (segmentStart < lowerBareName.length) {
		while (segmentStart < lowerBareName.length && lowerBareName.charCodeAt(segmentStart) !== 45) {
			segmentStart += 1;
		}
		segmentStart += 1;
		if (segmentStart >= lowerBareName.length) break;

		if (lowerBareName.startsWith(lowerPrefix, segmentStart)) {
			let segmentEnd = segmentStart;
			while (segmentEnd < lowerBareName.length && lowerBareName.charCodeAt(segmentEnd) !== 45) {
				segmentEnd += 1;
			}
			return lowerPrefix.length === segmentEnd - segmentStart ? 1000 : 900;
		}
	}

	return 0;
}

/**
 * Collapse `skill:*` commands into a single `/skill:` namespace row while the
 * typed prefix has not committed to the namespace. A lone group entry (shown
 * only while the prefix is still a prefix of `skill:`) keeps the `/` popup
 * readable. A skill breaks out of the group only when its bare name matches
 * the prefix at the beginning of the name or a hyphen-delimited segment, at a
 * strictly stronger tier than every non-skill command name and alias: a tie
 * keeps the popup command-only, and fuzzy-only skill hits never surface.
 */
function collapseSkillNamespace(commands: CommandEntry[], lowerPrefix: string): CommandEntry[] {
	if (lowerPrefix.startsWith(SKILL_NAMESPACE)) return commands;
	const approachesNamespace = SKILL_NAMESPACE.startsWith(lowerPrefix);
	let commandTier = 0;
	if (!approachesNamespace) {
		for (const cmd of commands) {
			const name = getCommandName(cmd);
			if (!name || name.startsWith(SKILL_NAMESPACE)) continue;
			commandTier = Math.max(commandTier, commandBreakoutTier(lowerPrefix, name.toLowerCase()));
			for (const alias of getCommandAliases(cmd)) {
				commandTier = Math.max(commandTier, commandBreakoutTier(lowerPrefix, alias.toLowerCase()));
			}
			if (commandTier === 1000) break;
		}
	}
	let skillCount = 0;
	const rest = commands.filter(cmd => {
		const name = getCommandName(cmd);
		if (!name?.startsWith(SKILL_NAMESPACE)) return true;
		skillCount += 1;
		return (
			!approachesNamespace &&
			skillBareNameBreakoutTier(lowerPrefix, name.slice(SKILL_NAMESPACE.length).toLowerCase()) > commandTier
		);
	});
	if (skillCount === 0) return commands;
	if (!SKILL_NAMESPACE.startsWith(lowerPrefix)) return rest;
	rest.push({
		name: SKILL_NAMESPACE,
		description: `${skillCount} skill${skillCount === 1 ? "" : "s"}`,
	});
	return rest;
}

export function midPromptSkillTokenMatches(lowerToken: string, name: string, description?: string): boolean {
	if (SKILL_NAMESPACE.startsWith(lowerToken)) return true;
	const lowerName = name.toLowerCase();
	if (lowerToken.startsWith(SKILL_NAMESPACE)) {
		if (scoreCommandTextMatch(lowerToken, lowerName) > 0) return true;
		return !!description && scoreCommandTextMatch(lowerToken, description.toLowerCase()) > 0;
	}
	return (
		lowerName.startsWith(SKILL_NAMESPACE) &&
		skillBareNameBreakoutTier(lowerToken, lowerName.slice(SKILL_NAMESPACE.length)) > 0
	);
}

function buildMidPromptSkillCompletions(commands: CommandEntry[], lowerPrefix: string): AutocompleteItem[] {
	return buildSlashCommandCompletions(
		commands.filter(cmd => {
			const name = getCommandName(cmd);
			return (
				name?.startsWith(SKILL_NAMESPACE) &&
				midPromptSkillTokenMatches(lowerPrefix, name, getStaticCommandDescription(cmd))
			);
		}),
		lowerPrefix,
	);
}

export class CombinedAutocompleteProvider implements AutocompleteProvider {
	#commands: CommandEntry[];
	#basePath: string;
	#commandUsage?: (name: string) => number;

	#dirCache: Map<string, { entries: fs.Dirent[]; timestamp: number }> = new Map();
	#dirInflight: Map<string, Promise<fs.Dirent[]>> = new Map();
	#dirInflightGeneration: Map<string, number> = new Map();
	// Epoch-based invalidation: every invalidateDirCache() bumps one counter
	// so even not-yet-registered in-flight reads are invalidated (a per-key
	// generation map misses keys whose read started before the key existed).
	#dirCacheEpoch = 0;
	readonly #DIR_CACHE_TTL = 2000;
	readonly #SYMLINK_STAT_CONCURRENCY = 8;

	constructor(
		commands: CommandEntry[] = [],
		basePath: string = getProjectDir(),
		options?: CombinedAutocompleteOptions,
	) {
		this.#commands = commands;
		this.#basePath = basePath;
		this.#commandUsage = options?.commandUsage;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		if (signal?.aborted) return null;
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const leadingSlashStart = findLeadingSlashCommandStart(textBeforeCursor);
		const trailingSlashStart = findTrailingSlashCommandStart(textBeforeCursor);
		const hasPromptTextBeforeTrailingSlash =
			trailingSlashStart !== null &&
			hasPromptTextBeforeSlash(lines, cursorLine, textBeforeCursor, trailingSlashStart);
		const hasPromptTextBeforeLeadingSlash =
			leadingSlashStart !== null && hasPromptTextBeforeSlash(lines, cursorLine, textBeforeCursor, leadingSlashStart);
		const slashStart = hasPromptTextBeforeTrailingSlash
			? trailingSlashStart
			: hasPromptTextBeforeLeadingSlash
				? null
				: leadingSlashStart;
		if (slashStart !== null) {
			const commandText = textBeforeCursor.slice(slashStart);
			const spaceIndex = commandText.indexOf(" ");
			const isMidPromptSkillLookup = hasPromptTextBeforeTrailingSlash;

			if (spaceIndex === -1) {
				const prefix = commandText.slice(1);
				const lowerPrefix = prefix.toLowerCase();

				const matches = isMidPromptSkillLookup
					? buildMidPromptSkillCompletions(this.#commands, lowerPrefix)
					: buildSlashCommandCompletions(
							collapseSkillNamespace(this.#commands, lowerPrefix),
							lowerPrefix,
							this.#commandUsage,
						);

				if (matches.length > 0) {
					return {
						items: matches,

						prefix: isMidPromptSkillLookup ? commandText : textBeforeCursor,
					};
				}
				if (!isMidPromptSkillLookup && slashStart === leadingSlashStart && !commandText.slice(1).includes("/")) {
					return null;
				}
			} else if (!isMidPromptSkillLookup) {
				const commandName = commandText.slice(1, spaceIndex);
				const argumentText = commandText.slice(spaceIndex + 1);

				const command = this.#commands.find(cmd => commandMatchesNameOrAlias(cmd, commandName));
				if (command && "allowArgs" in command && command.allowArgs === false && !/\S/.test(argumentText)) {
					return null;
				}
				if (
					command &&
					(!("allowArgs" in command) || command.allowArgs !== false) &&
					"getArgumentCompletions" in command &&
					command.getArgumentCompletions
				) {
					const argumentSuggestions = await command.getArgumentCompletions(argumentText, signal);
					if (Array.isArray(argumentSuggestions) && argumentSuggestions.length > 0) {
						return {
							items: argumentSuggestions,
							prefix: argumentText,
						};
					}
				}
			}
		}

		const atPrefix = this.#extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);

			if (rawPrefix.length > 0 && this.#isOutsideCwd(rawPrefix)) {
				const items = await this.#getFileSuggestions(atPrefix, signal);
				if (items.length === 0) return null;
				return { items, prefix: atPrefix };
			}
			const suggestions =
				rawPrefix.length > 0
					? await this.#getFuzzyFileSuggestions(rawPrefix, { isQuotedPrefix, signal })
					: await this.#getFileSuggestions("@", signal);
			if (suggestions.length === 0 && rawPrefix.length > 0) {
				const fallback = await this.#getFileSuggestions(atPrefix, signal);
				if (fallback.length === 0) return null;
				return { items: fallback, prefix: atPrefix };
			}
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: atPrefix,
			};
		}

		const pathMatch = this.#extractPathPrefix(textBeforeCursor, false);

		if (pathMatch !== null) {
			const suggestions = await this.#getFileSuggestions(pathMatch, signal);
			if (suggestions.length === 0) return null;

			if (suggestions.length === 1 && suggestions[0]?.value === pathMatch && !pathMatch.endsWith("/")) {
				return {
					items: suggestions,
					prefix: pathMatch,
				};
			}

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const afterCursor = currentLine.slice(cursorCol);

		const leadingSlashStart = findLeadingSlashCommandStart(textBeforeCursor);
		const trailingSlashStart = findTrailingSlashCommandStart(textBeforeCursor);
		const isMidPromptSkillLookup =
			item.value.startsWith("skill:") &&
			trailingSlashStart !== null &&
			hasPromptTextBeforeSlash(lines, cursorLine, textBeforeCursor, trailingSlashStart) &&
			findTrailingSlashCommandStart(prefix) !== null;

		if (isMidPromptSkillLookup && trailingSlashStart !== null) {
			const beforeSlash = currentLine.slice(0, trailingSlashStart);
			const insert = `/${item.value} `;
			const newLine = `${beforeSlash}${insert}${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforeSlash.length + insert.length,
			};
		}

		const isPathCompletionItem = item.value.startsWith("/") || item.value.startsWith('"');
		if (findLeadingSlashCommandStart(prefix) !== null && leadingSlashStart !== null && !isPathCompletionItem) {
			const slashPrefix = textBeforeCursor.slice(leadingSlashStart);
			if (!slashPrefix.includes(" ") && !slashPrefix.slice(1).includes("/")) {
				const beforeSlash = currentLine.slice(0, leadingSlashStart);

				const insert = item.value === SKILL_NAMESPACE ? `/${item.value}` : `/${item.value} `;
				const newLine = `${beforeSlash}${insert}${afterCursor}`;
				const newLines = [...lines];
				newLines[cursorLine] = newLine;

				return {
					lines: newLines,
					cursorLine,
					cursorCol: beforeSlash.length + insert.length,
				};
			}
		}

		let beforePrefix = currentLine.slice(0, cursorCol - prefix.length);

		if (prefix.startsWith("@")) {
			const liveAtPrefix = this.#extractAtPrefix(textBeforeCursor);
			if (liveAtPrefix) {
				beforePrefix = currentLine.slice(0, cursorCol - liveAtPrefix.length);
			}

			// A directory completion ends in "/": keep the token open so child
			// suggestions can continue instead of terminating it with a space.
			const separator = isDirectoryCompletionValue(item.value) ? "" : " ";
			const newLine = `${beforePrefix + item.value}${separator}${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + separator.length,
			};
		}

		const newLine = beforePrefix + item.value + afterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length,
		};
	}

	#extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;

		if (text[tokenStart] === "@") {
			return text.slice(tokenStart);
		}

		return null;
	}

	#extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		if (forceExtract) {
			return pathPrefix;
		}

		if (
			pathPrefix.startsWith("/") ||
			pathPrefix.startsWith("./") ||
			pathPrefix.startsWith("../") ||
			pathPrefix.startsWith("~/") ||
			/^[A-Za-z]:[\\/]/.test(pathPrefix)
		) {
			return pathPrefix;
		}

		return null;
	}

	#expandHomePath(filePath: string): string {
		if (filePath.startsWith("~/")) {
			const expandedPath = path.join(os.homedir(), filePath.slice(2));

			return filePath.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (filePath === "~") {
			return os.homedir();
		}
		return filePath;
	}

	#isOutsideCwd(rawPrefix: string): boolean {
		if (rawPrefix.length === 0) return false;
		let target: string;
		if (rawPrefix.startsWith("~")) {
			target = this.#expandHomePath(rawPrefix);
		} else if (path.isAbsolute(rawPrefix)) {
			target = rawPrefix;
		} else {
			target = path.resolve(this.#basePath, rawPrefix);
		}
		const rel = path.relative(this.#basePath, target);
		if (rel === "" || rel === ".") return false;
		if (path.isAbsolute(rel)) return true;
		const firstSep = rel.indexOf(path.sep);
		const head = firstSep === -1 ? rel : rel.slice(0, firstSep);
		return head === "..";
	}

	async #resolveScopedFuzzyQuery(
		rawQuery: string,
		signal?: AbortSignal,
	): Promise<{ baseDir: string; query: string; displayBase: string } | null> {
		const slashIndex = rawQuery.lastIndexOf("/");
		if (slashIndex === -1) {
			return null;
		}

		const displayBase = rawQuery.slice(0, slashIndex + 1);
		const query = rawQuery.slice(slashIndex + 1);

		let baseDir: string;
		if (displayBase.startsWith("~/")) {
			baseDir = this.#expandHomePath(displayBase);
		} else if (displayBase.startsWith("/")) {
			baseDir = displayBase;
		} else {
			baseDir = path.join(this.#basePath, displayBase);
		}

		try {
			if (signal?.aborted) return null;
			if (!(await untilAborted(signal, fs.promises.stat(baseDir))).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}

		return { baseDir, query, displayBase };
	}

	#scopedPathForDisplay(displayBase: string, relativePath: string): string {
		if (displayBase === "/") {
			return `/${relativePath}`;
		}
		return `${displayBase}${relativePath}`;
	}

	async #getCachedDirEntries(searchDir: string, signal?: AbortSignal): Promise<fs.Dirent[]> {
		const key = path.resolve(searchDir);
		const now = Date.now();
		const cached = this.#dirCache.get(key);

		if (cached && now - cached.timestamp < this.#DIR_CACHE_TTL) {
			return cached.entries;
		}

		// Deduplicate concurrent physical reads of the same directory: rapid
		// token changes must not stack readdir round trips for one path.
		const generation = this.#dirCacheEpoch;
		// An in-flight read started before the current generation must not be
		// reused: its entries were computed against invalidated state.
		const inflight = this.#dirInflight.get(key);
		if (inflight && this.#dirInflightGeneration.get(key) === generation) {
			return untilAborted(signal, inflight);
		}
		const read = fs.promises
			.readdir(searchDir, { withFileTypes: true })
			.then(entries => {
				// A cache entry computed against a stale generation (the
				// directory was invalidated mid-read) must not be published.
				if (this.#dirCacheEpoch === generation) {
					this.#dirCache.set(key, { entries, timestamp: Date.now() });
					this.#evictDirCacheOverflow();
				}
				return entries;
			})
			.finally(() => {
				if (this.#dirInflight.get(key) === read) {
					this.#dirInflight.delete(key);
					this.#dirInflightGeneration.delete(key);
				}
			});
		this.#dirInflight.set(key, read);
		this.#dirInflightGeneration.set(key, generation);
		return untilAborted(signal, read);
	}

	#evictDirCacheOverflow(): void {
		if (this.#dirCache.size <= 100) return;
		const sortedKeys = [...this.#dirCache.entries()]
			.sort((a, b) => a[1].timestamp - b[1].timestamp)
			.slice(0, 50)
			.map(([key]) => key);
		for (const key of sortedKeys) {
			this.#dirCache.delete(key);
		}
	}

	invalidateDirCache(dir?: string): void {
		// Bump the epoch unconditionally: in-flight reads started before this
		// call must not publish into the cache afterwards. A targeted
		// invalidation also drops that directory's cached entries.
		this.#dirCacheEpoch++;
		if (dir) {
			this.#dirCache.delete(path.resolve(dir));
		} else {
			this.#dirCache.clear();
		}
	}

	async #getFileSuggestions(prefix: string, signal?: AbortSignal): Promise<AutocompleteItem[]> {
		try {
			let searchDir: string;
			let searchPrefix: string;
			const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
			let expandedPrefix = rawPrefix;

			expandedPrefix = expandedPrefix.replace(/\\/g, "/");

			const preExpand = expandedPrefix;

			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.#expandHomePath(expandedPrefix);
			}

			const isRootPrefix =
				preExpand === "" ||
				preExpand === "./" ||
				preExpand === "../" ||
				preExpand === "~" ||
				preExpand === "~/" ||
				preExpand === "/" ||
				(isAtPrefix && preExpand === "");

			if (isRootPrefix) {
				if (expandedPrefix.startsWith("~") || path.isAbsolute(expandedPrefix)) {
					searchDir = expandedPrefix;
				} else {
					searchDir = path.join(this.#basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (expandedPrefix.endsWith("/")) {
				if (expandedPrefix.startsWith("~") || path.isAbsolute(expandedPrefix)) {
					searchDir = expandedPrefix;
				} else {
					searchDir = path.join(this.#basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				const dir = path.dirname(expandedPrefix);
				const file = path.basename(expandedPrefix);
				if (expandedPrefix.startsWith("~") || path.isAbsolute(expandedPrefix)) {
					searchDir = dir;
				} else {
					searchDir = path.join(this.#basePath, dir);
				}
				searchPrefix = file;
			}

			if (signal?.aborted) return [];
			const entries = await this.#getCachedDirEntries(searchDir, signal);
			if (signal?.aborted) return [];
			const suggestions: AutocompleteItem[] = [];

			const matched = entries.filter(
				entry => entry.name !== ".git" && entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase()),
			);

			// Symlink classification costs one stat per link; bound the
			// concurrency and stop scheduling once the request is aborted so a
			// directory of N links cannot serialize N round trips per keystroke.
			const symlinkFullPaths = new Map<string, string>();
			for (const entry of matched) {
				if (!entry.isDirectory() && entry.isSymbolicLink()) {
					symlinkFullPaths.set(entry.name, path.join(searchDir, entry.name));
				}
			}
			const symlinkIsDir = new Map<string, boolean>();
			const symlinkNames = [...symlinkFullPaths.keys()];
			let classifyCursor = 0;
			const classifyNext = async (): Promise<void> => {
				while (classifyCursor < symlinkNames.length) {
					if (signal?.aborted) return;
					const name = symlinkNames[classifyCursor++];
					try {
						const stat = await untilAborted(signal, fs.promises.stat(symlinkFullPaths.get(name)!));
						symlinkIsDir.set(name, stat.isDirectory());
					} catch {
						// Broken link or aborted: dropped from suggestions below.
					}
				}
			};
			await Promise.all(
				Array.from({ length: Math.min(this.#SYMLINK_STAT_CONCURRENCY, symlinkFullPaths.size) }, classifyNext),
			);
			if (signal?.aborted) return [];

			for (const entry of matched) {
				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					const classified = symlinkIsDir.get(entry.name);
					if (classified === undefined) continue;
					isDirectory = classified;
				}

				let relativePath: string;
				const name = entry.name;
				const displayPrefix = rawPrefix.replace(/\\/g, "/");

				if (displayPrefix.endsWith("/")) {
					relativePath = displayPrefix + name;
				} else if (displayPrefix.includes("/")) {
					if (displayPrefix.startsWith("~/")) {
						const homeRelativeDir = displayPrefix.slice(2);
						const dir = path.dirname(homeRelativeDir);
						relativePath = `~/${dir === "." ? name : path.join(dir, name)}`;
					} else if (path.isAbsolute(displayPrefix)) {
						const dir = displayPrefix.slice(0, displayPrefix.lastIndexOf("/"));
						relativePath = dir === "" || dir === "/" ? `/${name}` : `${dir}/${name}`;
					} else {
						relativePath = path.join(path.dirname(displayPrefix), name);
						if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
							relativePath = `./${relativePath}`;
						}
					}
				} else {
					if (displayPrefix.startsWith("~")) {
						relativePath = `~/${name}`;
					} else {
						relativePath = name;
					}
				}

				relativePath = relativePath.replace(/\\/g, "/");
				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				const value = buildCompletionValue(pathValue, {
					isDirectory,
					isAtPrefix,
					isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: name + (isDirectory ? "/" : ""),
				});
			}

			suggestions.sort((a, b) => {
				const aIsDir = a.value.endsWith("/");
				const bIsDir = b.value.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch {
			return [];
		}
	}

	async #getFuzzyFileSuggestions(
		query: string,
		options: { isQuotedPrefix: boolean; signal?: AbortSignal },
	): Promise<AutocompleteItem[]> {
		try {
			const scopedQuery = await this.#resolveScopedFuzzyQuery(query, options.signal);
			if (options.signal?.aborted) return [];
			const searchPath = scopedQuery?.baseDir ?? this.#basePath;
			const fuzzyQuery = scopedQuery?.query ?? query;
			const result = await fuzzyFind(buildAutocompleteFuzzyDiscoveryProfile(fuzzyQuery, searchPath, options.signal));
			const lowerQuery = fuzzyQuery.toLowerCase();
			const filteredMatches = result.matches.filter(entry => {
				const p = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
				const normalized = p.replaceAll("\\", "/");
				if (/(^|\/)\.git(\/|$)/.test(normalized)) {
					return false;
				}
				return lowerQuery.length === 0 || fuzzyMatch(lowerQuery, normalized.toLowerCase());
			});

			const topEntries = filteredMatches;
			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory } of topEntries) {
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				const displayPath = scopedQuery
					? this.#scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: pathWithoutSlash;
				const entryName = path.basename(pathWithoutSlash);
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const value = buildCompletionValue(completionPath, {
					isDirectory,
					isAtPrefix: true,
					isQuotedPrefix: options.isQuotedPrefix,
				});
				suggestions.push({
					value,
					label: entryName + (isDirectory ? "/" : ""),
					description: displayPath,
				});
			}
			return suggestions;
		} catch {
			return [];
		}
	}

	async getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		if (signal?.aborted) return null;
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return null;
		}

		const pathMatch = this.#extractPathPrefix(textBeforeCursor, true);
		if (pathMatch !== null) {
			const suggestions = await this.#getFileSuggestions(pathMatch, signal);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}

	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const slashStart = findLeadingSlashCommandStart(textBeforeCursor);
		if (slashStart === null) return null;

		const commandText = textBeforeCursor.slice(slashStart);
		const spaceIndex = commandText.indexOf(" ");
		if (spaceIndex === -1) return null;

		const commandName = commandText.slice(1, spaceIndex);
		const argumentText = commandText.slice(spaceIndex + 1);

		const command = this.#commands.find(cmd => commandMatchesNameOrAlias(cmd, commandName));

		if (!command || !("getInlineHint" in command) || !command.getInlineHint) {
			return null;
		}

		return command.getInlineHint(argumentText);
	}
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		const slashStart = findLeadingSlashCommandStart(textBeforeCursor);
		if (slashStart === null) return null;
		const commandText = textBeforeCursor.slice(slashStart);
		if (commandText.length <= 1) return null;
		if (commandText.includes(" ")) return null;

		const prefix = commandText.slice(1);
		const lowerPrefix = prefix.toLowerCase();

		const matches = buildSlashCommandCompletions(
			collapseSkillNamespace(this.#commands, lowerPrefix),
			lowerPrefix,
			this.#commandUsage,
		).filter(item => item.value !== SKILL_NAMESPACE);

		if (matches.length === 0) return null;

		return { items: matches, prefix: textBeforeCursor };
	}
}
