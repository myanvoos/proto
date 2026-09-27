import * as nodeModule from "node:module";
import type * as BabelParser from "@babel/parser";

type BabelImportDeclaration = {
	type: "ImportDeclaration";
	start: number;
	end: number;
	source: { value: string };
	specifiers: ReadonlyArray<{
		type: "ImportDefaultSpecifier" | "ImportNamespaceSpecifier" | "ImportSpecifier";
		local: { name: string };
		imported?: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
	}>;
	attributes?: ReadonlyArray<{
		key: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
		value: { value: string };
	}>;
};

type BabelBindingPattern = {
	type: string;
	name?: string;
	properties?: ReadonlyArray<unknown>;
	elements?: ReadonlyArray<unknown | null>;
	argument?: unknown;
	left?: unknown;
	value?: unknown;
};

type BabelVariableDeclaration = {
	type: "VariableDeclaration";
	kind: "const" | "let" | "var";
	start: number;
	end: number;
	declarations?: ReadonlyArray<{ id: BabelBindingPattern }>;
};

type BabelClassDeclaration = {
	type: "ClassDeclaration";
	start: number;
	end: number;
	id: { start: number; end: number; name: string } | null;
};

type BabelLexicalDecl = BabelVariableDeclaration | BabelClassDeclaration;
type BabelFunctionDeclaration = {
	type: "FunctionDeclaration";
	start: number;
	end: number;
	id: { start: number; end: number; name: string } | null;
};

type BabelPublishableDecl = BabelLexicalDecl | BabelFunctionDeclaration;

type BabelExpressionStatement = {
	type: "ExpressionStatement";
	start: number;
	end: number;
	expression?: { type?: string };
};

type BabelProgramNode = BabelImportDeclaration | BabelLexicalDecl | BabelExpressionStatement | { type: string };
type BabelModuleSourceDeclaration = {
	type: "ImportDeclaration" | "ExportNamedDeclaration" | "ExportAllDeclaration";
	source?: { value: string; start: number; end: number } | null;
};

type BabelNode = { type: string; start: number; end: number; [key: string]: unknown };

let babelParser: typeof BabelParser | undefined;

async function loadBabelParser(): Promise<typeof BabelParser> {
	if (!babelParser) {
		babelParser = await import("@babel/parser");
	}
	return babelParser;
}

async function parseProgram(
	code: string,
): Promise<{ program: { body: ReadonlyArray<BabelProgramNode>; directives?: ReadonlyArray<{ end: number }> } } | null> {
	const { parse } = await loadBabelParser();
	try {
		return parse(code, {
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery: true,
			plugins: ["typescript"],
		}) as unknown as { program: { body: ReadonlyArray<BabelProgramNode> } };
	} catch {
		return null;
	}
}

const DYNAMIC_IMPORT_CALLEE = '(typeof __proto_import__ === "function" ? __proto_import__ : (s, o) => import(s, o))';

function walkNodes(root: unknown, visit: (node: BabelNode) => void): void {
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
			continue;
		}
		const node = current as Record<string, unknown>;
		if (typeof node.type === "string") visit(node as unknown as BabelNode);
		for (const key in node) {
			if (key === "loc" || key === "extra" || key === "range") continue;
			if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
			const value = node[key];
			if (value && typeof value === "object") stack.push(value);
		}
	}
}

async function rewriteDynamicImports(code: string): Promise<string> {
	if (!code.includes("import")) return code;

	const ast = await parseProgram(code);
	if (!ast) {
		return code;
	}

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];

	walkNodes(ast, node => {
		if (node.type !== "CallExpression") return;
		const call = node as unknown as { callee?: { type?: string; start?: number; end?: number } };
		const callee = call.callee;
		if (callee?.type !== "Import" || typeof callee.start !== "number" || typeof callee.end !== "number") return;
		edits.push({ start: callee.start, end: callee.end, text: DYNAMIC_IMPORT_CALLEE });
	});

	if (edits.length === 0) return code;

	edits.sort((a, b) => b.start - a.start);
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}
export async function collectModuleSourceSpecifiers(code: string): Promise<string[]> {
	const ast = await parseProgram(code);
	if (!ast) return [];
	const sources: string[] = [];
	for (const node of ast.program.body) {
		if (
			(node.type === "ImportDeclaration" ||
				node.type === "ExportNamedDeclaration" ||
				node.type === "ExportAllDeclaration") &&
			typeof (node as BabelModuleSourceDeclaration).source?.value === "string"
		) {
			sources.push((node as BabelModuleSourceDeclaration).source!.value);
		}
	}
	return sources;
}

function collectBindingNames(pattern: unknown, names: string[]): void {
	if (!pattern || typeof pattern !== "object") return;
	const node = pattern as BabelBindingPattern & { parameter?: unknown };
	switch (node.type) {
		case "Identifier":
			if (typeof node.name === "string") names.push(node.name);
			return;
		case "ObjectPattern":
			for (const property of node.properties ?? []) collectBindingNames(property, names);
			return;
		case "ObjectProperty":
		case "Property":
			collectBindingNames(node.value, names);
			return;
		case "ArrayPattern":
			for (const element of node.elements ?? []) collectBindingNames(element, names);
			return;
		case "AssignmentPattern":
			collectBindingNames(node.left, names);
			return;
		case "RestElement":
			collectBindingNames(node.argument, names);
			return;
		case "TSParameterProperty":
			collectBindingNames(node.parameter, names);
			return;
		default:
			return;
	}
}

function getLexicalBindingNames(node: BabelPublishableDecl): string[] {
	const names: string[] = [];
	if (node.type === "VariableDeclaration") {
		for (const declaration of node.declarations ?? []) collectBindingNames(declaration.id, names);
	} else if (node.id) {
		names.push(node.id.name);
	}
	return names;
}

/** Export accessors, not values: closures and later cells share the original engine binding. */
function bindingDescriptor(name: string, parameter: string, readonly: boolean): string {
	return `${JSON.stringify(name)}: { get: () => ${name}, set: (${parameter}) => { ${readonly ? 'throw new TypeError("Assignment to constant variable.");' : `${name} = ${parameter};`} } }`;
}

function collectCellBindings(body: ReadonlyArray<BabelProgramNode>): {
	lexical: string[];
	global: string[];
	readonly: string[];
} {
	const lexical: string[] = [];
	const readonly: string[] = [];
	const globals: string[] = [];
	for (const node of body) {
		if (node.type === "VariableDeclaration") {
			const declaration = node as BabelVariableDeclaration;
			if (declaration.kind !== "var") lexical.push(...getLexicalBindingNames(declaration));
			if (declaration.kind === "const") readonly.push(...getLexicalBindingNames(declaration));
		} else if (node.type === "ClassDeclaration") {
			lexical.push(...getLexicalBindingNames(node as BabelClassDeclaration));
		} else if (node.type === "FunctionDeclaration") {
			globals.push(...getLexicalBindingNames(node as BabelFunctionDeclaration));
		}
	}
	// `var` is function scoped, including declarations in loops, branches and catch bodies.
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const node = value as BabelNode;
		if (isExecutionBoundary(node.type) || node.type === "ClassDeclaration" || node.type === "ClassExpression") return;
		if (node.type === "VariableDeclaration" && node.kind === "var")
			globals.push(...getLexicalBindingNames(node as unknown as BabelVariableDeclaration));
		for (const [key, child] of Object.entries(node)) {
			if (key === "loc" || key.endsWith("Comments")) continue;
			if (child && typeof child === "object") visit(child);
		}
	};
	visit(body);
	return { lexical: [...new Set(lexical)], global: [...new Set(globals)], readonly };
}

async function returnFinalExpression(code: string): Promise<{ source: string; returned: boolean }> {
	const ast = await parseProgram(code);
	const body = ast?.program.body;
	if (!body) return { source: code, returned: false };
	let lastIndex = body.length - 1;
	while (lastIndex >= 0 && body[lastIndex]?.type === "EmptyStatement") lastIndex--;
	const last = lastIndex >= 0 ? body[lastIndex] : undefined;
	if (last?.type === "ExpressionStatement") {
		const expression = last as BabelExpressionStatement;
		const prefix = code.slice(0, expression.start);
		const statement = code.slice(expression.start, expression.end);
		const suffix = code.slice(expression.end);
		const semicolonMatch = statement.match(/;\s*$/);
		const trimmedStatement = semicolonMatch ? statement.slice(0, semicolonMatch.index) : statement;
		return { source: `${prefix}__proto_set_final_expr__((${trimmedStatement}));${suffix}`, returned: true };
	}
	if (last?.type === "ReturnStatement") {
		const ret = last as unknown as { start: number; end: number; argument?: { start: number; end: number } | null };
		if (!ret.argument) return { source: code, returned: false };
		const prefix = code.slice(0, ret.start);
		const suffix = code.slice(ret.end);
		const expr = code.slice(ret.argument.start, ret.argument.end);
		return { source: `${prefix}__proto_set_final_expr__((${expr}));${suffix}`, returned: true };
	}
	return { source: code, returned: false };
}

function isExecutionBoundary(type: string): boolean {
	return (
		type === "FunctionDeclaration" ||
		type === "FunctionExpression" ||
		type === "ArrowFunctionExpression" ||
		type === "ObjectMethod" ||
		type === "ClassMethod" ||
		type === "ClassPrivateMethod" ||
		type === "PrivateMethod"
	);
}

function containsAsyncWrapperSyntax(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsAsyncWrapperSyntax(item)) return true;
		}
		return false;
	}

	const node = value as Record<string, unknown>;
	const type = node.type;
	if (type === "ReturnStatement" || type === "AwaitExpression") return true;
	if (type === "MetaProperty" && (node.meta as { name?: string } | undefined)?.name === "import") return true;
	if (type === "ForOfStatement" && node.await === true) return true;
	if (typeof type === "string" && isExecutionBoundary(type)) return false;

	for (const key in node) {
		if (key === "loc" || key === "extra" || key === "range") continue;
		if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
		if (containsAsyncWrapperSyntax(node[key])) return true;
	}
	return false;
}

async function requiresAsyncWrapper(code: string): Promise<boolean> {
	const ast = await parseProgram(code);
	if (!ast) return false;
	for (const node of ast.program.body) {
		if (containsAsyncWrapperSyntax(node)) return true;
	}
	return false;
}

type TypeScriptStripLoader = "ts" | "tsx";
type TypeScriptStripper = (code: string, loader: TypeScriptStripLoader) => string;

type NodeTypeStripper = (code: string, options: { mode: "strip" | "transform" }) => string;

/**
 * The same runtime serves Bun and Node kernels (eval/js/node-entry.ts). Bun transpiles TS and TSX;
 * Node strips TS with `module.stripTypeScriptTypes` (22.13+) and has no JSX transform, so TSX — and
 * TS on older Node — stays as written and fails as the SyntaxError the interpreter would raise.
 */
function createTypeScriptStripper(): TypeScriptStripper | null {
	if (typeof Bun !== "undefined") {
		const ts = new Bun.Transpiler({ loader: "ts" });
		const tsx = new Bun.Transpiler({ loader: "tsx" });
		return (code, loader) => (loader === "tsx" ? tsx : ts).transformSync(code);
	}
	const strip = (nodeModule as { stripTypeScriptTypes?: NodeTypeStripper }).stripTypeScriptTypes;
	if (typeof strip !== "function") return null;
	return (code, loader) => (loader === "tsx" ? code : strip(code, { mode: "transform" }));
}

let typeScriptStripper: TypeScriptStripper | null | undefined;

function stripTypeScript(code: string, options: { force?: boolean; loader?: TypeScriptStripLoader } = {}): string {
	if (!options.force && !LOOKS_LIKE_TS.test(code)) return code;
	typeScriptStripper ??= createTypeScriptStripper();
	if (!typeScriptStripper) return code;
	try {
		return typeScriptStripper(code, options.loader ?? "ts");
	} catch {
		return code;
	}
}
export function stripTypeScriptSyntax(
	code: string,
	options: { force?: boolean; loader?: TypeScriptStripLoader } = {},
): string {
	return stripTypeScript(code, options);
}

const LOOKS_LIKE_TS =
	/(?:\bimport\s+type\b|\bexport\s+type\b|\b(?:import|export)\s*\{[^}\n]*\btype\s+\w|\binterface\s+\w|\btype\s+\w+\s*=|\b(?:as|satisfies)\s+(?:[A-Z]|\bconst\b)|:\s*(?:string|number|boolean|any|unknown|void|never|object|[A-Z]\w*)\b|<\s*[A-Z]\w*\s*[,>])/;

/** Bun selects CommonJS for free CommonJS bindings, lexical top-level this, or a strict directive. */
function usesCommonJsBindings(root: unknown): boolean {
	const common: Record<string, true> = {
		require: true,
		module: true,
		exports: true,
		__filename: true,
		__dirname: true,
	};
	let found = false;
	const visit = (value: unknown, scopes: readonly Set<string>[], lexicalThis: boolean): void => {
		if (!value || typeof value !== "object" || found) return;
		if (Array.isArray(value)) {
			for (const child of value) visit(child, scopes, lexicalThis);
			return;
		}
		const node = value as BabelNode;
		if (node.type === "ThisExpression") {
			if (lexicalThis) found = true;
			return;
		}
		if (node.type === "Identifier") {
			const name = String(node.name);
			if (Object.hasOwn(common, name) && !scopes.some(scope => scope.has(name))) found = true;
			return;
		}
		if (node.type === "Program" || node.type === "BlockStatement") {
			const bindings = collectCellBindings(node.body as BabelProgramNode[]);
			const names = node.type === "Program" ? [...bindings.lexical, ...bindings.global] : bindings.lexical;
			visit(node.body, [...scopes, new Set(names)], lexicalThis);
			return;
		}
		if (isExecutionBoundary(node.type)) {
			if (node.computed) visit(node.key, scopes, lexicalThis);
			const names: string[] = [];
			collectBindingNames(node.id, names);
			for (const parameter of (node.params as unknown[]) ?? []) collectBindingNames(parameter, names);
			const body = node.body as BabelNode | undefined;
			const bindings = collectCellBindings(body?.type === "BlockStatement" ? (body.body as BabelProgramNode[]) : []);
			visit(
				node.body,
				[...scopes, new Set([...names, ...bindings.lexical, ...bindings.global])],
				node.type === "ArrowFunctionExpression" && lexicalThis,
			);
			return;
		}
		if (node.type === "VariableDeclarator") {
			visit(node.init, scopes, lexicalThis);
			return;
		}
		if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
			visit(node.object, scopes, lexicalThis);
			if (node.computed) visit(node.property, scopes, lexicalThis);
			return;
		}
		if (node.type === "ObjectProperty") {
			if (node.computed) visit(node.key, scopes, lexicalThis);
			visit(node.value, scopes, lexicalThis);
			return;
		}
		if (node.type === "StaticBlock") lexicalThis = false;
		for (const [key, child] of Object.entries(node)) {
			if (key === "loc" || key === "id" || key.endsWith("Comments")) continue;
			visit(
				child,
				scopes,
				(node.type === "ClassProperty" || node.type === "ClassPrivateProperty") && key === "value"
					? false
					: lexicalThis,
			);
		}
	};
	visit(root, [], true);
	return found;
}

let nativeBunTranspiler: Bun.Transpiler | undefined;

export async function wrapCode(
	code: string,
	persistentNames: readonly string[] = [],
): Promise<{ source: string; asyncWrapped: boolean; finalExpressionReturned: boolean }> {
	const stripped = stripTypeScript(code);
	const ast = await parseProgram(stripped);
	const imports = (ast?.program.body ?? []).filter(
		node => node.type === "ImportDeclaration",
	) as BabelImportDeclaration[];
	const importedNames = imports.flatMap(node => node.specifiers.map(specifier => specifier.local.name));
	const originalBindings = collectCellBindings(ast?.program.body ?? []);
	const declared = new Set([...originalBindings.lexical, ...originalBindings.global]);
	for (const name of importedNames) {
		if (declared.has(name)) throw new SyntaxError(`Identifier '${name}' has already been declared`);
		declared.add(name);
	}
	let source = stripped;
	for (const node of [...imports].reverse())
		source =
			source.slice(0, node.start) +
			source.slice(node.start, node.end).replace(/[^\n]/g, " ") +
			source.slice(node.end);
	const finalExpression = await returnFinalExpression(source);
	source = await rewriteDynamicImports(finalExpression.source);
	const body = await parseProgram(source);
	// Object environment records provide live lookup for prior cells and imports. Bare calls must
	// retain lexical-call `this`, rather than receiving that implementation object as their receiver.
	const scopedNames = new Set([...persistentNames, ...importedNames]);
	const callEdits: Array<{ start: number; end: number; name: string }> = [];
	const rewriteContext = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const child of value) rewriteContext(child);
			return;
		}
		const node = value as BabelNode;
		if (node.type === "ThisExpression" && typeof Bun === "undefined") {
			callEdits.push({ start: node.start, end: node.end, name: "__proto_cell_this__" });
			return;
		}
		if (isExecutionBoundary(node.type) && node.type !== "ArrowFunctionExpression") {
			if (node.computed) rewriteContext(node.key);
			return;
		}
		if (node.type === "StaticBlock") return;
		for (const [key, child] of Object.entries(node)) {
			if (key === "loc" || key.endsWith("Comments")) continue;
			if ((node.type === "ClassProperty" || node.type === "ClassPrivateProperty") && key === "value") continue;
			rewriteContext(child);
		}
	};
	rewriteContext(body);

	for (const edit of callEdits.sort((a, b) => b.start - a.start))
		source = `${source.slice(0, edit.start)}(0, ${edit.name})${source.slice(edit.end)}`;
	let parameter = "__proto_binding_value__";
	while (source.includes(parameter)) parameter += "_";
	const bindings = collectCellBindings(body?.program.body ?? []);
	const asyncWrapped = imports.length > 0 || (await requiresAsyncWrapper(source));
	const directives = ast?.program.directives as { value?: { value?: string } }[] | undefined;
	const commonJs =
		typeof Bun === "undefined" ||
		directives?.some(directive => directive.value?.value === "use strict") ||
		usesCommonJsBindings(ast);
	const scriptGlobals = !asyncWrapped && commonJs;
	const scopeNames = scriptGlobals ? bindings.lexical : [...bindings.lexical, ...bindings.global];
	const globalNames = scriptGlobals ? bindings.global : [];
	const publish = `__proto_publish_bindings__({${scopeNames.map(name => bindingDescriptor(name, parameter, bindings.readonly.includes(name))).join(",")}}, {${globalNames.map(name => bindingDescriptor(name, parameter, false)).join(",")}}, ${JSON.stringify(bindings.readonly)});`;
	const directiveEnd = body?.program.directives?.at(-1)?.end ?? 0;
	source = `${source.slice(0, directiveEnd)}\n${publish}\n${source.slice(directiveEnd)}`;
	if (typeof Bun !== "undefined") {
		// Match Bun's own source optimizer, including its declaration hoisting. Live accessors
		// keep every selected binding observable, so native DCE cannot discard persistent state.
		nativeBunTranspiler ??= new Bun.Transpiler({
			loader: "js",
			target: "bun",
			treeShaking: true,
			trimUnusedImports: false,
			define: {
				__filename: "__proto_cell_filename__",
				__dirname: "__proto_cell_dirname__",
				require: "__proto_cell_require__",
			},
		});
		source = nativeBunTranspiler.transformSync(source);
	}
	const scopedCalls: Array<{ start: number; end: number; name: string }> = [];
	walkNodes(await parseProgram(source), node => {
		if (node.type === "MetaProperty" && (node.meta as { name?: string } | undefined)?.name === "import")
			scopedCalls.push({ start: node.start, end: node.end, name: "__proto_cell_meta__" });
		const callee = (
			node.type === "CallExpression" || node.type === "OptionalCallExpression"
				? node.callee
				: node.type === "TaggedTemplateExpression"
					? node.tag
					: undefined
		) as BabelNode | undefined;
		if (callee?.type === "Identifier" && callee.name !== "eval" && scopedNames.has(String(callee.name)))
			scopedCalls.push({ start: callee.start, end: callee.end, name: String(callee.name) });
	});
	for (const edit of scopedCalls.sort((a, b) => b.start - a.start))
		source = `${source.slice(0, edit.start)}(0, ${edit.name})${source.slice(edit.end)}`;
	const importRequests = imports.map(node => ({
		source: node.source.value,
		options: node.attributes?.length
			? {
					with: Object.fromEntries(
						node.attributes.map(attr => [
							attr.key.type === "Identifier" ? attr.key.name : attr.key.value,
							attr.value.value,
						]),
					),
				}
			: undefined,
		names: node.specifiers.map(specifier => ({
			local: specifier.local.name,
			imported:
				specifier.type === "ImportNamespaceSpecifier"
					? null
					: specifier.type === "ImportDefaultSpecifier"
						? "default"
						: specifier.imported?.type === "Identifier"
							? specifier.imported.name
							: specifier.imported?.value,
		})),
	}));
	const strict = typeof Bun === "undefined" ? asyncWrapped : !scriptGlobals;
	const cell = `(${asyncWrapped ? "async " : ""}() => {\n${strict ? '"use strict";\n' : ""}${source}\n})()`;
	return {
		source: `(${asyncWrapped ? "async " : ""}() => { with (__proto_scope__) { with (__proto_cell_globals__(${asyncWrapped})) { ${imports.length ? `with (await __proto_import_bindings__(${JSON.stringify(importRequests)})) { return ${cell}; }` : `return ${cell};`} } } })()`,
		asyncWrapped,
		finalExpressionReturned: finalExpression.returned,
	};
}
