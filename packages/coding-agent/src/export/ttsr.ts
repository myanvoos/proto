import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Rule } from "../capability/rule";
import type { TtsrSettings } from "../config/settings";
import {
	compileLegacyProgram,
	compileMatchProgram,
	evaluateProgram,
	type JudgeFn,
	MatchContext,
	type MatchEvidence,
	type MatchProgram,
	matchProgram,
	type ToolCallRecord,
} from "./ttsr-matcher";
import { matchesPathGlob, resolveTargetPaths, type TargetPath } from "./ttsr-paths";

export type TtsrMatchSource = "text" | "thinking" | "tool";

export interface TtsrMatchContext {
	source: TtsrMatchSource;

	toolName?: string;

	filePaths?: string[];

	streamKey?: string;

	/** Session directory; target paths and `under:`/`outside:` roots resolve against it. */
	cwd?: string;

	/** Answers `llm:` leaves. Without one they settle as "no match". */
	judge?: JudgeFn;

	/** The buffer is final. `llm:` leaves only resolve against settled buffers. */
	settled?: boolean;

	/** The session's earlier tool calls, for `did:` leaves; read only when one is evaluated. */
	history?: () => readonly ToolCallRecord[];
	/** Cancels in-flight `llm:` judges when the turn they belong to ends. */
	signal?: AbortSignal;
}

/** A rule that fired, with the buffer spans that tripped it. */
export interface TtsrMatch {
	rule: Rule;
	evidence: MatchEvidence;
}

export interface TtsrRuleEntry {
	rule: Rule;
	program: MatchProgram;
}

interface ToolScope {
	toolName?: string;
	pathGlob?: Bun.Glob;
	pathPattern?: string;
}

interface TtsrScope {
	allowText: boolean;
	allowThinking: boolean;
	allowAnyTool: boolean;
	toolScopes: ToolScope[];
}

interface TtsrEntry {
	rule: Rule;
	program: MatchProgram;
	scope: TtsrScope;
	globalPathGlobs?: Bun.Glob[];
	incrementalLiterals: string[];
	literalOverlap: number;
}

interface InjectionRecord {
	lastInjectedAt: number;
}

interface TtsrLiteralScan {
	tail: string;
	processedLength: number;
	seen: boolean;
}

interface TtsrCandidateCache {
	revision: number;
	source: TtsrMatchSource;
	toolName?: string;
	filePaths?: string[];
	cwd?: string;
	settled: boolean;
	candidates: TtsrEntry[];
}

interface TtsrBuffer {
	chunks: string[];
	pending: string[];
	length: number;
	materialized?: string;
	literalScans: Map<TtsrEntry, TtsrLiteralScan>;
	syncCandidates?: TtsrCandidateCache;
	asyncCandidates?: TtsrCandidateCache;
}

const BUFFER_CHUNK_PARTS = 256;
const REGEX_META_CHARACTERS = new Set("\\^$.*+?()[]{}|");

function strongestIncrementalLiterals(nodes: readonly MatchProgram["root"][]): string[] {
	let best: string[] = [];
	for (const node of nodes) {
		const literals = incrementalLiteralsOf(node);
		if (literals.length === 0) continue;
		const selectivity = Math.min(...literals.map(literal => literal.length));
		const bestSelectivity = best.length === 0 ? -1 : Math.min(...best.map(literal => literal.length));
		if (selectivity > bestSelectivity) best = literals;
	}
	return best;
}

function incrementalLiteralsOf(node: MatchProgram["root"]): string[] {
	switch (node.kind) {
		case "regex":
			if (node.patterns.some(pattern => pattern.ignoreCase)) return [];
			if (
				node.sources.some(
					source => source.length === 0 || Array.from(source).some(char => REGEX_META_CHARACTERS.has(char)),
				)
			) {
				return [];
			}
			return node.sources;
		case "all":
			return strongestIncrementalLiterals(node.children);
		case "any": {
			const literals: string[] = [];
			for (const child of node.children) {
				const childLiterals = incrementalLiteralsOf(child);
				if (childLiterals.length === 0) return [];
				literals.push(...childLiterals);
			}
			return literals;
		}
		case "if": {
			if (!node.else) return strongestIncrementalLiterals([node.guard, node.then]);
			const thenLiterals = incrementalLiteralsOf(node.then);
			const elseLiterals = incrementalLiteralsOf(node.else);
			return thenLiterals.length > 0 && elseLiterals.length > 0 ? [...thenLiterals, ...elseLiterals] : [];
		}
		default:
			return [];
	}
}

const DEFAULT_SETTINGS: Required<TtsrSettings> = {
	enabled: true,
	contextMode: "discard",
	interruptMode: "always",
	repeatMode: "once",
	repeatGap: 10,
	builtinRules: true,
	disabledRules: [],
};

const DEFAULT_SCOPE: TtsrScope = {
	allowText: true,
	allowThinking: false,
	allowAnyTool: true,
	toolScopes: [],
};

export class TtsrManager {
	readonly #settings: Required<TtsrSettings>;
	readonly #rules = new Map<string, TtsrEntry>();
	readonly #injectionRecords = new Map<string, InjectionRecord>();
	readonly #buffers = new Map<string, TtsrBuffer>();

	readonly #lastAsyncSnapshots = new Map<string, string>();
	#candidateRevision = 0;
	#messageCount = 0;
	#canMatchText = false;
	#canMatchThinking = false;

	constructor(settings?: TtsrSettings) {
		this.#settings = { ...DEFAULT_SETTINGS, ...settings };
	}

	#canTrigger(ruleName: string): boolean {
		const record = this.#injectionRecords.get(ruleName);
		if (!record) {
			return true;
		}

		if (this.#settings.repeatMode === "once") {
			return false;
		}

		const gap = this.#messageCount - record.lastInjectedAt;
		return gap >= this.#settings.repeatGap;
	}

	#compileGlobalPathGlobs(globs: Rule["globs"]): Bun.Glob[] | undefined {
		if (!globs || globs.length === 0) {
			return undefined;
		}

		const compiled = globs
			.map(glob => glob.trim())
			.filter(glob => glob.length > 0)
			.map(glob => new Bun.Glob(glob));
		return compiled.length > 0 ? compiled : undefined;
	}

	#parseToolScopeToken(token: string): ToolScope | undefined {
		const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(
			token,
		);
		if (!match) {
			return undefined;
		}

		const groups = match.groups;
		const hasToolPrefix = groups?.prefix !== undefined;
		const toolName = (groups?.tool ?? (hasToolPrefix ? undefined : groups?.bare))?.trim().toLowerCase();
		const pathPattern = groups?.path?.trim();

		if (!pathPattern) {
			return { toolName };
		}

		return {
			toolName,
			pathPattern,
			pathGlob: new Bun.Glob(pathPattern),
		};
	}

	#buildScope(rule: Rule): TtsrScope {
		if (!rule.scope || rule.scope.length === 0) {
			return {
				allowText: DEFAULT_SCOPE.allowText,
				allowThinking: DEFAULT_SCOPE.allowThinking,
				allowAnyTool: DEFAULT_SCOPE.allowAnyTool,
				toolScopes: [...DEFAULT_SCOPE.toolScopes],
			};
		}

		const scope: TtsrScope = {
			allowText: false,
			allowThinking: false,
			allowAnyTool: false,
			toolScopes: [],
		};

		for (const rawToken of rule.scope) {
			const token = rawToken.trim();
			const normalizedToken = token.toLowerCase();
			if (token.length === 0) {
				continue;
			}

			if (normalizedToken === "text") {
				scope.allowText = true;
				continue;
			}

			if (normalizedToken === "thinking") {
				scope.allowThinking = true;
				continue;
			}

			if (normalizedToken === "tool" || normalizedToken === "toolcall") {
				scope.allowAnyTool = true;
				continue;
			}

			const toolScope = this.#parseToolScopeToken(token);
			if (!toolScope) {
				logger.warn("TTSR scope token is invalid, skipping token", {
					ruleName: rule.name,
					token: rawToken,
				});
				continue;
			}

			if (!toolScope.toolName && !toolScope.pathGlob) {
				scope.allowAnyTool = true;
				continue;
			}

			scope.toolScopes.push(toolScope);
		}

		return scope;
	}

	#hasReachableScope(scope: TtsrScope): boolean {
		return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0;
	}

	#bufferKey(context: TtsrMatchContext): string {
		if (context.streamKey && context.streamKey.trim().length > 0) {
			return context.streamKey;
		}
		if (context.source !== "tool") {
			return context.source;
		}
		const toolName = context.toolName?.trim().toLowerCase();
		return toolName ? `tool:${toolName}` : "tool";
	}

	#createBuffer(snapshot = ""): TtsrBuffer {
		return {
			chunks: snapshot.length > 0 ? [snapshot] : [],
			pending: [],
			length: snapshot.length,
			materialized: snapshot,
			literalScans: new Map(),
		};
	}

	#getBuffer(bufferKey: string): TtsrBuffer {
		let buffer = this.#buffers.get(bufferKey);
		if (!buffer) {
			buffer = this.#createBuffer();
			this.#buffers.set(bufferKey, buffer);
		}
		return buffer;
	}

	#replaceBuffer(bufferKey: string, snapshot: string): TtsrBuffer {
		const buffer = this.#getBuffer(bufferKey);
		buffer.chunks = snapshot.length > 0 ? [snapshot] : [];
		buffer.pending = [];
		buffer.length = snapshot.length;
		buffer.materialized = snapshot;
		buffer.literalScans.clear();
		return buffer;
	}

	#appendBuffer(buffer: TtsrBuffer, delta: string): void {
		buffer.pending.push(delta);
		buffer.length += delta.length;
		buffer.materialized = undefined;
		if (buffer.pending.length >= BUFFER_CHUNK_PARTS) {
			buffer.chunks.push(buffer.pending.join(""));
			buffer.pending = [];
		}
	}

	#materializeBuffer(buffer: TtsrBuffer): string {
		if (buffer.materialized !== undefined) return buffer.materialized;
		const pending = buffer.pending.join("");
		const materialized = buffer.chunks.length > 0 ? `${buffer.chunks.join("")}${pending}` : pending;
		buffer.chunks = materialized.length > 0 ? [materialized] : [];
		buffer.pending = [];
		buffer.materialized = materialized;
		return materialized;
	}

	#sameCandidateContext(cache: TtsrCandidateCache, context: TtsrMatchContext): boolean {
		if (
			cache.revision !== this.#candidateRevision ||
			cache.source !== context.source ||
			cache.toolName !== context.toolName ||
			cache.cwd !== context.cwd ||
			cache.settled !== (context.settled === true)
		) {
			return false;
		}
		const cachedPaths = cache.filePaths;
		const currentPaths = context.filePaths;
		if (!cachedPaths || !currentPaths) return cachedPaths === undefined && currentPaths === undefined;
		if (cachedPaths.length !== currentPaths.length) return false;
		return cachedPaths.every((filePath, index) => filePath === currentPaths[index]);
	}

	#cachedCandidates(buffer: TtsrBuffer, context: TtsrMatchContext, asyncOnly: boolean): TtsrEntry[] {
		const cached = asyncOnly ? buffer.asyncCandidates : buffer.syncCandidates;
		if (cached && this.#sameCandidateContext(cached, context)) return cached.candidates;

		const targets = resolveTargetPaths(context.filePaths, context.cwd);
		const next: TtsrCandidateCache = {
			revision: this.#candidateRevision,
			source: context.source,
			toolName: context.toolName,
			filePaths: context.filePaths ? [...context.filePaths] : undefined,
			cwd: context.cwd,
			settled: context.settled === true,
			candidates: this.#candidates(context, targets, asyncOnly),
		};
		if (asyncOnly) buffer.asyncCandidates = next;
		else buffer.syncCandidates = next;
		return next.candidates;
	}

	#matchesGlobalPaths(entry: TtsrEntry, targets: readonly TargetPath[]): boolean {
		if (!entry.globalPathGlobs || entry.globalPathGlobs.length === 0) {
			return true;
		}

		for (const glob of entry.globalPathGlobs) {
			if (matchesPathGlob(glob, targets)) {
				return true;
			}
		}

		return false;
	}

	#matchesScope(entry: TtsrEntry, context: TtsrMatchContext, targets: readonly TargetPath[]): boolean {
		if (context.source === "text") {
			return entry.scope.allowText;
		}

		if (context.source === "thinking") {
			return entry.scope.allowThinking;
		}

		if (entry.scope.allowAnyTool) {
			return true;
		}

		const toolName = context.toolName?.trim().toLowerCase();
		for (const toolScope of entry.scope.toolScopes) {
			if (toolScope.toolName && toolScope.toolName !== toolName) {
				continue;
			}
			if (toolScope.pathGlob && !matchesPathGlob(toolScope.pathGlob, targets)) {
				continue;
			}
			return true;
		}

		return false;
	}

	/** Candidate entries for this buffer: eligible to re-trigger, in scope, and path-gated. */
	#candidates(context: TtsrMatchContext, targets: readonly TargetPath[], asyncOnly: boolean): TtsrEntry[] {
		const lang = asyncOnly ? deriveLang(context.filePaths) : undefined;
		const judgeable = asyncOnly && context.settled === true;
		const candidates: TtsrEntry[] = [];
		for (const [name, entry] of this.#rules) {
			// An AST leaf needs a language to parse; a judge leaf needs a settled buffer.
			if (asyncOnly && !(entry.program.needsJudge && judgeable) && !(entry.program.needsAst && lang)) continue;
			if (
				!this.#canTrigger(name) ||
				!this.#matchesScope(entry, context, targets) ||
				!this.#matchesGlobalPaths(entry, targets)
			) {
				continue;
			}
			candidates.push(entry);
		}
		return candidates;
	}

	#context(buffer: string, context: TtsrMatchContext): MatchContext {
		return new MatchContext({
			text: buffer,
			source: context.source,
			lang: deriveLang(context.filePaths),
			filePaths: context.filePaths,
			toolName: context.toolName,
			cwd: context.cwd,
			judge: context.judge,
			signal: context.signal,
			history: context.history,
		});
	}

	addRule(rule: Rule): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		if (this.#rules.has(rule.name)) {
			return false;
		}

		const compiled =
			rule.match !== undefined
				? compileMatchProgram(rule.match, rule.name)
				: compileLegacyProgram(rule.condition, rule.astCondition);
		for (const error of compiled.errors) {
			logger.warn("TTSR condition failed to compile, skipping it", { ruleName: rule.name, error });
		}
		if (!compiled.program) {
			return false;
		}

		const scope = this.#buildScope(rule);
		if (!this.#hasReachableScope(scope)) {
			logger.warn("TTSR scope excludes all streams, skipping rule", {
				ruleName: rule.name,
				scope: rule.scope,
			});
			return false;
		}
		const globalPathGlobs = this.#compileGlobalPathGlobs(rule.globs);
		const incrementalLiterals = incrementalLiteralsOf(compiled.program.root);
		this.#rules.set(rule.name, {
			rule,
			program: compiled.program,
			scope,
			globalPathGlobs,
			incrementalLiterals,
			literalOverlap: incrementalLiterals.reduce((longest, literal) => Math.max(longest, literal.length - 1), 0),
		});
		this.#candidateRevision++;
		if (scope.allowText) this.#canMatchText = true;
		if (scope.allowThinking) this.#canMatchThinking = true;

		logger.debug("TTSR rule registered", {
			ruleName: rule.name,
			condition: compiled.program.description,
			scope: rule.scope,
			globs: rule.globs,
		});

		return true;
	}

	#mayMatchDelta(entry: TtsrEntry, buffer: TtsrBuffer, delta: string, previousLength: number): boolean {
		const literals = entry.incrementalLiterals;
		if (literals.length === 0) return true;

		let scan = buffer.literalScans.get(entry);
		if (scan?.seen) {
			scan.processedLength = buffer.length;
			return true;
		}

		let window: string;
		if (!scan && previousLength === 0) {
			window = delta;
		} else if (scan?.processedLength === previousLength) {
			window = `${scan.tail}${delta}`;
		} else {
			// The rule was out of scope for part of this stream. Re-entering scope is
			// rare, and rescanning once preserves matches from the skipped prefix.
			window = this.#materializeBuffer(buffer);
		}

		const seen = literals.some(literal => window.includes(literal));
		const tail = entry.literalOverlap > 0 ? window.slice(-entry.literalOverlap) : "";
		if (scan) {
			scan.tail = tail;
			scan.processedLength = buffer.length;
			scan.seen = seen;
		} else {
			scan = { tail, processedLength: buffer.length, seen };
			buffer.literalScans.set(entry, scan);
		}
		return seen;
	}

	checkDelta(delta: string, context: TtsrMatchContext): TtsrMatch[] {
		if (context.source === "text" && !this.#canMatchText) {
			return [];
		}
		if (context.source === "thinking" && !this.#canMatchThinking) {
			return [];
		}
		const buffer = this.#getBuffer(this.#bufferKey(context));
		const previousLength = buffer.length;
		this.#appendBuffer(buffer, delta);
		if (!this.#settings.enabled) return [];

		const candidates = this.#cachedCandidates(buffer, context, false);
		if (candidates.length === 0) return [];

		// A program's literals are necessary, never sufficient. Before one appears,
		// only the bounded overlap can contain a new cross-delta occurrence. Once
		// one appears, arbitrary regex width/count/region semantics stay on the full
		// prefix path so matching behavior and evidence remain unchanged.
		const possible: TtsrEntry[] = [];
		for (const entry of candidates) {
			if (this.#mayMatchDelta(entry, buffer, delta, previousLength)) possible.push(entry);
		}
		if (possible.length === 0) return [];
		return this.#matchCandidates(this.#materializeBuffer(buffer), context, possible);
	}

	checkSnapshot(snapshot: string, context: TtsrMatchContext): TtsrMatch[] {
		const buffer = this.#replaceBuffer(this.#bufferKey(context), snapshot);
		if (!this.#settings.enabled) return [];
		const candidates = this.#cachedCandidates(buffer, context, false);
		return this.#matchCandidates(snapshot, context, candidates);
	}

	/**
	 * Resolve the conditions that cannot settle synchronously — `ast:` leaves
	 * against a reconstructed source snapshot, `llm:` leaves against the judge.
	 * Conditions that need neither already settled in `checkSnapshot`.
	 */
	async checkAsyncSnapshot(snapshot: string, context: TtsrMatchContext): Promise<TtsrMatch[]> {
		if (!this.#settings.enabled) {
			return [];
		}

		const streamKey = this.#bufferKey(context);
		const candidates = this.#cachedCandidates(this.#getBuffer(streamKey), context, true);
		if (candidates.length === 0) {
			return [];
		}

		// The streaming and settled passes resolve different leaves, so the settled
		// pass must not be skipped just because the stream already saw this buffer.
		const resolveJudge = context.settled === true;
		const bufferKey = `${streamKey}\u0000${resolveJudge ? "settled" : "stream"}`;
		if (this.#lastAsyncSnapshots.get(bufferKey) === snapshot) {
			return [];
		}
		this.#lastAsyncSnapshots.set(bufferKey, snapshot);

		const ctx = this.#context(snapshot, context);
		const matches: TtsrMatch[] = [];
		for (const entry of candidates) {
			const evidence = await matchProgram(entry.program, ctx, { resolveJudge });
			if (!evidence) continue;
			matches.push({ rule: entry.rule, evidence });
			logger.debug("TTSR async condition matched", {
				ruleName: entry.rule.name,
				condition: entry.program.description,
				toolName: context.toolName,
				filePaths: context.filePaths,
			});
		}
		return matches;
	}

	/** Whether any registered rule has a condition that only an async pass can settle. */
	hasAsyncRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		for (const entry of this.#rules.values()) {
			if (entry.program.needsAst || entry.program.needsJudge) {
				return true;
			}
		}
		return false;
	}

	/** Whether any registered rule asks a model judge, which only settled buffers resolve. */
	hasJudgeRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		for (const entry of this.#rules.values()) {
			if (entry.program.needsJudge) {
				return true;
			}
		}
		return false;
	}

	#matchCandidates(buffer: string, context: TtsrMatchContext, candidates: readonly TtsrEntry[]): TtsrMatch[] {
		if (!this.#settings.enabled || candidates.length === 0) {
			return [];
		}
		const ctx = this.#context(buffer, context);
		const matches: TtsrMatch[] = [];
		for (const entry of candidates) {
			const evidence = evaluateProgram(entry.program, ctx);
			if (!evidence) continue;

			matches.push({ rule: entry.rule, evidence });
			logger.debug("TTSR condition matched", {
				ruleName: entry.rule.name,
				condition: entry.program.description,
				source: context.source,
				toolName: context.toolName,
				filePaths: context.filePaths,
			});
		}

		return matches;
	}

	markInjected(rulesToMark: readonly Rule[]): void {
		this.markInjectedByNames(rulesToMark.map(rule => rule.name));
	}

	markInjectedByNames(ruleNames: string[]): void {
		let changed = false;
		for (const rawName of ruleNames) {
			const ruleName = rawName.trim();
			if (ruleName.length === 0) {
				continue;
			}
			const record = this.#injectionRecords.get(ruleName);
			if (!record) {
				this.#injectionRecords.set(ruleName, { lastInjectedAt: this.#messageCount });
			} else {
				record.lastInjectedAt = this.#messageCount;
			}
			changed = true;
			logger.debug("TTSR rule marked as injected", {
				ruleName,
				messageCount: this.#messageCount,
				repeatMode: this.#settings.repeatMode,
			});
		}
		if (changed) this.#candidateRevision++;
	}

	getInjectedRuleNames(): string[] {
		return Array.from(this.#injectionRecords.keys());
	}

	restoreInjected(ruleNames: string[]): void {
		for (const name of ruleNames) {
			this.#injectionRecords.set(name, { lastInjectedAt: 0 });
		}
		if (ruleNames.length > 0) {
			this.#candidateRevision++;
			logger.debug("TTSR injected state restored", { ruleNames });
		}
	}

	/**
	 * Resets stream buffers at every stream boundary: a new turn, a new assistant message within a turn, and a
	 * restarted response. Buffers never span two assistant messages; repeat-after-gap counters are untouched.
	 */
	resetBuffer(): void {
		this.#buffers.clear();
		this.#lastAsyncSnapshots.clear();
	}

	hasRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		return this.#rules.size > 0;
	}

	getRules(): Rule[] {
		return Array.from(this.#rules.values(), entry => entry.rule);
	}

	/** Registered rules with their compiled conditions, for `proto ttsr list`/`scan`. */
	getEntries(): TtsrRuleEntry[] {
		return Array.from(this.#rules.values(), entry => ({ rule: entry.rule, program: entry.program }));
	}

	incrementMessageCount(): void {
		this.#messageCount++;
		this.#candidateRevision++;
	}

	getMessageCount(): number {
		return this.#messageCount;
	}

	getSettings(): Required<TtsrSettings> {
		return this.#settings;
	}
}

/** Language for grammar selection and lexical classification, from the first extension-bearing path. */
export function deriveLang(filePaths: readonly string[] | undefined): string | undefined {
	for (const filePath of filePaths ?? []) {
		const ext = path.extname(filePath.replaceAll("\\", "/"));
		if (ext.length > 1) {
			return ext.slice(1).toLowerCase();
		}
	}
	return undefined;
}
