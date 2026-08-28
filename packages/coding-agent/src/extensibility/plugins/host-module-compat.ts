import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type { ParseResult, ParserPlugin } from "@babel/parser";
import { parse as parseBabel } from "@babel/parser";
import { isCompiledBinary } from "@oh-my-pi/pi-utils";
import { registerPluginCacheInvalidator } from "../../discovery/helpers";

const IS_COMPILED_BINARY = isCompiledBinary();

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

export function resolveBundledVirtualSpecifier(specifier: string): HostBundledResolveResult {
	const registryKey = isBundledVirtualSpecifier(specifier) ? specifier.slice(HOST_BUNDLED_SCHEME.length) : specifier;
	if (!registryKey) {
		throw new Error("proto:host-modules: bundled virtual specifier has no registry key");
	}
	return { path: registryKey, namespace: HOST_BUNDLED_NAMESPACE };
}

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

async function synthesizeBundledModuleSource(moduleKey: string): Promise<string> {
	await loadBundledModule(moduleKey);
	return synthesizeBundledModuleSourceFromModules(moduleKey, loadedHostModules);
}

export function __synthesizeHostBundledSourceWithModules(
	moduleKey: string,
	modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
	return synthesizeBundledModuleSourceFromModules(moduleKey, modules);
}

export function __getHostBundledModulesGlobal(): string {
	return HOST_MODULES_GLOBAL;
}

const resolvedSpecifierFallbacks = new Map<string, string>();
const realpathCache = new Map<string, Promise<string>>();

function clearHostResolutionCaches(): void {
	resolvedSpecifierFallbacks.clear();
	realpathCache.clear();
	extensionSourceAnalysisCache.clear();
}

registerPluginCacheInvalidator(clearHostResolutionCaches);

const HOST_CODING_AGENT_ROOT = "@oh-my-pi/pi-coding-agent";

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

function resolveHostSpecifier(specifier: string): string {
	const override = hostPackageOverrides[specifier];
	if (override) {
		return override;
	}
	return getResolvedSpecifier(specifier);
}

function toImportSpecifier(resolvedPath: string): string {
	if (isBundledVirtualSpecifier(resolvedPath)) {
		return resolvedPath;
	}
	return url.pathToFileURL(resolvedPath).href;
}

async function rewriteHostExtensionSource(
	source: string,
	importerPath: string,
	mtimeTag: string | null = null,
): Promise<string> {
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
			} catch {}
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

const extensionGraphHookModules = new Map<string, Set<string>>();

interface ExtensionModuleGraph {
	readonly modules: Map<string, string>;
}

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
			} catch {}
		}
	}
	return { modules };
}

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

export async function loadHostModule(resolvedPath: string): Promise<unknown> {
	const entryRealPath = await realpathOrSelf(path.resolve(resolvedPath));
	await ensureHostOverridesReady();
	const pendingSources = await ensureExtensionGraphHook(entryRealPath);
	try {
		const entrySpecifier = isBundledVirtualSpecifier(entryRealPath)
			? toImportSpecifier(entryRealPath)
			: entryRealPath;
		return await import(`${entrySpecifier}?mtime=${nextHostLoadTag()}`);
	} finally {
		pendingSources?.clear();
	}
}

function resolveHostSpecifierForImport(args: { path: string; importer: string }): HostResolveResult | undefined {
	if (!HOST_SPECIFIER_FILTER.test(args.path)) {
		return undefined;
	}

	try {
		return toHostResolveResult(resolveHostSpecifier(args.path));
	} catch {
		try {
			return toHostResolveResult(Bun.resolveSync(args.path, path.dirname(args.importer)));
		} catch {
			return undefined;
		}
	}
}

let isHostModuleResolutionInstalled = false;

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

			build.onLoad({ filter: /.*/, namespace: HOST_BUNDLED_NAMESPACE }, async args => {
				return { contents: await synthesizeBundledModuleSource(args.path), loader: "js" };
			});
		},
	});
}
