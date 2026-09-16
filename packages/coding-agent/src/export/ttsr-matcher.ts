/**
 * TTSR condition engine.
 *
 * A rule condition is an expression tree, not a regex list. Leaves locate spans
 * in the stream buffer (`regex`, `ast`), test the buffer's context (`lang`,
 * `path`), or test what the session already did (`did`); operators (`all`,
 * `any`, `not`, `if`) combine them; modifiers (`in`,
 * `count`, `inside`, `has`, …) filter the located spans. Evaluation returns the
 * spans that survived, so a firing rule can quote the code that tripped it.
 *
 * AST leaves are resolved up front (`prepareProgram`) and evaluation itself is
 * synchronous, which keeps the regex-only fast path off the event loop while
 * letting a single evaluator serve both.
 */

import { AstMatchStrictness, astMatch } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { compileRuleCondition } from "../capability/rule";
import { isUnderRoot, matchesTarget, resolveRootDir, resolveTargetPaths, type TargetPath } from "./ttsr-paths";
import {
	classifyRegions,
	type RegionKind,
	type RegionMode,
	regionModeFor,
	type SyntaxRegion,
	spanRegionKind,
} from "./ttsr-regions";

export type MatchSource = "text" | "thinking" | "tool";

/** Raw `match:` frontmatter value, before compilation. */
export type RuleMatchSpec = unknown;

export interface Span {
	start: number;
	end: number;
}

export interface MatchSnippet {
	line: number;
	text: string;
}

export interface MatchEvidence {
	snippets: MatchSnippet[];
}

export interface MatchInput {
	text: string;
	source: MatchSource;
	lang?: string;
	filePaths?: readonly string[];
	toolName?: string;
	/** Session directory; target paths and `under:`/`outside:` roots resolve against it. */
	cwd?: string;
	/** Resolves `llm:` leaves. Without one they settle as "no match". */
	judge?: JudgeFn;
	/** Cancels in-flight judges; the caller aborting must not wait on a model. */
	signal?: AbortSignal;
	/**
	 * The session's earlier tool calls, oldest first, for `did:` leaves. Read
	 * lazily, so a session whose rules never ask about history never builds it.
	 */
	history?: () => readonly ToolCallRecord[];
}

/** One `llm:` leaf, asked about the buffer under evaluation. */
export interface JudgeRequest {
	question: string;
	/** Model roles to try in order; the first that resolves answers. */
	roles: readonly string[];
	text: string;
	source: MatchSource;
	lang?: string;
	toolName?: string;
	filePaths?: readonly string[];
}

/** `undefined` means the judge could not answer; the leaf then counts as no match. */
export type JudgeFn = (request: JudgeRequest, signal?: AbortSignal) => Promise<boolean | undefined>;

/** One tool call the session already made, as a `did:` condition sees it. */
export interface ToolCallRecord {
	name: string;
	/** Paths the call named, in the spelling the model used. */
	paths?: readonly string[];
	/** The call's arguments, serialized by the host; `did: { args: … }` tests this string. */
	args?: string;
}

interface AstHit {
	start: number;
	end: number;
	metaVariables?: Record<string, string>;
}

interface NodeModifiers {
	count: number;
	/** Evaluation cost class, set by `withModifiers`; cheap leaves sort first. */
	cost: number;
	inside?: CompiledNode;
	notInside?: CompiledNode;
	has?: CompiledNode;
	notHas?: CompiledNode;
}

interface RegexNode extends NodeModifiers {
	kind: "regex";
	patterns: RegExp[];
	sources: string[];
	/** Accepted lexical regions; `undefined` accepts every region. */
	regions?: RegionKind[];
}

interface MetaConstraint {
	name: string;
	regex?: RegExp;
	notRegex?: RegExp;
}

interface AstNode extends NodeModifiers {
	kind: "ast";
	patterns: string[];
	strictness: AstMatchStrictness;
	selector?: string;
	where: MetaConstraint[];
}

interface LangNode extends NodeModifiers {
	kind: "lang";
	langs: string[];
}

/** The path tests a `path:` leaf applies, reused by `did: { path: … }`. */
interface PathPredicate {
	globs?: Bun.Glob[];
	globSources?: string[];
	patterns?: RegExp[];
	patternSources?: string[];
	/** Directories the path must sit under; any one satisfies the test. */
	under?: string[];
	/** Directories the path must escape; it must sit under none of them. */
	outside?: string[];
}

interface PathNode extends NodeModifiers, PathPredicate {
	kind: "path";
}

/** One recorded call with its paths already resolved against the session cwd. */
const NO_HISTORY: readonly ToolCallRecord[] = Object.freeze([]);

/** Entries mapped per host history array, keyed weakly so they die with it. */
const HISTORY_ENTRIES = new WeakMap<readonly ToolCallRecord[], { cwd: string | undefined; entries: HistoryEntry[] }>();

/**
 * One call the session already made. Path resolution is deferred: a long session
 * holds thousands of calls, and a `did:` leaf usually rejects almost all of them
 * on tool name alone, so resolving every call's paths up front would dominate
 * the check.
 */
class HistoryEntry {
	#targets: TargetPath[] | undefined;

	constructor(
		readonly record: ToolCallRecord,
		readonly cwd: string | undefined,
	) {}

	get name(): string {
		return this.record.name;
	}

	get args(): string | undefined {
		return this.record.args;
	}

	get targets(): TargetPath[] {
		this.#targets ??= resolveTargetPaths(this.record.paths, this.cwd);
		return this.#targets;
	}
}

/** A test on what the session already did, rather than on the buffer. */
interface DidNode extends NodeModifiers {
	kind: "did";
	/** Tool names that satisfy the test; any one of them. */
	tools?: string[];
	path?: PathPredicate;
	patterns?: RegExp[];
	patternSources?: string[];
	/** Only the last N tool calls count; without it, the whole session does. */
	within?: number;
}

interface LlmNode extends NodeModifiers {
	kind: "llm";
	question: string;
	roles: string[];
}

interface GroupNode extends NodeModifiers {
	kind: "all" | "any";
	children: CompiledNode[];
}

interface NotNode extends NodeModifiers {
	kind: "not";
	child: CompiledNode;
}

interface IfNode extends NodeModifiers {
	kind: "if";
	guard: CompiledNode;
	then: CompiledNode;
	else?: CompiledNode;
}

type CompiledNode = RegexNode | AstNode | LangNode | PathNode | DidNode | LlmNode | GroupNode | NotNode | IfNode;

export interface MatchProgram {
	root: CompiledNode;
	/** AST leaves must be resolved with `prepareProgram` before evaluation. */
	needsAst: boolean;
	/** `llm:` leaves must be resolved with `prepareProgram` before evaluation. */
	needsJudge: boolean;
	/** Compact human-readable form, for `proto ttsr list` and logs. */
	description: string;
	/** Literals the buffer must contain for any match; empty means no prefilter. */
	literals: string[];
}

export interface CompileResult {
	program?: MatchProgram;
	errors: string[];
}

const MAX_REGEX_SPANS = 256;
const MAX_AST_MATCHES = 64;
const MAX_EVIDENCE_SNIPPETS = 3;
const MAX_SNIPPET_LENGTH = 200;

const REGION_VALUES: Readonly<Record<string, RegionKind | "any">> = {
	any: "any",
	code: "code",
	comment: "comment",
	string: "string",
	prose: "prose",
};

const STRICTNESS_VALUES: Readonly<Record<string, AstMatchStrictness>> = {
	cst: AstMatchStrictness.Cst,
	smart: AstMatchStrictness.Smart,
	ast: AstMatchStrictness.Ast,
	relaxed: AstMatchStrictness.Relaxed,
	signature: AstMatchStrictness.Signature,
	template: AstMatchStrictness.Template,
};

const LEAF_KEYS = ["regex", "ast", "lang", "path", "did", "llm", "all", "any", "not", "if"] as const;
const MODIFIER_KEYS = [
	"in",
	"count",
	"inside",
	"notInside",
	"has",
	"notHas",
	"where",
	"strictness",
	"selector",
	"model",
	"then",
	"else",
] as const;

/** Modifier keys that belong to exactly one expression kind. */
const KEY_OWNERS = [
	["model", "llm"],
	["then", "if"],
	["else", "if"],
] as const;

const PATH_KEYS = ["glob", "under", "outside", "regex"] as const;
const DID_KEYS = ["tool", "path", "args", "within"] as const;

/** Model roles an `llm:` leaf tries, in order, unless the rule names its own. */
const DEFAULT_JUDGE_ROLES = ["tiny", "smol"] as const;

/**
 * Evaluation cost. `all`/`any` children are sorted by it so a cheap leaf can
 * decide the verdict before an expensive one is ever requested — the only thing
 * standing between an `llm:` leaf and a model call on every buffer.
 */
const COST_CONTEXT = 0;
const COST_REGEX = 1;
const COST_AST = 2;
const COST_JUDGE = 3;

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringList(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const token = value.trim();
		return token.length > 0 ? [token] : [];
	}
	if (!Array.isArray(value)) return undefined;
	const tokens: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		const token = item.trim();
		if (token.length > 0) tokens.push(token);
	}
	return tokens;
}

class Compiler {
	readonly errors: string[] = [];
	needsAst = false;
	needsJudge = false;

	node(spec: unknown, path: string): CompiledNode | undefined {
		if (typeof spec === "string") return this.regexLeaf({ regex: spec }, path);
		if (Array.isArray(spec)) return this.group("any", spec, path);
		if (!isRecordValue(spec)) {
			this.errors.push(`${path}: expected a string, list, or mapping`);
			return undefined;
		}

		const present = LEAF_KEYS.filter(key => spec[key] !== undefined);
		if (present.length === 0) {
			this.errors.push(`${path}: needs one of ${LEAF_KEYS.join(", ")}`);
			return undefined;
		}
		if (present.length > 1) {
			this.errors.push(`${path}: has conflicting keys ${present.join(", ")}; wrap them in all: or any:`);
			return undefined;
		}
		for (const key of Object.keys(spec)) {
			const known =
				(LEAF_KEYS as readonly string[]).includes(key) || (MODIFIER_KEYS as readonly string[]).includes(key);
			if (!known) this.errors.push(`${path}: unknown key "${key}"`);
		}

		const kind = present[0]!;
		for (const [key, owner] of KEY_OWNERS) {
			if (spec[key] !== undefined && kind !== owner) {
				this.errors.push(`${path}.${key}: only applies to ${owner} conditions`);
				return undefined;
			}
		}
		if (kind === "all" || kind === "any") {
			const children = spec[kind];
			if (!Array.isArray(children)) {
				this.errors.push(`${path}.${kind}: expected a list`);
				return undefined;
			}
			return this.group(kind, children, `${path}.${kind}`);
		}
		if (kind === "not") return this.notLeaf(spec, path);
		if (kind === "if") return this.ifLeaf(spec, path);
		if (kind === "lang") return this.langLeaf(spec, path);
		if (kind === "path") return this.pathLeaf(spec, path);
		if (kind === "did") return this.didLeaf(spec, path);
		if (kind === "llm") return this.llmLeaf(spec, path);
		if (kind === "ast") return this.astLeaf(spec, path);
		return this.regexLeaf(spec, path);
	}

	group(kind: "all" | "any", specs: unknown[], path: string): CompiledNode | undefined {
		const children: CompiledNode[] = [];
		for (const [index, child] of specs.entries()) {
			const compiled = this.node(child, `${path}[${index}]`);
			if (compiled) children.push(compiled);
		}
		if (children.length === 0) {
			this.errors.push(`${path}: needs at least one condition`);
			return undefined;
		}
		// Stable sort: authored order survives within a cost class.
		children.sort((left, right) => left.cost - right.cost);
		return this.withModifiers({ kind, children, count: 1, cost: 0 }, {}, path);
	}

	notLeaf(spec: Record<string, unknown>, path: string): CompiledNode | undefined {
		const child = this.node(spec.not, `${path}.not`);
		if (!child) return undefined;
		return this.withModifiers({ kind: "not", child, count: 1, cost: 0 }, spec, path);
	}

	/**
	 * `if:` guards `then:`, and `else:` when present. Only the branch the guard
	 * selects is ever evaluated, which is what keeps an expensive branch — a parse,
	 * or a model — off the buffers the rule was never about.
	 */
	ifLeaf(spec: Record<string, unknown>, path: string): CompiledNode | undefined {
		if (spec.then === undefined) {
			this.errors.push(`${path}.if: needs a then: branch`);
			return undefined;
		}
		const guard = this.node(spec.if, `${path}.if`);
		const then = this.node(spec.then, `${path}.then`);
		const otherwise = spec.else === undefined ? undefined : this.node(spec.else, `${path}.else`);
		if (!guard || !then || (spec.else !== undefined && !otherwise)) return undefined;
		return this.withModifiers({ kind: "if", guard, then, else: otherwise, count: 1, cost: 0 }, spec, path);
	}

	langLeaf(spec: Record<string, unknown>, path: string): CompiledNode | undefined {
		const langs = toStringList(spec.lang);
		if (!langs || langs.length === 0) {
			this.errors.push(`${path}.lang: expected a language name or list of names`);
			return undefined;
		}
		return this.withModifiers(
			{ kind: "lang", langs: langs.map(lang => lang.toLowerCase()), count: 1, cost: 0 },
			spec,
			path,
		);
	}

	pathLeaf(spec: Record<string, unknown>, path: string): CompiledNode | undefined {
		const predicate = this.pathPredicate(spec.path, `${path}.path`);
		if (!predicate) return undefined;
		return this.withModifiers({ kind: "path", ...predicate, count: 1, cost: 0 }, spec, path);
	}

	/** The glob shorthand or a `glob`/`regex`/`under`/`outside` mapping. */
	pathPredicate(spec: unknown, path: string): PathPredicate | undefined {
		const predicate: PathPredicate = {};
		const shorthand = toStringList(spec);
		if (shorthand !== undefined) {
			if (shorthand.length === 0) {
				this.errors.push(`${path}: expected a glob or list of globs`);
				return undefined;
			}
			predicate.globSources = shorthand;
			predicate.globs = shorthand.map(glob => new Bun.Glob(glob));
			return predicate;
		}
		if (!isRecordValue(spec)) {
			this.errors.push(`${path}: expected a glob, a list of globs, or a mapping of ${PATH_KEYS.join(", ")}`);
			return undefined;
		}
		for (const key of Object.keys(spec)) {
			if (!(PATH_KEYS as readonly string[]).includes(key)) {
				this.errors.push(`${path}: unknown key "${key}"; expected ${PATH_KEYS.join(", ")}`);
				return undefined;
			}
		}
		if (spec.glob !== undefined) {
			const globs = toStringList(spec.glob);
			if (!globs || globs.length === 0) {
				this.errors.push(`${path}.glob: expected a glob or list of globs`);
				return undefined;
			}
			predicate.globSources = globs;
			predicate.globs = globs.map(glob => new Bun.Glob(glob));
		}
		if (spec.regex !== undefined) {
			const patterns = this.regexList(spec.regex, `${path}.regex`);
			if (!patterns) return undefined;
			predicate.patternSources = patterns.sources;
			predicate.patterns = patterns.compiled;
		}
		for (const key of ["under", "outside"] as const) {
			if (spec[key] === undefined) continue;
			const roots = toStringList(spec[key]);
			if (!roots || roots.length === 0) {
				this.errors.push(`${path}.${key}: expected a directory or list of directories`);
				return undefined;
			}
			predicate[key] = roots;
		}
		if (!predicate.globs && !predicate.patterns && !predicate.under && !predicate.outside) {
			this.errors.push(`${path}: needs one of ${PATH_KEYS.join(", ")}`);
			return undefined;
		}
		return predicate;
	}

	/**
	 * `did:` asks what the session already did — which skill it read, which
	 * command it ran — so a rule can fire only for an agent that skipped the
	 * reading. It tests earlier tool calls, never the buffer under evaluation.
	 */
	didLeaf(spec: Record<string, unknown>, path: string): CompiledNode | undefined {
		const node: DidNode = { kind: "did", count: 1, cost: 0 };
		const shorthand = toStringList(spec.did);
		if (shorthand !== undefined) {
			if (shorthand.length === 0) {
				this.errors.push(`${path}.did: expected a tool name or list of tool names`);
				return undefined;
			}
			node.tools = shorthand;
			return this.withModifiers(node, spec, path);
		}
		if (!isRecordValue(spec.did)) {
			this.errors.push(`${path}.did: expected a tool name or a mapping of ${DID_KEYS.join(", ")}`);
			return undefined;
		}
		const value = spec.did;
		for (const key of Object.keys(value)) {
			if (!(DID_KEYS as readonly string[]).includes(key)) {
				this.errors.push(`${path}.did: unknown key "${key}"; expected ${DID_KEYS.join(", ")}`);
				return undefined;
			}
		}
		if (value.tool !== undefined) {
			const tools = toStringList(value.tool);
			if (!tools || tools.length === 0) {
				this.errors.push(`${path}.did.tool: expected a tool name or list of tool names`);
				return undefined;
			}
			node.tools = tools;
		}
		if (value.path !== undefined) {
			const predicate = this.pathPredicate(value.path, `${path}.did.path`);
			if (!predicate) return undefined;
			node.path = predicate;
		}
		if (value.args !== undefined) {
			const patterns = this.regexList(value.args, `${path}.did.args`);
			if (!patterns) return undefined;
			node.patternSources = patterns.sources;
			node.patterns = patterns.compiled;
		}
		if (value.within !== undefined) {
			const within = typeof value.within === "number" ? value.within : Number(value.within);
			if (!Number.isInteger(within) || within < 1) {
				this.errors.push(`${path}.did.within: expected a positive integer`);
				return undefined;
			}
			node.within = within;
		}
		if (!node.tools && !node.path && !node.patterns) {
			this.errors.push(`${path}.did: needs one of tool, path, args`);
			return undefined;
		}
		return this.withModifiers(node, spec, path);
	}

	llmLeaf(spec: Record<string, unknown>, path: string): CompiledNode | undefined {
		const question = typeof spec.llm === "string" ? spec.llm.trim() : undefined;
		if (!question) {
			this.errors.push(`${path}.llm: expected a yes/no question about the buffer`);
			return undefined;
		}
		let roles: string[] = [...DEFAULT_JUDGE_ROLES];
		if (spec.model !== undefined) {
			const requested = toStringList(spec.model);
			if (!requested || requested.length === 0) {
				this.errors.push(`${path}.model: expected a model role or list of roles`);
				return undefined;
			}
			roles = requested.map(role => role.toLowerCase());
		}
		this.needsJudge = true;
		return this.withModifiers({ kind: "llm", question, roles, count: 1, cost: 0 }, spec, path);
	}

	astLeaf(spec: Record<string, unknown>, path: string): CompiledNode | undefined {
		const patterns = toStringList(spec.ast);
		if (!patterns || patterns.length === 0) {
			this.errors.push(`${path}.ast: expected a pattern or list of patterns`);
			return undefined;
		}
		let strictness = AstMatchStrictness.Smart;
		if (spec.strictness !== undefined) {
			const requested =
				typeof spec.strictness === "string" ? STRICTNESS_VALUES[spec.strictness.toLowerCase()] : undefined;
			if (!requested) {
				this.errors.push(`${path}.strictness: expected one of ${Object.keys(STRICTNESS_VALUES).join(", ")}`);
				return undefined;
			}
			strictness = requested;
		}
		if (spec.selector !== undefined && typeof spec.selector !== "string") {
			this.errors.push(`${path}.selector: expected a node kind`);
			return undefined;
		}
		const where = this.metaConstraints(spec.where, `${path}.where`);
		if (!where) return undefined;
		this.needsAst = true;
		return this.withModifiers(
			{ kind: "ast", patterns, strictness, selector: spec.selector as string | undefined, where, count: 1, cost: 0 },
			spec,
			path,
		);
	}

	metaConstraints(spec: unknown, path: string): MetaConstraint[] | undefined {
		if (spec === undefined) return [];
		if (!isRecordValue(spec)) {
			this.errors.push(`${path}: expected a mapping of metavariable name to constraint`);
			return undefined;
		}
		const constraints: MetaConstraint[] = [];
		for (const [rawName, value] of Object.entries(spec)) {
			const name = rawName.replace(/^\$+/, "").trim();
			if (name.length === 0) {
				this.errors.push(`${path}: empty metavariable name`);
				return undefined;
			}
			if (typeof value === "string") {
				const regex = this.regex(value, `${path}.${rawName}`);
				if (!regex) return undefined;
				constraints.push({ name, regex });
				continue;
			}
			if (!isRecordValue(value)) {
				this.errors.push(`${path}.${rawName}: expected a regex or { regex, notRegex } mapping`);
				return undefined;
			}
			const constraint: MetaConstraint = { name };
			for (const key of Object.keys(value)) {
				if (key !== "regex" && key !== "notRegex") {
					this.errors.push(`${path}.${rawName}: unknown key "${key}"`);
					return undefined;
				}
			}
			if (typeof value.regex === "string") {
				const regex = this.regex(value.regex, `${path}.${rawName}.regex`);
				if (!regex) return undefined;
				constraint.regex = regex;
			}
			if (typeof value.notRegex === "string") {
				const regex = this.regex(value.notRegex, `${path}.${rawName}.notRegex`);
				if (!regex) return undefined;
				constraint.notRegex = regex;
			}
			if (!constraint.regex && !constraint.notRegex) {
				this.errors.push(`${path}.${rawName}: expected regex or notRegex`);
				return undefined;
			}
			constraints.push(constraint);
		}
		return constraints;
	}

	regexLeaf(spec: Record<string, unknown>, path: string): CompiledNode | undefined {
		const sources = toStringList(spec.regex);
		if (!sources || sources.length === 0) {
			this.errors.push(`${path}.regex: expected a pattern or list of patterns`);
			return undefined;
		}
		const patterns: RegExp[] = [];
		for (const source of sources) {
			const compiled = this.regex(source, `${path}.regex`);
			if (!compiled) return undefined;
			patterns.push(compiled);
		}
		let regions: RegionKind[] | undefined;
		if (spec.in !== undefined) {
			const requested = toStringList(spec.in);
			if (!requested || requested.length === 0) {
				this.errors.push(`${path}.in: expected one or more of ${Object.keys(REGION_VALUES).join(", ")}`);
				return undefined;
			}
			const kinds: RegionKind[] = [];
			for (const token of requested) {
				const region = REGION_VALUES[token.toLowerCase()];
				if (!region) {
					this.errors.push(`${path}.in: expected one of ${Object.keys(REGION_VALUES).join(", ")}, got "${token}"`);
					return undefined;
				}
				if (region !== "any" && !kinds.includes(region)) kinds.push(region);
			}
			regions = kinds.length > 0 ? kinds : undefined;
		}
		return this.withModifiers({ kind: "regex", patterns, sources, regions, count: 1, cost: 0 }, spec, path);
	}

	/** A pattern or list of patterns, ORed by the caller. */
	regexList(spec: unknown, path: string): { sources: string[]; compiled: RegExp[] } | undefined {
		const sources = toStringList(spec);
		if (!sources || sources.length === 0) {
			this.errors.push(`${path}: expected a pattern or list of patterns`);
			return undefined;
		}
		const compiled: RegExp[] = [];
		for (const source of sources) {
			const pattern = this.regex(source, path);
			if (!pattern) return undefined;
			compiled.push(pattern);
		}
		return { sources, compiled };
	}

	regex(source: string, path: string): RegExp | undefined {
		try {
			const compiled = compileRuleCondition(source);
			return compiled.flags.includes("g") ? compiled : new RegExp(compiled.source, `${compiled.flags}g`);
		} catch (error) {
			this.errors.push(`${path}: invalid regex (${error instanceof Error ? error.message : String(error)})`);
			return undefined;
		}
	}

	withModifiers<T extends CompiledNode>(node: T, spec: Record<string, unknown>, path: string): T | undefined {
		if (spec.count !== undefined) {
			const count = typeof spec.count === "number" ? spec.count : Number(spec.count);
			if (!Number.isInteger(count) || count < 1) {
				this.errors.push(`${path}.count: expected a positive integer`);
				return undefined;
			}
			if (!locates(node)) {
				this.errors.push(`${path}.count: only applies to regex/ast conditions`);
				return undefined;
			}
			node.count = count;
		}
		for (const key of ["inside", "notInside", "has", "notHas"] as const) {
			if (spec[key] === undefined) continue;
			if (!locates(node)) {
				this.errors.push(`${path}.${key}: only applies to regex/ast conditions`);
				return undefined;
			}
			const child = this.node(spec[key], `${path}.${key}`);
			if (!child) return undefined;
			if (!locates(child)) {
				this.errors.push(`${path}.${key}: needs a regex/ast condition, not a context test`);
				return undefined;
			}
			node[key] = child;
		}
		node.cost = costOf(node);
		return node;
	}
}

function costOf(node: CompiledNode): number {
	switch (node.kind) {
		case "lang":
		case "path":
		case "did":
			return COST_CONTEXT;
		case "regex":
			return COST_REGEX;
		case "ast":
			return COST_AST;
		case "llm":
			return COST_JUDGE;
		case "not":
			return node.child.cost;
		case "if":
			return Math.max(node.guard.cost, node.then.cost, node.else?.cost ?? COST_CONTEXT);
		default:
			return node.children.reduce((highest, child) => Math.max(highest, child.cost), COST_CONTEXT);
	}
}

/** Whether a node produces located spans (rather than a whole-buffer verdict). */
function locates(node: CompiledNode): boolean {
	switch (node.kind) {
		case "regex":
		case "ast":
			return true;
		case "all":
			return node.children.some(locates);
		case "any":
			return node.children.every(locates);
		case "if":
			return locates(node.then) && (node.else === undefined || locates(node.else));
		default:
			return false;
	}
}

export function compileMatchProgram(spec: RuleMatchSpec, ruleName: string): CompileResult {
	const compiler = new Compiler();
	const root = compiler.node(spec, "match");
	if (!root || compiler.errors.length > 0) {
		return { errors: compiler.errors.length > 0 ? compiler.errors : [`match: could not compile rule ${ruleName}`] };
	}
	return {
		program: {
			root,
			needsAst: compiler.needsAst,
			needsJudge: compiler.needsJudge,
			description: describeNode(root),
			literals: literalsOf(root),
		},
		errors: [],
	};
}

/** Compile the legacy flat `condition:` / `astCondition:` frontmatter into one program. */
export function compileLegacyProgram(
	condition: readonly string[] | undefined,
	astCondition: readonly string[] | undefined,
): CompileResult {
	// Tolerant by design: an invalid pattern in a flat list is reported and
	// dropped, and the rule still registers on whatever compiled — the strict
	// all-or-nothing contract belongs to `match:` expressions.
	const compiler = new Compiler();
	const branches: unknown[] = [];
	for (const pattern of condition ?? []) {
		const errorsBefore = compiler.errors.length;
		compiler.regex(pattern, "condition");
		if (compiler.errors.length === errorsBefore) branches.push({ regex: pattern });
	}
	for (const pattern of astCondition ?? []) branches.push({ ast: pattern });
	if (branches.length === 0) return { errors: compiler.errors };
	const root = compiler.node(branches.length === 1 ? branches[0] : branches, "condition");
	if (!root) return { errors: compiler.errors };
	return {
		program: {
			root,
			needsAst: compiler.needsAst,
			needsJudge: compiler.needsJudge,
			description: describeNode(root),
			literals: literalsOf(root),
		},
		errors: compiler.errors,
	};
}

export class MatchContext {
	readonly input: MatchInput;
	readonly #astCache = new Map<string, AstHit[]>();
	readonly #judgeCache = new Map<string, boolean>();
	readonly #rootCache = new Map<string, string>();
	#requestedAst: AstNode[] = [];
	#requestedJudge: LlmNode[] = [];
	#targets: TargetPath[] | undefined;
	#history: HistoryEntry[] | undefined;
	#unresolved = false;
	#regions: SyntaxRegion[] | undefined;
	#regionMode: RegionMode | undefined;
	#regionsResolved = false;
	#lineStarts: number[] | undefined;
	#byteToChar: Int32Array | undefined;
	#byteMapResolved = false;

	constructor(input: MatchInput) {
		this.input = input;
	}

	get cwd(): string {
		return this.input.cwd && this.input.cwd.length > 0 ? this.input.cwd : process.cwd();
	}

	/** The tool call's file paths, in every spelling a condition may test. */
	get targets(): TargetPath[] {
		this.#targets ??= resolveTargetPaths(this.input.filePaths, this.cwd);
		return this.#targets;
	}

	/** The session's earlier tool calls, oldest first; empty when the host tracks none. */
	get history(): readonly HistoryEntry[] {
		if (this.#history) return this.#history;
		const records = this.input.history?.() ?? NO_HISTORY;
		// Hosts hand back a stable array while the transcript is unchanged, so the
		// mapped entries — and any paths they resolved — survive across checks.
		const cached = HISTORY_ENTRIES.get(records);
		if (cached && cached.cwd === this.cwd) {
			this.#history = cached.entries;
			return cached.entries;
		}
		const entries = records.map(record => new HistoryEntry(record, this.cwd));
		HISTORY_ENTRIES.set(records, { cwd: this.cwd, entries });
		this.#history = entries;
		return entries;
	}

	/** Resolve (and memoize) an `under:`/`outside:` directory against this context. */
	rootDir(root: string): string {
		let resolved = this.#rootCache.get(root);
		if (resolved === undefined) {
			resolved = resolveRootDir(root, this.cwd);
			this.#rootCache.set(root, resolved);
		}
		return resolved;
	}

	get regionMode(): RegionMode | undefined {
		this.#resolveRegions();
		return this.#regionMode;
	}

	get regions(): SyntaxRegion[] | undefined {
		this.#resolveRegions();
		return this.#regions;
	}

	#resolveRegions(): void {
		if (this.#regionsResolved) return;
		this.#regionsResolved = true;
		this.#regionMode = regionModeFor(this.input.source, this.input.lang);
		this.#regions = this.#regionMode ? classifyRegions(this.input.text, this.#regionMode) : undefined;
	}

	lineOf(offset: number): number {
		if (!this.#lineStarts) {
			const starts = [0];
			for (let index = 0; index < this.input.text.length; index++) {
				if (this.input.text[index] === "\n") starts.push(index + 1);
			}
			this.#lineStarts = starts;
		}
		const starts = this.#lineStarts;
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (starts[mid]! <= offset) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	}

	lineText(offset: number): string {
		const text = this.input.text;
		const start = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
		const end = text.indexOf("\n", offset);
		return text.slice(start, end === -1 ? text.length : end);
	}

	/** ast-grep reports UTF-8 byte offsets; regex and evidence use UTF-16 indices. */
	charOffset(byteOffset: number): number {
		if (!this.#byteMapResolved) {
			this.#byteMapResolved = true;
			const text = this.input.text;
			let nonAscii = false;
			for (let index = 0; index < text.length; index++) {
				if (text.charCodeAt(index) > 127) {
					nonAscii = true;
					break;
				}
			}
			if (nonAscii) {
				const bytes = Buffer.byteLength(text, "utf8");
				const map = new Int32Array(bytes + 1);
				let byte = 0;
				for (let index = 0; index < text.length; ) {
					const codePoint = text.codePointAt(index)!;
					const width = codePoint > 0xffff ? 2 : 1;
					const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
					for (let offset = 0; offset < size; offset++) map[byte + offset] = index;
					byte += size;
					index += width;
				}
				map[bytes] = text.length;
				this.#byteToChar = map;
			}
		}
		const map = this.#byteToChar;
		if (!map) return byteOffset;
		if (byteOffset <= 0) return 0;
		return byteOffset >= map.length ? this.input.text.length : map[byteOffset]!;
	}

	astHits(key: string): AstHit[] | undefined {
		return this.#astCache.get(key);
	}

	setAstHits(key: string, hits: AstHit[]): void {
		this.#astCache.set(key, hits);
	}

	/** An AST leaf evaluation reached without a resolved result. */
	requestAst(node: AstNode): void {
		if (!this.#requestedAst.includes(node)) this.#requestedAst.push(node);
	}

	judgeVerdict(node: LlmNode): boolean | undefined {
		return this.#judgeCache.get(judgeKey(node));
	}

	setJudgeVerdict(node: LlmNode, verdict: boolean): void {
		this.#judgeCache.set(judgeKey(node), verdict);
	}

	/** An `llm:` leaf evaluation reached without a resolved verdict. */
	requestJudge(node: LlmNode): void {
		if (!this.#requestedJudge.includes(node)) this.#requestedJudge.push(node);
	}

	beginEvaluation(): void {
		this.#requestedAst = [];
		this.#requestedJudge = [];
		this.#unresolved = false;
	}

	endEvaluation(unknown: boolean): void {
		this.#unresolved = unknown;
	}

	/** Whether the last verdict hinged on AST leaves nobody has resolved yet. */
	needsAstResolution(): boolean {
		return this.#unresolved && this.#requestedAst.length > 0;
	}

	/** Whether the last verdict hinged on `llm:` leaves nobody has resolved yet. */
	needsJudgeResolution(): boolean {
		return this.#unresolved && this.#requestedJudge.length > 0;
	}

	takeRequestedAst(): AstNode[] {
		const requested = this.#requestedAst;
		this.#requestedAst = [];
		return requested;
	}

	takeRequestedJudge(): LlmNode[] {
		const requested = this.#requestedJudge;
		this.#requestedJudge = [];
		return requested;
	}
}

function astKey(node: AstNode): string {
	return `${node.strictness}\u0000${node.selector ?? ""}\u0000${node.patterns.join("\u0001")}`;
}

function judgeKey(node: LlmNode): string {
	return `${node.roles.join("\u0001")}\u0000${node.question}`;
}

function collectLeaves<K extends CompiledNode["kind"]>(
	node: CompiledNode,
	kind: K,
	out: Extract<CompiledNode, { kind: K }>[],
): void {
	if (node.kind === kind) out.push(node as Extract<CompiledNode, { kind: K }>);
	if (node.kind === "all" || node.kind === "any") for (const child of node.children) collectLeaves(child, kind, out);
	if (node.kind === "not") collectLeaves(node.child, kind, out);
	if (node.kind === "if") {
		collectLeaves(node.guard, kind, out);
		collectLeaves(node.then, kind, out);
		if (node.else) collectLeaves(node.else, kind, out);
	}
	for (const key of ["inside", "notInside", "has", "notHas"] as const) {
		const child = node[key];
		if (child) collectLeaves(child, kind, out);
	}
}

/**
 * Resolve every async leaf against the buffer. After an evaluation, only the
 * leaves it actually reached are resolved — a rule gated on `lang: [go]` never
 * parses a TypeScript buffer. Called before any evaluation, it resolves every
 * leaf, which is what a one-shot caller wants; `matchProgram` instead resolves
 * in cost order and stops as soon as the verdict is settled.
 */
export async function prepareProgram(program: MatchProgram, ctx: MatchContext): Promise<void> {
	await resolveAstLeaves(program, ctx);
	await resolveJudgeLeaves(program, ctx);
}

/** `true` when at least one leaf moved from unresolved to resolved. */
async function resolveAstLeaves(program: MatchProgram, ctx: MatchContext): Promise<boolean> {
	if (!program.needsAst) return false;
	const lang = ctx.input.lang;
	if (!lang) return false;
	let nodes = ctx.takeRequestedAst();
	if (nodes.length === 0) {
		nodes = [];
		collectLeaves(program.root, "ast", nodes);
	}
	const pending = new Map<string, AstNode>();
	for (const node of nodes) {
		const key = astKey(node);
		if (!ctx.astHits(key)) pending.set(key, node);
	}
	await Promise.all(
		Array.from(pending, async ([key, node]) => {
			try {
				const result = await astMatch({
					source: ctx.input.text,
					lang,
					patterns: node.patterns,
					selector: node.selector,
					strictness: node.strictness,
					includeMeta: node.where.length > 0,
					limit: MAX_AST_MATCHES,
				});
				ctx.setAstHits(
					key,
					result.matches.map(match => ({
						start: ctx.charOffset(match.byteStart),
						end: ctx.charOffset(match.byteEnd),
						metaVariables: match.metaVariables,
					})),
				);
			} catch (error) {
				logger.warn("TTSR ast condition failed, treating as no match", {
					patterns: node.patterns,
					lang,
					error: error instanceof Error ? error.message : String(error),
				});
				ctx.setAstHits(key, []);
			}
		}),
	);
	return pending.size > 0;
}

/**
 * Ask the judge about every `llm:` leaf the verdict still hinges on. Without a
 * judge wired — bulk scans, `proto ttsr test` without `--llm` — the leaf settles
 * as "no match" instead of leaving the program permanently unresolvable.
 */
async function resolveJudgeLeaves(program: MatchProgram, ctx: MatchContext): Promise<boolean> {
	if (!program.needsJudge) return false;
	let nodes = ctx.takeRequestedJudge();
	if (nodes.length === 0) {
		nodes = [];
		collectLeaves(program.root, "llm", nodes);
	}
	const pending = new Map<string, LlmNode>();
	for (const node of nodes) {
		if (ctx.judgeVerdict(node) === undefined) pending.set(judgeKey(node), node);
	}
	if (pending.size === 0) return false;
	const judge = ctx.input.judge;
	if (!judge) {
		for (const node of pending.values()) ctx.setJudgeVerdict(node, false);
		return true;
	}
	await Promise.all(
		Array.from(pending.values(), async node => {
			try {
				const verdict = await judge(
					{
						question: node.question,
						roles: node.roles,
						text: ctx.input.text,
						source: ctx.input.source,
						lang: ctx.input.lang,
						toolName: ctx.input.toolName,
						filePaths: ctx.input.filePaths,
					},
					ctx.input.signal,
				);
				ctx.setJudgeVerdict(node, verdict === true);
			} catch (error) {
				logger.warn("TTSR llm condition failed, treating as no match", {
					question: node.question,
					error: error instanceof Error ? error.message : String(error),
				});
				ctx.setJudgeVerdict(node, false);
			}
		}),
	);
	return true;
}

/**
 * Three-valued: `unknown` marks a verdict that depends on an AST leaf nobody
 * resolved yet. The regex-only fast path evaluates every program, including
 * ones with AST leaves, and `unknown` is what stops it from reading an
 * unresolved `not: { ast: … }` as a satisfied condition.
 */
interface NodeResult {
	matched: boolean;
	unknown: boolean;
	spans: Span[];
}

const UNMATCHED: NodeResult = { matched: false, unknown: false, spans: [] };
const UNKNOWN: NodeResult = { matched: false, unknown: true, spans: [] };

export function evaluateProgram(program: MatchProgram, ctx: MatchContext): MatchEvidence | undefined {
	ctx.beginEvaluation();
	const result = evaluateNode(program.root, ctx);
	ctx.endEvaluation(result.unknown);
	return result.matched && !result.unknown ? { snippets: snippetsFor(result.spans, ctx) } : undefined;
}

/**
 * Evaluate, resolving async leaves only while the verdict still depends on them,
 * cheapest first: parse before asking a model, and never ask a model about a
 * buffer whose AST leaves already ruled the rule out. Resolving one round can
 * uncover the next — an `if:` guarded by a judge only reveals the leaves of its
 * branch once the verdict is in — so the stages repeat while they make progress.
 * Every round resolves at least one leaf that stays resolved, so it terminates.
 *
 * `resolveJudge: false` stops before the model round, leaving `llm:` leaves
 * unresolved — which is how a growing stream buffer is evaluated, since a judge
 * only has a question worth asking once the buffer has settled.
 */
export async function matchProgram(
	program: MatchProgram,
	ctx: MatchContext,
	options?: { resolveJudge?: boolean },
): Promise<MatchEvidence | undefined> {
	for (;;) {
		const evidence = evaluateProgram(program, ctx);
		if (evidence) return evidence;
		if (ctx.needsAstResolution() && (await resolveAstLeaves(program, ctx))) continue;
		if (options?.resolveJudge === false) return undefined;
		if (ctx.needsJudgeResolution() && (await resolveJudgeLeaves(program, ctx))) continue;
		return undefined;
	}
}

function evaluateNode(node: CompiledNode, ctx: MatchContext): NodeResult {
	switch (node.kind) {
		case "regex":
			return finish(node, regexSpans(node, ctx), ctx);
		case "ast": {
			const spans = astSpans(node, ctx);
			if (spans) return finish(node, spans, ctx);
			ctx.requestAst(node);
			return UNKNOWN;
		}
		case "lang": {
			const lang = ctx.input.lang?.toLowerCase();
			return { matched: lang !== undefined && node.langs.includes(lang), unknown: false, spans: [] };
		}
		case "path":
			return { matched: matchesPathTargets(node, ctx.targets, ctx), unknown: false, spans: [] };
		case "did":
			return { matched: matchesDidNode(node, ctx), unknown: false, spans: [] };
		case "llm": {
			const verdict = ctx.judgeVerdict(node);
			if (verdict === undefined) {
				ctx.requestJudge(node);
				return UNKNOWN;
			}
			return { matched: verdict, unknown: false, spans: [] };
		}
		case "not": {
			const child = evaluateNode(node.child, ctx);
			return child.unknown ? UNKNOWN : { matched: !child.matched, unknown: false, spans: [] };
		}
		case "if": {
			const guard = evaluateNode(node.guard, ctx);
			// Which branch applies is undecided, so neither branch is evaluated.
			if (guard.unknown) return UNKNOWN;
			const branch = guard.matched ? node.then : node.else;
			if (!branch) return UNMATCHED;
			const result = evaluateNode(branch, ctx);
			if (result.unknown) return UNKNOWN;
			// The guard chose the branch; only the branch itself is evidence.
			return result.matched ? finish(node, result.spans, ctx) : UNMATCHED;
		}
		case "all": {
			const spans: Span[] = [];
			let unknown = false;
			for (const child of node.children) {
				const result = evaluateNode(child, ctx);
				if (result.unknown) {
					unknown = true;
					continue;
				}
				if (!result.matched) return UNMATCHED;
				spans.push(...result.spans);
			}
			return unknown ? UNKNOWN : finish(node, spans, ctx);
		}
		case "any": {
			const spans: Span[] = [];
			let matched = false;
			let unknown = false;
			for (const child of node.children) {
				// The branch is already decided; a judge could only add evidence.
				if (matched && child.cost >= COST_JUDGE) continue;
				const result = evaluateNode(child, ctx);
				if (result.unknown) {
					unknown = true;
					continue;
				}
				if (!result.matched) continue;
				matched = true;
				spans.push(...result.spans);
			}
			if (matched) return finish(node, spans, ctx);
			return unknown ? UNKNOWN : UNMATCHED;
		}
	}
}

function finish(node: CompiledNode, spans: Span[], ctx: MatchContext): NodeResult {
	if (spans.length === 0) {
		// A group or branch whose matched children were all context tests still
		// matches; it just has nothing to quote.
		const contextOnly = (node.kind === "all" || node.kind === "any" || node.kind === "if") && node.count === 1;
		return contextOnly ? { matched: true, unknown: false, spans: [] } : UNMATCHED;
	}
	let filtered = spans;
	for (const key of ["inside", "notInside", "has", "notHas"] as const) {
		const child = node[key];
		if (!child) continue;
		const result = evaluateNode(child, ctx);
		if (result.unknown) return UNKNOWN;
		filtered =
			key === "inside" || key === "notInside"
				? keepContained(filtered, result.spans, key === "inside")
				: keepContaining(filtered, result.spans, key === "has");
	}
	return filtered.length >= node.count ? { matched: true, unknown: false, spans: filtered } : UNMATCHED;
}

function keepContained(spans: Span[], containers: Span[], want: boolean): Span[] {
	return spans.filter(span => containers.some(outer => outer.start <= span.start && outer.end >= span.end) === want);
}

function keepContaining(spans: Span[], inner: Span[], want: boolean): Span[] {
	return spans.filter(
		span => inner.some(candidate => span.start <= candidate.start && span.end >= candidate.end) === want,
	);
}

function regexSpans(node: RegexNode, ctx: MatchContext): Span[] {
	const spans: Span[] = [];
	for (const pattern of node.patterns) {
		pattern.lastIndex = 0;
		let match = pattern.exec(ctx.input.text);
		while (match && spans.length < MAX_REGEX_SPANS) {
			const start = match.index;
			const end = start + (match[0].length || 1);
			spans.push({ start, end: Math.min(end, ctx.input.text.length) });
			if (match[0].length === 0) pattern.lastIndex++;
			match = pattern.exec(ctx.input.text);
		}
	}
	return node.regions ? filterByRegion(spans, node.regions, ctx) : spans;
}

function filterByRegion(spans: Span[], regions: RegionKind[], ctx: MatchContext): Span[] {
	const classified = ctx.regions;
	const mode = ctx.regionMode;
	// Fail closed: an unclassifiable buffer cannot prove the match sits in the
	// requested region, so the condition does not fire.
	if (!classified || !mode) return [];
	const fallback: RegionKind = mode.kind === "prose" ? "prose" : "code";
	return spans.filter(span => {
		const kind = spanRegionKind(classified, span.start, span.end, fallback);
		return kind !== undefined && regions.includes(kind);
	});
}

/** `undefined` when the leaf was never resolved against this buffer. */
function astSpans(node: AstNode, ctx: MatchContext): Span[] | undefined {
	const hits = ctx.astHits(astKey(node));
	if (!hits) return undefined;
	if (node.where.length === 0) return hits.map(hit => ({ start: hit.start, end: hit.end }));
	return hits
		.filter(hit => node.where.every(constraint => satisfiesConstraint(constraint, hit.metaVariables)))
		.map(hit => ({ start: hit.start, end: hit.end }));
}

function satisfiesConstraint(constraint: MetaConstraint, metaVariables: Record<string, string> | undefined): boolean {
	const value = metaVariables?.[constraint.name];
	if (value === undefined) return false;
	if (constraint.regex) {
		constraint.regex.lastIndex = 0;
		if (!constraint.regex.test(value)) return false;
	}
	if (constraint.notRegex) {
		constraint.notRegex.lastIndex = 0;
		if (constraint.notRegex.test(value)) return false;
	}
	return true;
}

/**
 * A path predicate holds when one target path satisfies every test it sets.
 * Scheme URIs (`https://`, `local://`) have no filesystem location, so they can
 * neither sit under a root nor escape one — `outside:` stays fail-closed.
 */
function matchesPathTargets(predicate: PathPredicate, targets: readonly TargetPath[], ctx: MatchContext): boolean {
	if (targets.length === 0) return false;
	return targets.some(target => {
		if (predicate.globs && !predicate.globs.some(glob => matchesTarget(glob, target))) return false;
		if (predicate.patterns && !predicate.patterns.some(pattern => matchesPathPattern(pattern, target))) return false;
		if (predicate.under || predicate.outside) {
			const absolute = target.absolute;
			if (!absolute) return false;
			if (predicate.under && !predicate.under.some(root => isUnderRoot(absolute, ctx.rootDir(root)))) return false;
			if (predicate.outside?.some(root => isUnderRoot(absolute, ctx.rootDir(root)))) return false;
		}
		return true;
	});
}

/**
 * A `did:` leaf searches the calls the session already made. A host that tracks
 * no history — bulk scans, `proto ttsr test` — reports "never did it", which is
 * what lets `not: { did: … }` fire there.
 */
function matchesDidNode(node: DidNode, ctx: MatchContext): boolean {
	const entries = ctx.history;
	const scoped =
		node.within !== undefined && node.within < entries.length ? entries.slice(entries.length - node.within) : entries;
	return scoped.some(entry => {
		// Cheap rejections first: `targets` resolves paths on first touch.
		if (node.tools && !node.tools.includes(entry.name)) return false;
		if (node.patterns && !node.patterns.some(pattern => matchesArgs(pattern, entry.args))) return false;
		if (node.path && !matchesPathTargets(node.path, entry.targets, ctx)) return false;
		return true;
	});
}

function matchesArgs(pattern: RegExp, args: string | undefined): boolean {
	if (args === undefined) return false;
	pattern.lastIndex = 0;
	return pattern.test(args);
}

function matchesPathPattern(pattern: RegExp, target: TargetPath): boolean {
	for (const candidate of [target.raw, target.relative, target.absolute]) {
		if (candidate === undefined) continue;
		pattern.lastIndex = 0;
		if (pattern.test(candidate)) return true;
	}
	return false;
}

function snippetsFor(spans: Span[], ctx: MatchContext): MatchSnippet[] {
	const snippets: MatchSnippet[] = [];
	const seen = new Set<number>();
	for (const span of spans.slice().sort((a, b) => a.start - b.start)) {
		const line = ctx.lineOf(span.start);
		if (seen.has(line)) continue;
		seen.add(line);
		const text = ctx.lineText(span.start).trim();
		snippets.push({ line, text: text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH)}…` : text });
		if (snippets.length >= MAX_EVIDENCE_SNIPPETS) break;
	}
	return snippets;
}

function describeNode(node: CompiledNode): string {
	const modifiers: string[] = [];
	if (node.count > 1) modifiers.push(`count≥${node.count}`);
	for (const key of ["inside", "notInside", "has", "notHas"] as const) {
		const child = node[key];
		if (child) modifiers.push(`${key} ${describeNode(child)}`);
	}
	const suffix = modifiers.length > 0 ? ` (${modifiers.join(", ")})` : "";
	switch (node.kind) {
		case "regex": {
			const region = node.regions ? ` in ${node.regions.join("|")}` : "";
			return `regex ${node.sources.map(source => `/${source}/`).join(" | ")}${region}${suffix}`;
		}
		case "ast": {
			const where =
				node.where.length > 0 ? ` where ${node.where.map(constraint => `$${constraint.name}`).join(", ")}` : "";
			return `ast ${node.patterns.map(pattern => `\`${pattern}\``).join(" | ")}${where}${suffix}`;
		}
		case "lang":
			return `lang ${node.langs.join("|")}`;
		case "path":
			return `path ${describePredicate(node)}`;
		case "did": {
			const parts: string[] = [];
			if (node.tools) parts.push(node.tools.join("|"));
			if (node.path) parts.push(`path ${describePredicate(node.path)}`);
			if (node.patternSources) parts.push(`args ${node.patternSources.map(source => `/${source}/`).join("|")}`);
			if (node.within !== undefined) parts.push(`within ${node.within}`);
			return `did ${parts.join(" ")}`;
		}
		case "llm":
			return `llm "${node.question}" (${node.roles.join("→")})`;
		case "not":
			return `not ${describeNode(node.child)}`;
		case "if": {
			const otherwise = node.else ? ` else ${describeNode(node.else)}` : "";
			return `if ${describeNode(node.guard)} then ${describeNode(node.then)}${otherwise}${suffix}`;
		}
		default:
			return `${node.kind}(${node.children.map(describeNode).join(", ")})${suffix}`;
	}
}

function describePredicate(predicate: PathPredicate): string {
	const parts: string[] = [];
	if (predicate.globSources) parts.push(predicate.globSources.join("|"));
	if (predicate.patternSources)
		parts.push(`matching ${predicate.patternSources.map(source => `/${source}/`).join("|")}`);
	if (predicate.under) parts.push(`under ${predicate.under.join("|")}`);
	if (predicate.outside) parts.push(`outside ${predicate.outside.join("|")}`);
	return parts.join(" ");
}

const LITERAL_RUN = /[A-Za-z0-9_]{3,}/g;
const MIN_LITERAL = 3;

function longestAstLiteral(pattern: string): string | undefined {
	// Every literal token of an ast-grep pattern must appear in matching code.
	const text = pattern.replaceAll(/\$+[A-Z_][A-Z0-9_]*/g, " ");
	let best: string | undefined;
	for (const match of text.matchAll(LITERAL_RUN)) {
		if (!best || match[0].length > best.length) best = match[0];
	}
	return best;
}

/**
 * Longest literal run every match must contain, or `undefined` when the pattern
 * offers no such guarantee. Only top-level runs count: anything inside a group
 * or class may be optional or alternated away, and a top-level `|` makes the
 * whole pattern alternative, so the prefilter gives up rather than skip a file
 * that would have matched.
 */
function longestRegexLiteral(source: string): string | undefined {
	let best: string | undefined;
	let run = "";
	let depth = 0;
	let inClass = false;
	const flush = (optionalTail: boolean) => {
		const literal = optionalTail ? run.slice(0, -1) : run;
		run = "";
		if (literal.length >= MIN_LITERAL && (!best || literal.length > best.length)) best = literal;
	};
	for (let index = 0; index < source.length; index++) {
		const char = source[index]!;
		if (char === "\\") {
			flush(false);
			index++;
			continue;
		}
		if (inClass) {
			if (char === "]") inClass = false;
			continue;
		}
		if (char === "[") {
			flush(false);
			inClass = true;
			continue;
		}
		if (char === "(") {
			flush(false);
			depth++;
			continue;
		}
		if (char === ")") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (depth > 0) continue;
		if (char === "|") return undefined;
		if (char === "?" || char === "*" || source.startsWith("{0", index)) {
			flush(true);
			continue;
		}
		if (/[A-Za-z0-9_]/.test(char)) {
			run += char;
			continue;
		}
		flush(false);
	}
	flush(false);
	return best;
}

function literalsOf(node: CompiledNode): string[] {
	switch (node.kind) {
		case "regex": {
			if (node.patterns.some(pattern => pattern.flags.includes("i"))) return [];
			const literals: string[] = [];
			for (const source of node.sources) {
				const literal = longestRegexLiteral(source);
				if (!literal) return [];
				literals.push(literal);
			}
			return literals;
		}
		case "ast": {
			const literals: string[] = [];
			for (const pattern of node.patterns) {
				const literal = longestAstLiteral(pattern);
				if (!literal) return [];
				literals.push(literal);
			}
			return literals;
		}
		case "all":
			return requiredLiterals(node.children);
		case "any":
			return alternativeLiterals(node.children);
		// With no `else:`, every match runs the guard and the `then:` branch, so the
		// conjunction holds; with one, either branch can match on its own.
		case "if":
			return node.else ? alternativeLiterals([node.then, node.else]) : requiredLiterals([node.guard, node.then]);
		default:
			return [];
	}
}

/** The most selective conjunct's literals: whatever it requires, the match requires. */
function requiredLiterals(nodes: readonly CompiledNode[]): string[] {
	let best: string[] = [];
	for (const node of nodes) {
		const literals = literalsOf(node);
		if (literals.length === 0) continue;
		const selectivity = Math.min(...literals.map(literal => literal.length));
		const bestSelectivity = best.length === 0 ? -1 : Math.min(...best.map(literal => literal.length));
		if (selectivity > bestSelectivity) best = literals;
	}
	return best;
}

/** Every alternative's literals, or none if one alternative offers no guarantee. */
function alternativeLiterals(nodes: readonly CompiledNode[]): string[] {
	const literals: string[] = [];
	for (const node of nodes) {
		const nodeLiterals = literalsOf(node);
		if (nodeLiterals.length === 0) return [];
		literals.push(...nodeLiterals);
	}
	return literals;
}

/** Cheap pre-check for bulk scanning: `false` means the program cannot match. */
export function mayMatch(program: MatchProgram, text: string): boolean {
	if (program.literals.length === 0) return true;
	return program.literals.some(literal => text.includes(literal));
}
