import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fuzzyFind } from "@oh-my-pi/pi-natives";
import { getProjectDir } from "@oh-my-pi/pi-utils";

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
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	argumentHint?: string;

	allowArgs?: boolean;

	getAutocompleteDescription?: () => string | undefined;

	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;

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
			const nameScore =
				lowerPrefix.length === 0 && isSkillCommand ? 950 : scoreCommandTextMatch(lowerPrefix, name.toLowerCase());
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

			if (lowerPrefix.length > 0) {
				for (const alias of getCommandAliases(cmd)) {
					if (alias === name) continue;
					const aliasScore = scoreCommandTextMatch(lowerPrefix, alias.toLowerCase());
					if (aliasScore === 0 || (best && aliasScore <= best.score)) continue;
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

			return best ? [best] : [];
		})

		.sort((a, b) => b.score - a.score || b.usage - a.usage)
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

function collapseSkillNamespace(commands: CommandEntry[], lowerPrefix: string): CommandEntry[] {
	if (lowerPrefix.startsWith(SKILL_NAMESPACE)) return commands;
	let skillCount = 0;
	const rest = commands.filter(cmd => {
		if (!getCommandName(cmd)?.startsWith(SKILL_NAMESPACE)) return true;
		skillCount += 1;
		return false;
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
	return lowerName.startsWith(SKILL_NAMESPACE) && lowerName.slice(SKILL_NAMESPACE.length).startsWith(lowerToken);
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
	readonly #DIR_CACHE_TTL = 2000;

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
					const argumentSuggestions = await command.getArgumentCompletions(argumentText);
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
				const items = await this.#getFileSuggestions(atPrefix);
				if (items.length === 0) return null;
				return { items, prefix: atPrefix };
			}
			const suggestions =
				rawPrefix.length > 0
					? await this.#getFuzzyFileSuggestions(rawPrefix, { isQuotedPrefix, signal })
					: await this.#getFileSuggestions("@");
			if (suggestions.length === 0 && rawPrefix.length > 0) {
				const fallback = await this.#getFileSuggestions(atPrefix);
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
			const suggestions = await this.#getFileSuggestions(pathMatch);
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

			const newLine = `${beforePrefix + item.value} ${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 1,
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
			if (!(await fs.promises.stat(baseDir)).isDirectory()) {
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

	async #getCachedDirEntries(searchDir: string): Promise<fs.Dirent[]> {
		const now = Date.now();
		const cached = this.#dirCache.get(searchDir);

		if (cached && now - cached.timestamp < this.#DIR_CACHE_TTL) {
			return cached.entries;
		}

		const entries = await fs.promises.readdir(searchDir, { withFileTypes: true });
		this.#dirCache.set(searchDir, { entries, timestamp: now });

		if (this.#dirCache.size > 100) {
			const sortedKeys = [...this.#dirCache.entries()]
				.sort((a, b) => a[1].timestamp - b[1].timestamp)
				.slice(0, 50)
				.map(([key]) => key);
			for (const key of sortedKeys) {
				this.#dirCache.delete(key);
			}
		}

		return entries;
	}

	invalidateDirCache(dir?: string): void {
		if (dir) {
			this.#dirCache.delete(dir);
		} else {
			this.#dirCache.clear();
		}
	}

	async #getFileSuggestions(prefix: string): Promise<AutocompleteItem[]> {
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

			const entries = await this.#getCachedDirEntries(searchDir);
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}

				if (entry.name === ".git") {
					continue;
				}

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						const fullPath = path.join(searchDir, entry.name);
						isDirectory = (await fs.promises.stat(fullPath)).isDirectory();
					} catch {
						continue;
					}
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
			const scopedQuery = await this.#resolveScopedFuzzyQuery(query);
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
			const suggestions = await this.#getFileSuggestions(pathMatch);
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
