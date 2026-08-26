/// <reference path="./host-virtual-modules.d.ts" />

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type { ParseResult, ParserPlugin } from "@babel/parser";
import { parse as parseBabel } from "@babel/parser";
import { isCompiledBinary } from "@oh-my-pi/pi-utils";
import { registerPluginCacheInvalidator } from "../../discovery/helpers";

const IS_COMPILED_BINARY = isCompiledBinary();

// === Bundled host modules (issue #3423) ===
//
// Bun 1.3.14 stopped exposing `--compile` extras through any filesystem-style
// API: `fs.existsSync`, `Bun.file().exists()`, `Bun.resolveSync`, and even
// `import("/$bunfs/...")` / `import("file:///$bunfs/...")` all fail for the
// embedded entries. Bun.plugin `onResolve` also no longer fires for transitive
// imports inside runtime-loaded extensions.
//
// Compiled builds retain lazy loaders for host packages and serve requested
// surfaces through `proto-host-bundled:<key>` synthetic modules.
// `scripts/host-virtual-module.ts` derives literal dynamic-import edges from
// current package exports inside a Bun build plugin: no generated source or
// duplicate key list exists on disk. Deferring each host module evaluation
// avoids cycles with an extension-loading command that is itself in the
// retained package graph.
const HOST_BUNDLED_SCHEME = "proto-host-bundled:";
const HOST_BUNDLED_NAMESPACE = "proto-host-bundled";
const HOST_MODULES_GLOBAL = "__ompHostBundledModules";

type HostModule = Readonly<Record<string, unknown>>;
type HostModules = Readonly<Record<string, HostModule>>;
type HostModuleLoaders = Readonly<Record<string, () => Promise<HostModule>>>;

interface HostResolveResult {
	path: string;
	namespace?: string;
}

interface HostBundledResolveResult {
	path: string;
	namespace: typeof HOST_BUNDLED_NAMESPACE;
}

// Specifiers the host resolves for extensions: exactly the current workspace
// package names (plus their exported subpaths). Anything else — old publish
// scopes, third-party bare deps, package `imports` aliases — resolves natively
// from the extension's own location or fails.
const HOST_PACKAGE_NAMES = [
	"omptype",
	"pi-agent-core",
	"pi-ai",
	"pi-coding-agent",
	"pi-natives",
	"pi-tui",
	"pi-utils",
] as const;

const HOST_SPECIFIER_FILTER = new RegExp(`^@oh-my-pi/(?:${HOST_PACKAGE_NAMES.join("|")})(?:/.*)?$`);

interface ExtensionSpecifierReference {
	readonly kind: "import" | "require";
	readonly specifier: string;
	readonly start: number;
	readonly end: number;
}

function parseExtensionSource(source: string, importerPath: string): ParseResult {
	const extension = path.extname(importerPath).toLowerCase();
	const plugins: ParserPlugin[] = ["decorators-legacy", "explicitResourceManagement"];
	if (extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".tsx") {
		plugins.push("typescript");
	}
	if (extension === ".jsx" || extension === ".tsx") {
		plugins.push("jsx");
	}

	try {
		return parseBabel(source, {
			sourceType: "unambiguous",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery: true,
			plugins,
		});
	} catch (error) {
		throw new Error(
			`Failed to parse extension source for dependency rewriting: ${importerPath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

const REQUIRE_BINDING = 1 << 0;
const OBJECT_BINDING = 1 << 1;
const EXPORTS_BINDING = 1 << 2;
const MODULE_BINDING = 1 << 3;

interface StructuralAstNode {
	readonly type: string;
	readonly [key: string]: unknown;
}

interface BindingScope {
	readonly parent: BindingScope | null;
	readonly ownsVarBindings: boolean;
	bindings: number;
}

interface ScopedAstNode {
	readonly node: StructuralAstNode;
	readonly scope: BindingScope;
	readonly order: number;
}

interface ScopeWalkItem {
	readonly node: StructuralAstNode;
	readonly scope: BindingScope | null;
	readonly parent: StructuralAstNode | null;
	readonly parentKey: string | null;
}

function asAstNode(value: unknown): StructuralAstNode | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as { readonly type?: unknown };
	return typeof candidate.type === "string" ? (candidate as StructuralAstNode) : null;
}

function nodeArray(node: StructuralAstNode, key: string): readonly unknown[] | null {
	const value = node[key];
	return Array.isArray(value) ? value : null;
}

function nodeArgument(node: StructuralAstNode | null, index: number): StructuralAstNode | null {
	if (!node) return null;
	const values = nodeArray(node, "arguments");
	return values ? asAstNode(values[index]) : null;
}

function isIdentifier(node: StructuralAstNode | null, name: string): boolean {
	return node?.type === "Identifier" && node.name === name;
}

function trackedBinding(name: unknown): number {
	switch (name) {
		case "require":
			return REQUIRE_BINDING;
		case "Object":
			return OBJECT_BINDING;
		case "exports":
			return EXPORTS_BINDING;
		case "module":
			return MODULE_BINDING;
		default:
			return 0;
	}
}

function addPatternBindings(scope: BindingScope, pattern: unknown): void {
	const stack: unknown[] = [pattern];
	while (stack.length > 0) {
		const node = asAstNode(stack.pop());
		if (!node) continue;
		switch (node.type) {
			case "Identifier":
				scope.bindings |= trackedBinding(node.name);
				break;
			case "AssignmentPattern":
				stack.push(node.left);
				break;
			case "RestElement":
				stack.push(node.argument);
				break;
			case "ArrayPattern": {
				const elements = nodeArray(node, "elements");
				if (elements) stack.push(...elements);
				break;
			}
			case "ObjectPattern": {
				const properties = nodeArray(node, "properties");
				if (!properties) break;
				for (const value of properties) {
					const property = asAstNode(value);
					if (!property) continue;
					stack.push(property.type === "RestElement" ? property.argument : property.value);
				}
				break;
			}
			case "TSParameterProperty":
				stack.push(node.parameter);
				break;
		}
	}
}

function isFunctionScopeNode(node: StructuralAstNode): boolean {
	switch (node.type) {
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression":
		case "ObjectMethod":
		case "ClassMethod":
		case "ClassPrivateMethod":
		case "TSDeclareFunction":
		case "TSDeclareMethod":
		case "DeclareFunction":
			return true;
		default:
			return false;
	}
}

function isFunctionDeclarationNode(node: StructuralAstNode): boolean {
	return node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction" || node.type === "DeclareFunction";
}

function isClassScopeNode(node: StructuralAstNode): boolean {
	return node.type === "ClassDeclaration" || node.type === "ClassExpression";
}

function scopeKind(node: StructuralAstNode, parent: StructuralAstNode | null, parentKey: string | null): 0 | 1 | 2 {
	if (
		node.type === "Program" ||
		isFunctionScopeNode(node) ||
		node.type === "StaticBlock" ||
		node.type === "TSModuleBlock"
	) {
		return 2;
	}
	if (
		isClassScopeNode(node) ||
		node.type === "CatchClause" ||
		node.type === "ForStatement" ||
		node.type === "ForInStatement" ||
		node.type === "ForOfStatement" ||
		node.type === "SwitchStatement"
	) {
		return 1;
	}
	if (node.type === "BlockStatement" && !(parent && isFunctionScopeNode(parent) && parentKey === "body")) {
		return 1;
	}
	return 0;
}

function nearestVarScope(scope: BindingScope): BindingScope {
	let current = scope;
	while (!current.ownsVarBindings && current.parent) current = current.parent;
	return current;
}

function registerOuterDeclaration(node: StructuralAstNode, scope: BindingScope | null): void {
	if (!scope) return;
	if (
		(isFunctionDeclarationNode(node) && node.type !== "TSDeclareFunction" && node.type !== "DeclareFunction") ||
		(node.type === "ClassDeclaration" && node.declare !== true)
	) {
		addPatternBindings(scope, node.id);
	}
}

function registerScopeBindings(node: StructuralAstNode, scope: BindingScope): void {
	if (isFunctionScopeNode(node)) {
		addPatternBindings(scope, node.id);
		const parameters = nodeArray(node, "params");
		if (parameters) {
			for (const parameter of parameters) addPatternBindings(scope, parameter);
		}
	}
	if (isClassScopeNode(node)) addPatternBindings(scope, node.id);
	if (node.type === "CatchClause") addPatternBindings(scope, node.param);

	if (node.type === "ImportDeclaration") {
		const specifiers = nodeArray(node, "specifiers");
		if (specifiers) {
			for (const value of specifiers) {
				const specifier = asAstNode(value);
				if (specifier) addPatternBindings(scope, specifier.local);
			}
		}
	} else if (node.type === "TSImportEqualsDeclaration") {
		addPatternBindings(scope, node.id);
	} else if (node.type === "VariableDeclaration") {
		const target = node.kind === "var" ? nearestVarScope(scope) : scope;
		const declarations = nodeArray(node, "declarations");
		if (declarations) {
			for (const value of declarations) {
				const declaration = asAstNode(value);
				if (declaration) addPatternBindings(target, declaration.id);
			}
		}
	}
}

function isAstMetadataKey(key: string): boolean {
	switch (key) {
		case "loc":
		case "extra":
		case "range":
		case "comments":
		case "tokens":
		case "errors":
		case "leadingComments":
		case "trailingComments":
		case "innerComments":
		case "parent":
		case "parentPath":
		case "scope":
		case "hub":
			return true;
		default:
			return false;
	}
}

function scopeForChild(
	node: StructuralAstNode,
	key: string,
	outerScope: BindingScope | null,
	nodeScope: BindingScope,
): BindingScope {
	if (node.type === "SwitchStatement" && key === "discriminant") {
		return outerScope ?? nodeScope;
	}
	if (isFunctionScopeNode(node) && (key === "key" || key === "decorators")) {
		return outerScope ?? nodeScope;
	}
	if (isClassScopeNode(node) && key === "decorators") {
		return outerScope ?? nodeScope;
	}
	return nodeScope;
}

/**
 * Builds only the lexical information needed by extension source rewriting.
 * Scope frames are fully populated before selected nodes are returned, so
 * hoisted and TDZ bindings behave independently of textual declaration order.
 */
function collectScopedAstNodes(root: unknown, select: (node: StructuralAstNode) => boolean): ScopedAstNode[] {
	const rootNode = asAstNode(root);
	if (!rootNode) return [];

	const selected: ScopedAstNode[] = [];
	const stack: ScopeWalkItem[] = [{ node: rootNode, scope: null, parent: null, parentKey: null }];
	const seen = new WeakSet<object>();
	let order = 0;
	while (stack.length > 0) {
		const item = stack.pop();
		if (!item || seen.has(item.node)) continue;
		seen.add(item.node);

		registerOuterDeclaration(item.node, item.scope);
		const kind = scopeKind(item.node, item.parent, item.parentKey);
		const activeScope: BindingScope | null =
			kind === 0
				? item.scope
				: {
						parent: item.scope,
						ownsVarBindings: kind === 2,
						bindings: 0,
					};
		if (activeScope) {
			registerScopeBindings(item.node, activeScope);
			if (select(item.node)) selected.push({ node: item.node, scope: activeScope, order });
		}
		order++;

		for (const key in item.node) {
			if (isAstMetadataKey(key)) continue;
			const childScope = activeScope ? scopeForChild(item.node, key, item.scope, activeScope) : null;
			const value = item.node[key];
			if (Array.isArray(value)) {
				for (const element of value) {
					const child = asAstNode(element);
					if (child) stack.push({ node: child, scope: childScope, parent: item.node, parentKey: key });
				}
			} else {
				const child = asAstNode(value);
				if (child) stack.push({ node: child, scope: childScope, parent: item.node, parentKey: key });
			}
		}
	}

	selected.sort((left, right) => {
		const leftStart = typeof left.node.start === "number" ? left.node.start : Number.MAX_SAFE_INTEGER;
		const rightStart = typeof right.node.start === "number" ? right.node.start : Number.MAX_SAFE_INTEGER;
		return leftStart - rightStart || left.order - right.order;
	});
	return selected;
}

function scopeHasBinding(scope: BindingScope, binding: number): boolean {
	let current: BindingScope | null = scope;
	while (current) {
		if ((current.bindings & binding) !== 0) return true;
		current = current.parent;
	}
	return false;
}

function isSpecifierReferenceNode(node: StructuralAstNode): boolean {
	switch (node.type) {
		case "ImportDeclaration":
		case "ExportNamedDeclaration":
		case "ExportAllDeclaration":
		case "ImportExpression":
		case "TSImportEqualsDeclaration":
		case "CallExpression":
			return true;
		default:
			return false;
	}
}
function collectExtensionSpecifierReferences(
	source: string,
	importerPath: string,
	ast: ParseResult = parseExtensionSource(source, importerPath),
): ExtensionSpecifierReference[] {
	const references: ExtensionSpecifierReference[] = [];
	const record = (kind: ExtensionSpecifierReference["kind"], literal: unknown): void => {
		const node = asAstNode(literal);
		if (
			node?.type === "StringLiteral" &&
			typeof node.value === "string" &&
			typeof node.start === "number" &&
			typeof node.end === "number"
		) {
			references.push({ kind, specifier: node.value, start: node.start, end: node.end });
		}
	};
	for (const { node, scope } of collectScopedAstNodes(ast, isSpecifierReferenceNode)) {
		if (
			node.type === "ImportDeclaration" ||
			node.type === "ExportNamedDeclaration" ||
			node.type === "ExportAllDeclaration"
		) {
			record("import", node.source);
		} else if (node.type === "ImportExpression") {
			record("import", node.source);
		} else if (node.type === "TSImportEqualsDeclaration") {
			const moduleReference = asAstNode(node.moduleReference);
			if (moduleReference?.type === "TSExternalModuleReference") {
				record("require", moduleReference.expression);
			}
		} else if (node.type === "CallExpression") {
			const callee = asAstNode(node.callee);
			if (callee?.type === "Import") {
				record("import", nodeArgument(node, 0));
			} else if (isIdentifier(callee, "require") && !scopeHasBinding(scope, REQUIRE_BINDING)) {
				record("require", nodeArgument(node, 0));
			}
		}
	}
	return references;
}

// === Extension source analysis (in-memory memo; parse cost dominates) ===

interface ExtensionSourceAnalysis {
	readonly references: readonly ExtensionSpecifierReference[];
}

const EXTENSION_ANALYSIS_CACHE_MAX_ENTRIES = 2_000;
const extensionSourceAnalysisCache = new Map<string, ExtensionSourceAnalysis>();

function extensionAnalysisCacheKey(source: string, importerPath: string): string {
	return `${path.extname(importerPath).toLowerCase()}:${Bun.hash(source).toString(16)}`;
}

function getExtensionSourceAnalysis(source: string, importerPath: string): ExtensionSourceAnalysis {
	const cacheKey = extensionAnalysisCacheKey(source, importerPath);
	const memoryCached = extensionSourceAnalysisCache.get(cacheKey);
	if (memoryCached) return memoryCached;

	const ast = parseExtensionSource(source, importerPath);
	const analysis: ExtensionSourceAnalysis = {
		references: collectExtensionSpecifierReferences(source, importerPath, ast),
	};
	if (extensionSourceAnalysisCache.size >= EXTENSION_ANALYSIS_CACHE_MAX_ENTRIES) {
		const oldest = extensionSourceAnalysisCache.keys().next().value;
		if (oldest !== undefined) extensionSourceAnalysisCache.delete(oldest);
	}
	extensionSourceAnalysisCache.set(cacheKey, analysis);
	return analysis;
}

function applySpecifierReplacements(
	source: string,
	replacements: ReadonlyArray<ExtensionSpecifierReference & { readonly replacement: string }>,
): string {
	let rewritten = source;
	for (const reference of [...replacements].sort((left, right) => right.start - left.start)) {
		rewritten = `${rewritten.slice(0, reference.start)}${JSON.stringify(reference.replacement)}${rewritten.slice(reference.end)}`;
	}
	return rewritten;
}

const loadedHostModules: Record<string, HostModule> = {};
let bundledModuleLoadersPromise: Promise<HostModuleLoaders> | null = null;

/**
 * Load the build-supplied module registry without evaluating its host modules.
 *
 * `globalThis` bridges the synthetic ES modules, which cannot close over this
 * file's lexical scope. Dev/test runs never execute the conditional import;
 * binary builds resolve it through the in-memory build plugin.
 */
function ensureHostModuleLoadersLoaded(): Promise<HostModuleLoaders> {
	if (!IS_COMPILED_BINARY) {
		return Promise.reject(new Error("proto:host-modules: bundled modules are only available in compiled mode"));
	}
	if (!bundledModuleLoadersPromise) {
		bundledModuleLoadersPromise = import("proto-host-modules").then(module => {
			Reflect.set(globalThis, HOST_MODULES_GLOBAL, loadedHostModules);
			return module.BUNDLED_HOST_MODULE_LOADERS;
		});
	}
	return bundledModuleLoadersPromise;
}

async function loadBundledModule(moduleKey: string): Promise<void> {
	const loaders = await ensureHostModuleLoadersLoaded();
	const loader = loaders[moduleKey];
	if (!loader) {
		throw new Error(`proto:host-modules: no bundled module registered for ${moduleKey}`);
	}
	loadedHostModules[moduleKey] = await loader();
}

function bundledModuleVirtualSpecifier(moduleKey: string): string {
	return `${HOST_BUNDLED_SCHEME}${moduleKey}`;
}

function isBundledVirtualSpecifier(value: string): boolean {
	return value.startsWith(HOST_BUNDLED_SCHEME);
}

function toHostResolveResult(resolvedPath: string): HostResolveResult {
	if (isBundledVirtualSpecifier(resolvedPath)) {
		const registryKey = resolvedPath.slice(HOST_BUNDLED_SCHEME.length);
		return { path: registryKey, namespace: HOST_BUNDLED_NAMESPACE };
	}
	return { path: resolvedPath };
}

/** Maps a bundled virtual specifier or registry key to Bun's plugin namespace shape. */
export function resolveBundledVirtualSpecifier(specifier: string): HostBundledResolveResult {
	const registryKey = isBundledVirtualSpecifier(specifier) ? specifier.slice(HOST_BUNDLED_SCHEME.length) : specifier;
	if (!registryKey) {
		throw new Error("proto:host-modules: bundled virtual specifier has no registry key");
	}
	return { path: registryKey, namespace: HOST_BUNDLED_NAMESPACE };
}

/**
 * Build a synthetic ES module for one live bundled namespace. Every export
 * reads through the global bridge; no bunfs path or copied package is involved.
 */
function synthesizeBundledModuleSourceFromModules(moduleKey: string, modules: HostModules): string {
	const mod = modules[moduleKey];
	if (!mod) {
		throw new Error(`proto:host-modules: no bundled module registered for ${moduleKey}`);
	}
	const lines: string[] = [
		`const __proto_bundled = globalThis[${JSON.stringify(HOST_MODULES_GLOBAL)}][${JSON.stringify(moduleKey)}];`,
	];
	let hasDefault = false;
	for (const exportName in mod) {
		if (exportName === "default") {
			hasDefault = true;
			continue;
		}
		lines.push(`export const ${exportName} = __proto_bundled[${JSON.stringify(exportName)}];`);
	}
	if (hasDefault) {
		lines.push("export default __proto_bundled.default;");
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Build the synthetic source served for one
 * `proto-host-bundled:<key>` import.
 */
async function synthesizeBundledModuleSource(moduleKey: string): Promise<string> {
	await loadBundledModule(moduleKey);
	return synthesizeBundledModuleSourceFromModules(moduleKey, loadedHostModules);
}

/** Test seam for the virtual module's named/default export forwarding. */
export function __synthesizeHostBundledSourceWithModules(
	moduleKey: string,
	modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
	return synthesizeBundledModuleSourceFromModules(moduleKey, modules);
}

/** Test seam for the global bridge key shared with synthetic module source. */
export function __getHostBundledModulesGlobal(): string {
	return HOST_MODULES_GLOBAL;
}

// Canonical scope for in-process pi packages. Plugins published against any of
// the aliased scopes below (mariozechner's original publish, earendil-works'
// fork, or the canonical @oh-my-pi scope itself) are remapped to this scope and
// resolved against the bundled copy that ships inside the omp binary. This
// keeps plugins running against the exact runtime state of the host (single
const resolvedSpecifierFallbacks = new Map<string, string>();
const realpathCache = new Map<string, Promise<string>>();

function clearHostResolutionCaches(): void {
	resolvedSpecifierFallbacks.clear();
	realpathCache.clear();
	extensionSourceAnalysisCache.clear();
}

registerPluginCacheInvalidator(clearHostResolutionCaches);

// Package-root overrides for the current `@oh-my-pi/*` specifiers. In compiled
// binaries every registry key maps to a `proto-host-bundled:<key>` specifier
// (bunfs paths are unreachable — issue #3423). In dev / source-link mode the
// canonical specifiers resolve cleanly through `Bun.resolveSync` from the host
// root, with one exception: the `@oh-my-pi/pi-coding-agent` root serves a
// surface module retaining the synchronous `AuthStorage` facade extensions
// rely on during module initialization (issue #5879).

const HOST_CODING_AGENT_ROOT = "@oh-my-pi/pi-coding-agent";

/**
 * Compute the package root for the npm prebuilt `dist/cli.js` bundle.
 *
 * `bundle-dist.ts` defines `process.env.PI_BUNDLED="true"`; after bundling,
 * `import.meta.dir` points at `<package>/dist`.
 */
function computeSelfPackageRoot(metaDir: string): string {
	const normalizedMetaDir = path.normalize(metaDir);
	if (path.basename(normalizedMetaDir) === "dist") {
		return path.resolve(metaDir, "..");
	}

	const pluginsDirSuffix = path.join("src", "extensibility", "plugins");
	if (normalizedMetaDir.endsWith(pluginsDirSuffix)) {
		return path.resolve(metaDir, "..", "..", "..");
	}

	return path.resolve(metaDir);
}

const HOST_CODING_AGENT_ROOT_SURFACE = (() => {
	const selfRoot = process.env.PI_BUNDLED ? computeSelfPackageRoot(import.meta.dir) : import.meta.dir;
	const candidates = [
		path.join(selfRoot, "host-pi-coding-agent-surface.ts"),
		path.join(selfRoot, "src", "extensibility", "plugins", "host-pi-coding-agent-surface.ts"),
	];
	return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
})();

let hostPackageOverrides: Record<string, string> = HOST_CODING_AGENT_ROOT_SURFACE
	? { [HOST_CODING_AGENT_ROOT]: HOST_CODING_AGENT_ROOT_SURFACE }
	: {};
let hostOverridesReadyPromise: Promise<void> | null = null;

/** Complete compiled-mode overrides from the lazy host-module registry. */
function ensureHostOverridesReady(): Promise<void> {
	if (!IS_COMPILED_BINARY) {
		return Promise.resolve();
	}
	if (!hostOverridesReadyPromise) {
		hostOverridesReadyPromise = ensureHostModuleLoadersLoaded().then(loaders => {
			const overrides: Record<string, string> = {};
			for (const key of Object.keys(loaders)) {
				if (HOST_SPECIFIER_FILTER.test(key)) {
					overrides[key] = bundledModuleVirtualSpecifier(key);
				}
			}
			hostPackageOverrides = overrides;
		});
	}
	return hostOverridesReadyPromise;
}

function getResolvedSpecifier(specifier: string): string {
	const cached = resolvedSpecifierFallbacks.get(specifier);
	if (cached) {
		return cached;
	}

	const resolved = Bun.resolveSync(specifier, import.meta.dir);
	resolvedSpecifierFallbacks.set(specifier, resolved);
	return resolved;
}

/**
 * Resolve a current `@oh-my-pi/*` specifier to a filesystem path — or, in
 * compiled-binary mode, its bundled virtual specifier.
 *
 * Falls back to `getResolvedSpecifier` (which may throw under compiled binary
 * mode); callers handle that the same way they would for unresolved
 * specifiers.
 */
function resolveHostSpecifier(specifier: string): string {
	const override = hostPackageOverrides[specifier];
	if (override) {
		return override;
	}
	return getResolvedSpecifier(specifier);
}

function toImportSpecifier(resolvedPath: string): string {
	// Virtual `proto-host-bundled:` specifiers are served by the synthetic
	// onLoad in `installHostModuleResolution()`; wrapping them as `file://`
	// would corrupt the scheme.
	if (isBundledVirtualSpecifier(resolvedPath)) {
		return resolvedPath;
	}
	return url.pathToFileURL(resolvedPath).href;
}

/**
 * Rewrite the extension-owned specifiers OMP must host-resolve — current
 * `@oh-my-pi/*` package imports — to absolute `file://` URLs or compiled-mode
 * virtual specifiers. Relative siblings and built-in modules are left
 * untouched so Bun resolves them from the extension's real on-disk location.
 *
 * When `mtimeTag` is provided, extension-owned relative graph specifiers
 * (`./`/`../`) also carry a `?mtime=<tag>` cache-bust so Bun rekeys them on
 * same-process reloads. Host package rewrites always emit `file://` URLs or
 * bundled virtual specifiers because they resolve to in-process host code
 * that never changes between reloads.
 */
async function rewriteHostExtensionSource(
	source: string,
	importerPath: string,
	mtimeTag: string | null = null,
): Promise<string> {
	// Compiled mode completes the override map from the build-supplied module
	// keys on first use; every rewrite path must see the full map.
	await ensureHostOverridesReady();
	const references = getExtensionSourceAnalysis(source, importerPath).references;
	const replacements: Array<ExtensionSpecifierReference & { replacement: string }> = [];
	for (const reference of references) {
		if (reference.kind !== "import") continue;

		const specifier = reference.specifier;
		let replacement: string | null = null;
		if (HOST_SPECIFIER_FILTER.test(specifier)) {
			try {
				replacement = toImportSpecifier(resolveHostSpecifier(specifier));
			} catch {
				// Compiled fallback may be absent from a malformed build. Leave the
				// specifier untouched so native resolution gets its chance.
			}
		}
		if (!replacement && mtimeTag && /^\.\.?\//.test(specifier) && !specifier.includes("?")) {
			replacement = `${specifier}?mtime=${mtimeTag}`;
		}
		if (replacement && replacement !== specifier) {
			replacements.push({ ...reference, replacement });
		}
	}
	return applySpecifierReplacements(source, replacements);
}

/** Test seam for compiled-binary host-module source rewriting. */
export async function __rewriteHostExtensionSourceForTests(
	source: string,
	importerPath: string,
	mtimeTag: string | null = null,
): Promise<string> {
	return rewriteHostExtensionSource(source, importerPath, mtimeTag);
}

function hasSourceModuleExtension(p: string): boolean {
	const ext = path.extname(p).toLowerCase();
	return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
}

let hostLoadTag = 0;

function nextHostLoadTag(): string {
	hostLoadTag = Math.max(hostLoadTag + 1, Date.now());
	return String(hostLoadTag);
}

/** Resolve symlinks in a path, falling back to the input if realpath fails. */
async function realpathOrSelf(p: string): Promise<string> {
	const cached = realpathCache.get(p);
	if (cached) return cached;

	const promise = realpathOrSelfUncached(p);
	realpathCache.set(p, promise);
	return promise;
}

async function realpathOrSelfUncached(p: string): Promise<string> {
	try {
		return await fs.promises.realpath(p);
	} catch {
		return p;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLoader(path: string): "js" | "jsx" | "ts" | "tsx" {
	if (path.endsWith(".tsx")) {
		return "tsx";
	}
	if (path.endsWith(".jsx")) {
		return "jsx";
	}
	if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
		return "ts";
	}
	return "js";
}

// === Extension module graph ===

// Extension source realpaths already covered by an installed load-time hook for
// each entry. `Bun.plugin()` registrations are process-global and permanent, so
// reloads install supplemental hooks only for modules added to the graph since
// the previous load.
const extensionGraphHookModules = new Map<string, Set<string>>();

interface ExtensionModuleGraph {
	readonly modules: Map<string, string>;
}

/**
 * Walk the extension's import graph starting at `entryRealPath`, returning the
 * realpath of every reachable source module OMP must rewrite at load time.
 * Only relative imports are graph-owned: host `@oh-my-pi/*` imports are
 * rewritten per module without being followed, and everything else resolves
 * natively from the extension's own location.
 */
async function collectHostExtensionModules(entryRealPath: string): Promise<ExtensionModuleGraph> {
	const modules = new Map<string, string>();
	const queue: string[] = [entryRealPath];
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || modules.has(file)) {
			continue;
		}
		let source: string;
		try {
			source = await Bun.file(file).text();
		} catch {
			continue;
		}
		modules.set(file, source);
		const dir = path.dirname(file);
		for (const reference of getExtensionSourceAnalysis(source, file).references) {
			if (reference.kind !== "import") continue;
			const specifier = reference.specifier;
			if (!specifier.startsWith(".")) continue;
			try {
				const candidate = Bun.resolveSync(specifier, dir);
				if (!hasSourceModuleExtension(candidate)) continue;
				const resolved = await realpathOrSelf(candidate);
				if (!modules.has(resolved)) {
					queue.push(resolved);
				}
			} catch {
				// Unresolvable import (e.g. a type-only path); skip it.
			}
		}
	}
	return { modules };
}

/**
 * Register an onLoad hook scoped to one entry's source graph. The hook
 * rewrites only host-resolved imports and tags relative edges with the load's
 * `?mtime` so same-process reloads pick up edits.
 */
function installExtensionGraphHook(
	entryRealPath: string,
	modules: Map<string, string>,
): { asyncModules: Map<string, string> } {
	const asyncModules = new Map(modules);
	if (asyncModules.size > 0) {
		const alternation = [...asyncModules.keys()].map(escapeRegExp).join("|");
		const filter = new RegExp(`^(?:${alternation})(?:\\?mtime=\\d+)?$`);
		const hookId = Bun.hash(`${entryRealPath}\0host\0${[...asyncModules.keys()].join("\0")}`).toString(36);
		Bun.plugin({
			name: `proto:host-ext:${hookId}`,
			setup(build) {
				build.onLoad({ filter, namespace: "file" }, args => {
					const queryIndex = args.path.indexOf("?mtime=");
					const sourcePath = queryIndex >= 0 ? args.path.slice(0, queryIndex) : args.path;
					const mtimeTag = queryIndex >= 0 ? args.path.slice(queryIndex + "?mtime=".length) : null;
					const cached = asyncModules.get(sourcePath);
					return (async () => {
						let raw: string;
						if (cached !== undefined) {
							// consume-once: preserves ?mtime edit-pickup for re-imports
							asyncModules.delete(sourcePath);
							raw = cached;
						} else {
							raw = await Bun.file(sourcePath).text();
						}
						return {
							contents: await rewriteHostExtensionSource(raw, sourcePath, mtimeTag),
							loader: getLoader(sourcePath),
						};
					})();
				});
			},
		});
	}
	return { asyncModules };
}

/**
 * Ensure every currently reachable extension source module has a load-time
 * rewrite hook. The entry graph can grow across reloads, so each call collects
 * the current graph and registers hooks for paths not covered by earlier loads.
 *
 * Returns a clearable handle to drop cached sources that weren't consumed
 * during the initial load; `undefined` when no new modules were discovered.
 */
async function ensureExtensionGraphHook(entryRealPath: string): Promise<{ clear(): void } | undefined> {
	const { modules } = await collectHostExtensionModules(entryRealPath);
	let hookedModules = extensionGraphHookModules.get(entryRealPath);
	if (!hookedModules) {
		hookedModules = new Set<string>();
		extensionGraphHookModules.set(entryRealPath, hookedModules);
	}

	const pendingModules = new Map<string, string>();
	for (const [modulePath, source] of modules) {
		if (!hookedModules.has(modulePath)) {
			pendingModules.set(modulePath, source);
		}
	}
	if (pendingModules.size === 0) {
		return undefined;
	}

	const { asyncModules } = installExtensionGraphHook(entryRealPath, pendingModules);
	for (const modulePath of pendingModules.keys()) {
		hookedModules.add(modulePath);
	}
	return {
		clear() {
			asyncModules.clear();
		},
	};
}

/**
 * Load an extension module from its real on-disk location with host-module
 * resolution active.
 *
 * The extension runs in place, so its `import.meta.url` is the real source file
 * and `__dirname`-relative `readFileSync` asset loads (HTML/CSS bundled next to
 * the entry) resolve exactly as they do on disk — no temp-directory mirroring
 * and no asset copying. An `onLoad` hook scoped to the entry's source graph
 * rewrites only host-resolved imports in the extension's own source;
 * everything else resolves natively.
 */
export async function loadHostModule(resolvedPath: string): Promise<unknown> {
	// Bun reports the realpath of a loaded module to `onLoad` and exposes it as
	// `import.meta.url`. Resolve symlinks here too (macOS `/var`→`/private/var`,
	// `bun link`/pnpm installs) so the rewrite filter matches the path Bun
	// actually hands the hook.
	const entryRealPath = await realpathOrSelf(path.resolve(resolvedPath));
	await ensureHostOverridesReady();
	const pendingSources = await ensureExtensionGraphHook(entryRealPath);
	try {
		// Dynamic import is required: extension entry paths are user/plugin
		// supplied at runtime. On POSIX, use the raw filesystem path so Bun keys
		// the `?mtime` suffix as part of the module identity; Bun ignores query
		// strings on `file://` specifiers, which would serve stale edited source.
		const entrySpecifier = isBundledVirtualSpecifier(entryRealPath)
			? toImportSpecifier(entryRealPath)
			: entryRealPath;
		return await import(`${entrySpecifier}?mtime=${nextHostLoadTag()}`);
	} finally {
		// Drop whatever the initial import didn't consume: graph modules only
		// reached by lazy dynamic imports must be read from disk at their actual
		// import time, not served from this load-time snapshot.
		pendingSources?.clear();
	}
}

function resolveHostSpecifierForImport(args: { path: string; importer: string }): HostResolveResult | undefined {
	if (!HOST_SPECIFIER_FILTER.test(args.path)) {
		return undefined;
	}

	// Primary: resolve the current @oh-my-pi/* specifier from the host root.
	// Works in dev mode and in source-link installs.
	try {
		return toHostResolveResult(resolveHostSpecifier(args.path));
	} catch {
		// Fallback for compiled binary mode: the bundled packages live inside
		// /$bunfs/root and aren't reachable by filesystem resolution. Prefer the
		// canonical specifier against the importing file's directory when the
		// plugin installed @oh-my-pi peer deps. A peer copy shadows the host
		// module registry only when the host itself cannot resolve the import.
		try {
			return toHostResolveResult(Bun.resolveSync(args.path, path.dirname(args.importer)));
		} catch {
			return undefined;
		}
	}
}

let isHostModuleResolutionInstalled = false;

/**
 * Install runtime resolution for current `@oh-my-pi/*` specifiers inside
 * dynamically loaded extensions and plugins: bundled virtual namespaces in
 * compiled binaries, host-rooted package entries everywhere else. Legacy
 * publish scopes are intentionally not recognized.
 */
export function installHostModuleResolution(): void {
	if (isHostModuleResolutionInstalled) {
		return;
	}
	isHostModuleResolutionInstalled = true;

	Bun.plugin({
		name: "proto:host-module-resolution",
		setup(build) {
			build.onResolve({ filter: HOST_SPECIFIER_FILTER, namespace: "file" }, resolveHostSpecifierForImport);
			build.onResolve({ filter: /^proto-host-bundled:.+$/, namespace: "file" }, args =>
				resolveBundledVirtualSpecifier(args.path),
			);
			build.onResolve({ filter: /.*/, namespace: HOST_BUNDLED_NAMESPACE }, args =>
				resolveBundledVirtualSpecifier(args.path),
			);
			// Compiled mode serves `proto-host-bundled:<key>` imports from live
			// host module references. No bunfs path leaves this loader.
			build.onLoad({ filter: /.*/, namespace: HOST_BUNDLED_NAMESPACE }, async args => {
				return { contents: await synthesizeBundledModuleSource(args.path), loader: "js" };
			});
		},
	});
}
