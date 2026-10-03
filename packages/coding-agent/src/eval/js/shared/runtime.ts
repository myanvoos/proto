import { AsyncLocalStorage } from "node:async_hooks";
import { Console } from "node:console";
import * as fs from "node:fs";
import { createRequire, Module } from "node:module";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import * as util from "node:util";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { KernelTarget } from "../../kernel-target";
import type { KernelInvocation } from "../../types";

import {
	beginFileTracking,
	flushFileTracking,
	installBunWriteTracking,
	maybeTrackedModule,
	trackedFsModule,
} from "./fs-tracker";
import { createHelpers, type HelperBundle } from "./helpers";
import { awaitMaybePromise, indirectEval } from "./indirect-eval";
import { LocalModuleLoader } from "./local-module-loader";
import { NativeStdio } from "./native-stdio";
import { JAVASCRIPT_PRELUDE_SOURCE } from "./prelude";
import { wrapCode } from "./rewrite-imports";
import { type LoadStateOptions, loadKernelState, runtimeInterpreter, type StateResult, saveKernelState } from "./state";
import type { JsDisplayOutput, JsStatusEvent } from "./types";

export interface RuntimeHooks {
	onText(chunk: string, stream?: "stdout" | "stderr"): void;
	onBytes?(chunk: Uint8Array, stream: "stdout" | "stderr"): Promise<void> | void;
	outputBackpressured?(): boolean;
	onDisplay(output: JsDisplayOutput): void;
	callTool(name: string, args: unknown, completionInvocationId?: string): Promise<unknown>;
}

function surfaceBridgedToolImages(value: unknown, hooks: RuntimeHooks): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const { images, ...rest } = value as { images?: unknown } & Record<string, unknown>;
	if (!Array.isArray(images) || images.length === 0) return value;
	let displayed = 0;
	for (const image of images) {
		if (!image || typeof image !== "object") continue;
		const { data, mimeType } = image as { data?: unknown; mimeType?: unknown };
		if (typeof data !== "string" || typeof mimeType !== "string") continue;
		hooks.onDisplay({ type: "image", data, mimeType });
		displayed++;
	}
	if (displayed === 0) return value;
	// Production bridges publish immutable refs; displaying must not destroy machine-usable content.
	return { ...rest, images: Array.isArray(rest.artifacts) ? rest.artifacts : images };
}

export interface RunContext {
	runId: string;
	hooks: RuntimeHooks;
	cwd: string;
	finalExpressionSet: boolean;
	finalExpressionValue: unknown;
	completionInvocationCount: number;
	invocation?: KernelInvocation;
	execPath: string;
}

export interface RuntimeOptions {
	initialCwd: string;
	generation?: string;
	target?: KernelTarget;
	sessionId: string;

	extraGlobals?: Record<string, unknown>;

	/** Dedicated-process runtimes only: patches Bun.write for mutation tracking. */
	trackFileWrites?: boolean;
	nativeStdio?: boolean;
}

const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DECIMAL_CSV_RE = /^\d{1,3}(?:,\d{1,3})*$/;

const PRELUDE_GLOBAL_KEYS = [
	"BatchError",
	"executions",
	"saveState",
	"loadState",
	"startTool",
	"toolEvents",
	"cancelTool",
	"disposeTool",
	"delegate",
	"delegations",
	"revokeDelegation",
	"launchDelegated",
	"publishArtifact",
	"readArtifact",
	"resolveArtifact",
	"__proto_js_prelude_loaded__",
	"console",
	"print",
	"display",
	"tool",
	"completion",
	"output",
	"agent",
	"parallel",
	"pipeline",
	"log",
	"phase",
	"budget",
	"__pool",
	"env",
	"symbols",
	"blockRange",
];

function isStrictBase64(s: string): boolean {
	if (s.length === 0 || s.length % 4 !== 0) return false;
	return BASE64_STRICT_RE.test(s);
}

function coerceImageBase64(data: unknown): string | null {
	if (typeof data === "string") {
		if (isStrictBase64(data)) return data;
		if (DECIMAL_CSV_RE.test(data)) {
			const parts = data.split(",");
			const bytes = new Uint8Array(parts.length);
			for (let i = 0; i < parts.length; i++) {
				const n = Number(parts[i]);
				if (!Number.isInteger(n) || n < 0 || n > 255) return null;
				bytes[i] = n;
			}
			return Buffer.from(bytes).toString("base64");
		}
		return null;
	}
	if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
	}
	if (data && typeof data === "object") {
		const obj = data as { type?: unknown; data?: unknown };
		if (obj.type === "Buffer" && Array.isArray(obj.data)) {
			const arr = obj.data as unknown[];
			const bytes = new Uint8Array(arr.length);
			for (let i = 0; i < arr.length; i++) {
				const n = arr[i];
				if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) return null;
				bytes[i] = n;
			}
			return Buffer.from(bytes).toString("base64");
		}
	}
	return null;
}

function describeDataType(data: unknown): string {
	if (data === null) return "null";
	if (data instanceof Uint8Array) return "Uint8Array";
	if (data instanceof ArrayBuffer) return "ArrayBuffer";
	if (ArrayBuffer.isView(data)) return data.constructor.name;
	if (typeof data === "string") return `string(${data.length})`;
	return typeof data;
}

export class JsRuntime {
	#globalOwner = Symbol("JsRuntime globals");
	#ownedGlobalKeys = new Set<string>();
	#disposed = false;
	#runContextResolver = () => this.#als.getStore();

	#ownGlobal(key: string, mutable = false): void {
		if (this.#ownedGlobalKeys.has(key)) return;
		claimGlobalKey(key, this.#globalOwner, mutable);
		this.#ownedGlobalKeys.add(key);
	}

	#activateGlobals(action: string): void {
		if (this.#disposed) throw new Error(`Cannot ${action} on a disposed JS runtime`);
		activateGlobalOwner(this.#globalOwner, this.#ownedGlobalKeys, action);
	}

	readonly helpers: HelperBundle;
	#cwd: string;
	#session: { cwd: string; sessionId: string };
	readonly sessionId: string;
	readonly #generation: string;
	readonly #target: KernelTarget;
	#executionCount = 0;
	#definitions = new Map<string, number>();
	#tasks = new Map<string, { id: string; kind: "cell" | "tool"; state: "running"; cell: number }>();
	#baseline = new Set<string>();
	#env: Map<string, string>;
	#als = new AsyncLocalStorage<RunContext>();
	#moduleLoader: LocalModuleLoader;
	#scope: Record<string, unknown> = Object.create(null);
	#bindingGetters = new Set<() => unknown>();
	#readonlyGetters = new Set<() => unknown>();
	#nativeStdio?: NativeStdio;
	cellExitCode: number | undefined;

	constructor(opts: RuntimeOptions) {
		this.#generation = opts.generation ?? crypto.randomUUID();
		this.#target = structuredClone(opts.target ?? { kind: "local" });
		this.#cwd = opts.initialCwd;
		this.#session = { cwd: opts.initialCwd, sessionId: opts.sessionId };
		this.sessionId = opts.sessionId;
		this.#env = new Map();
		this.#moduleLoader = new LocalModuleLoader(this.sessionId);
		this.helpers = createHelpers({
			cwd: () => this.#activeCwd(),
			env: this.#env,
			emitStatus: event => this.#activeHooks("emitStatus")?.onDisplay({ type: "status", event }),
		});
		if (opts.trackFileWrites) installBunWriteTracking();
		if (opts.nativeStdio) this.#nativeStdio = new NativeStdio(() => this.currentRunId());
		this.#install(opts.extraGlobals);
		this.#baseline = new Set(Object.getOwnPropertyNames(globalThis));
	}

	get nativeSequence(): number | undefined {
		return this.#nativeStdio?.sequence;
	}

	get cwd(): string {
		return this.#cwd;
	}

	/** Id of the run whose cell code — or work that cell left pending — is executing now. */
	currentRunId(): string | undefined {
		return this.#als.getStore()?.runId;
	}

	setCwd(cwd: string): void {
		if (this.#disposed) throw new Error("Cannot set cwd on a disposed JS runtime");

		this.#cwd = cwd;
		this.#session.cwd = cwd;
		if (activeGlobalRunOwner === null || activeGlobalRunOwner === this.#globalOwner) {
			this.#activateGlobals("set cwd");
		}
	}

	setRunScope(scope: Record<string, unknown>): void {
		this.#activateGlobals("set run scope");
		Object.assign(globalThis, scope);
	}

	async run(
		code: string,
		filename: string | undefined,
		hooks: RuntimeHooks,
		options: {
			runId?: string;
			cwd?: string;
			shellEnv?: Record<string, string>;
			invocation?: KernelInvocation;
			drain?: () => Promise<void>;
			stdin?: Readable;
			stdinSocket?: string;
			/** Rejecting it ends the run at once with its reason; work the cell left pending runs on detached. */
			stop?: Promise<never>;
		} = {},
	): Promise<unknown> {
		this.#activateGlobals("run code");
		const leaveRun = enterGlobalRun(this.#globalOwner, "run code");
		const cell = ++this.#executionCount;
		const before = Object.getOwnPropertyDescriptors(globalThis);
		hooks.onDisplay({
			type: "status",
			event: {
				op: "kernel-state",
				generation: this.#generation,
				language: "javascript",
				executionCount: this.#executionCount,
			},
		});
		const shellEnv = options.shellEnv ?? {};
		const savedEnv = new Map(Object.keys(shellEnv).map(key => [key, process.env[key]]));
		const savedHelpers = new Map(Object.keys(shellEnv).map(key => [key, this.#env.get(key)]));
		for (const [key, value] of Object.entries(shellEnv)) {
			process.env[key] = value;
			this.#env.set(key, value);
		}
		const savedExitCode = process.exitCode;
		process.exitCode = typeof Bun === "undefined" ? undefined : 0;
		this.cellExitCode = undefined;
		const savedArgv = process.argv;
		process.argv = options.invocation?.argv.slice() ?? [process.execPath];
		const savedStdin = Object.getOwnPropertyDescriptor(process, "stdin");
		const stdin = options.stdin ?? Readable.from([]);
		Object.defineProperty(process, "stdin", { configurable: true, get: () => this.#nativeStdio?.stdin ?? stdin });
		const context: RunContext = {
			runId: options.runId ?? crypto.randomUUID(),
			hooks,
			cwd: options.cwd ?? this.#cwd,
			finalExpressionSet: false,
			finalExpressionValue: undefined,
			completionInvocationCount: 0,
			invocation: options.invocation,
			execPath: options.invocation?.argv[0] ?? process.execPath,
		};
		this.#tasks.set(context.runId, { id: context.runId, kind: "cell", state: "running", cell });
		beginFileTracking(context.runId, event => hooks.onDisplay({ type: "status", event }), {
			note: text => hooks.onDisplay({ type: "status", event: { op: "note", text } }),
			cwd: context.cwd,
		});
		try {
			this.#nativeStdio?.startInput(context.runId, options.stdinSocket);
			const evaluation = this.#als.run(context, async () => {
				const wrapped = await wrapCode(code, Object.keys(this.#scope));
				this.#nativeStdio?.start(context.runId);
				const value = indirectEval(wrapped.source, filename);
				await awaitMaybePromise(value);
				await options.drain?.();

				if (wrapped.finalExpressionReturned) {
					const awaited = await awaitMaybePromise(value);
					if (context.finalExpressionSet) {
						const finalValue = context.finalExpressionValue;
						context.finalExpressionSet = false;
						context.finalExpressionValue = undefined;
						// A bare promise is a value, not an implicit top-level await. Unresolved promises
						// alone do not keep a native Node/Bun command alive.
						if (util.types.isPromise(finalValue)) {
							hooks.onDisplay({
								type: "text",
								text: `${util.inspect(finalValue, { customInspect: false, getters: false })}\n`,
							});
							return undefined;
						}
						return finalValue;
					}
					return awaited;
				}
				return await awaitMaybePromise(value);
			});
			return await (options.stop ? Promise.race([evaluation, options.stop]) : evaluation);
		} finally {
			this.#nativeStdio?.finish();
			for (const name of this.#definitions.keys()) {
				if (!Object.hasOwn(globalThis, name) && !Object.hasOwn(this.#scope, name)) this.#definitions.delete(name);
			}
			for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(globalThis))) {
				if (name.startsWith("__proto_")) continue;
				const previous = before[name];
				if (
					!previous ||
					!Object.is(previous.value, descriptor.value) ||
					previous.get !== descriptor.get ||
					previous.set !== descriptor.set
				)
					this.#definitions.set(name, cell);
			}
			for (const key of this.#ownedGlobalKeys) recordGlobalValue(key, this.#globalOwner);
			await flushFileTracking();
			this.cellExitCode = process.exitCode === undefined ? undefined : Number(process.exitCode) & 0xff;
			process.exitCode = savedExitCode ?? (typeof Bun === "undefined" ? undefined : 0);
			process.argv = savedArgv;
			stdin.destroy();
			this.#nativeStdio?.finishInput();
			if (savedStdin) Object.defineProperty(process, "stdin", savedStdin);
			for (const [key, value] of savedEnv) {
				if (process.env[key] === shellEnv[key]) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				if (this.#env.get(key) === shellEnv[key]) {
					const previous = savedHelpers.get(key);
					if (previous === undefined) this.#env.delete(key);
					else this.#env.set(key, previous);
				}
			}
			this.#tasks.delete(context.runId);
			leaveRun();
		}
	}

	displayValue(value: unknown, hooks: RuntimeHooks | undefined = this.#als.getStore()?.hooks): void {
		if (value === undefined) return;
		if (!hooks) {
			logger.warn("js runtime display called outside an active run");
			return;
		}
		if (value && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (record.type === "image" && typeof record.mimeType === "string") {
				const data = coerceImageBase64(record.data);
				if (data !== null) {
					hooks.onDisplay({ type: "image", data, mimeType: record.mimeType });
					return;
				}
				logger.warn("js displayValue: dropping image with unrecognized data shape", {
					mimeType: record.mimeType,
					dataType: describeDataType(record.data),
				});
				hooks.onDisplay({
					type: "notice",
					text: `[display: image dropped — \`data\` must be a base64 string, Uint8Array/Buffer, or ArrayBuffer; got ${describeDataType(record.data)}]\n`,
				});
				return;
			}
			try {
				hooks.onDisplay({ type: "json", data: structuredClone(value) });
			} catch (err) {
				logger.debug("js displayValue: value is not structured-cloneable, falling back to text", {
					error: err instanceof Error ? err.message : String(err),
				});
				hooks.onDisplay({ type: "text", text: `${Object.prototype.toString.call(value)}\n` });
			}
			return;
		}
		hooks.onDisplay({ type: "text", text: `${String(value)}\n` });
	}

	#activeCwd(): string {
		return this.#als.getStore()?.cwd ?? this.#cwd;
	}

	#activeHooks(action: string): RuntimeHooks | undefined {
		const hooks = this.#als.getStore()?.hooks;
		if (!hooks) {
			logger.warn("js runtime helper called outside an active run", { action });
		}
		return hooks;
	}

	#activeRequire(moduleUrlOrPath?: string): NodeJS.Require {
		const requireFn = this.#moduleLoader.requireForFile(moduleUrlOrPath, this.#activeCwd());
		const wrappedRequire = ((id: string) => maybeTrackedModule(id, requireFn(id))) as NodeJS.Require;
		return new Proxy(wrappedRequire, {
			get(_target, prop) {
				const value = Reflect.get(requireFn, prop, requireFn);
				return typeof value === "function" ? (value as () => unknown).bind(requireFn) : value;
			},
		});
	}

	#moduleFilename(moduleUrlOrPath?: string): string {
		return this.#moduleLoader.filenameForUrl(moduleUrlOrPath) ?? path.join(this.#activeCwd(), "[eval]");
	}

	#moduleDirname(moduleUrlOrPath?: string): string {
		return this.#moduleLoader.dirnameForUrl(moduleUrlOrPath, this.#activeCwd());
	}

	#buildDynamicRequire(): NodeJS.Require {
		const dynamicRequire = ((id: string) => this.#activeRequire()(id)) as NodeJS.Require;
		const resolve = ((id: string, options?: { paths?: string[] }) =>
			this.#activeRequire().resolve(id, options)) as NodeJS.Require["resolve"] & {
			paths(request: string): string[] | null;
		};
		resolve.paths = request => this.#activeRequire().resolve.paths(request);
		Object.defineProperties(dynamicRequire, {
			resolve: { value: resolve, configurable: true },
			cache: { get: () => this.#activeRequire().cache, configurable: true },
			extensions: { get: () => this.#activeRequire().extensions, configurable: true },
			main: { get: () => this.#activeRequire().main, configurable: true },
		});
		return dynamicRequire;
	}

	#stateNamespace(): Record<string, unknown> {
		const namespace = Object.create(null);
		const descriptors = {
			...Object.getOwnPropertyDescriptors(globalThis),
			...Object.getOwnPropertyDescriptors(this.#scope),
		};
		for (const [name, descriptor] of Object.entries(descriptors)) {
			if (descriptor.get && this.#bindingGetters.has(descriptor.get)) {
				try {
					descriptors[name] = {
						value: descriptor.get(),
						enumerable: true,
						configurable: true,
						writable: !this.#readonlyGetters.has(descriptor.get),
					};
				} catch {
					// A declaration not yet initialized retains its TDZ, rather than becoming undefined.
				}
			}
		}
		Object.defineProperties(namespace, descriptors);
		return namespace;
	}

	async saveState(snapshotPath: string, names: unknown): Promise<StateResult> {
		this.#activateGlobals("save state");
		return await saveKernelState(
			this.helpers.resolvePath(snapshotPath),
			names,
			this.#stateNamespace(),
			this.#baseline,
		);
	}

	async loadState(snapshotPath: string, options: LoadStateOptions = {}): Promise<StateResult> {
		this.#activateGlobals("load state");
		const namespace = this.#stateNamespace();
		const result = await loadKernelState(
			this.helpers.resolvePath(snapshotPath),
			namespace,
			this.#baseline,
			options,
			names => {
				assertCanUseGlobalOwner(this.#globalOwner, "restore state");
				for (const name of names) this.#ownGlobal(name, true);
			},
		);
		for (const name of result.names) {
			const target = Object.hasOwn(this.#scope, name) ? this.#scope : globalThis;
			const current = Object.getOwnPropertyDescriptor(target, name);
			const restored = Object.getOwnPropertyDescriptor(namespace, name)!;
			if (current?.get && this.#bindingGetters.has(current.get)) current.set!(restored.value);
			else Object.defineProperty(target, name, restored);
			this.#definitions.set(name, this.#executionCount);
			recordGlobalValue(name, this.#globalOwner);
		}
		return result;
	}

	kernelState(options: { limit?: number } = {}): Record<string, unknown> {
		const limit = options.limit ?? 200;
		if (!Number.isInteger(limit) || limit < 0 || limit > 1000)
			throw new RangeError("kernelState limit must be an integer from 0 to 1000");
		const variables = [];
		let totalVariables = 0;
		for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(this.#stateNamespace())).sort(
			([a], [b]) => a.localeCompare(b),
		)) {
			if (name.startsWith("__proto_") || (this.#baseline.has(name) && !this.#definitions.has(name))) continue;
			totalVariables++;
			if (variables.length >= limit) continue;
			// Descriptors and typeof never evaluate user getters, proxy traps or inspection hooks.
			const value: unknown = descriptor.value;
			const type = !("value" in descriptor) ? "accessor" : value === null ? "null" : typeof value;
			let preview: string;
			if (typeof value === "string") preview = JSON.stringify(value.slice(0, 160)).slice(0, 200);
			else if (value === null || ["number", "boolean", "undefined"].includes(type)) preview = String(value);
			else preview = `<${type}>`;
			variables.push({
				name: name.slice(0, 200),
				nameTruncated: name.length > 200,
				type,
				preview,
				cell: this.#definitions.get(name) ?? this.#executionCount,
				provenance: "cell",
			});
		}
		const { implementation, version } = runtimeInterpreter();
		return {
			target: structuredClone(this.#target),
			generation: this.#generation,
			language: "javascript",
			runtime: { implementation, version },
			interpreter: process.execPath,
			cwd: this.#activeCwd(),
			executionCount: this.#executionCount,
			active: [...this.#tasks.values()].filter(task => task.kind === "cell").length,
			queued: null,
			variables,
			totalVariables,
			tasks: [...this.#tasks.values()].slice(0, limit),
			totalTasks: this.#tasks.size,
			taskScope: "kernel cells and tool calls",
		};
	}

	#install(extraGlobals: Record<string, unknown> | undefined): void {
		assertCanUseGlobalOwner(this.#globalOwner, "initialize a JS runtime");
		const injected: Record<string, unknown> = {
			__proto_scope__: this.#scope,
			__proto_cell_globals__: (moduleMode: boolean) => {
				const cwd = this.#activeCwd();
				const invocation = this.#als.getStore()?.invocation;
				const filename = invocation?.filename ?? (typeof Bun === "undefined" ? "[eval]" : path.join(cwd, "[eval]"));
				const module = new Module(typeof Bun === "undefined" && !invocation?.filename ? "[eval]" : filename);
				module.filename = path.resolve(cwd, filename);
				module.paths = createRequire(module.filename).resolve.paths("__proto_cell__") ?? [];
				const require = this.#activeRequire();
				module.require = require;
				const metadataPath = invocation?.filename
					? path.resolve(cwd, invocation.filename)
					: path.join(cwd, typeof Bun === "undefined" ? "[eval1]" : "[eval]");
				const meta = {
					url: pathToFileURL(metadataPath).href,
					filename: metadataPath,
					dirname: path.dirname(metadataPath),
					...(typeof Bun === "undefined"
						? {}
						: {
								require: module.require,
								path: metadataPath,
								dir: path.dirname(metadataPath),
								file: path.basename(metadataPath),
								main: true,
							}),
					resolve: (specifier: string) => {
						const resolved = require.resolve(specifier);
						return path.isAbsolute(resolved) ? pathToFileURL(resolved).href : resolved;
					},
				};
				return {
					module,
					exports: module.exports,
					__filename: filename,
					__dirname: path.dirname(filename),
					__proto_cell_filename__: filename,
					__proto_cell_dirname__: path.dirname(filename),
					__proto_cell_require__: module.require,
					__proto_cell_meta__: meta,
					__proto_cell_this__: moduleMode ? undefined : globalThis,
				};
			},
			__proto_publish_bindings__: (
				lexicals: PropertyDescriptorMap,
				globals: PropertyDescriptorMap,
				readonly: string[],
			) => {
				for (const [target, bindings] of [
					[this.#scope, lexicals],
					[globalThis, globals],
				] as const) {
					for (const [name, descriptor] of Object.entries(bindings)) {
						if (target === globalThis) this.#ownGlobal(name, true);
						if (descriptor.get) this.#bindingGetters.add(descriptor.get);
						if (descriptor.get && readonly.includes(name)) this.#readonlyGetters.add(descriptor.get);
						Object.defineProperty(target, name, { ...descriptor, configurable: true, enumerable: true });
						this.#definitions.set(name, this.#executionCount);
					}
				}
			},
			__proto_import_bindings__: async (
				requests: {
					source: string;
					options?: ImportCallOptions;
					names: { local: string; imported: string | null }[];
				}[],
			) => {
				const scope = Object.create(null);
				for (const request of requests) {
					const namespace = (await this.#moduleLoader.importForRun(
						this.#activeCwd(),
						request.source,
						request.options,
					)) as Record<string, unknown>;
					for (const { local, imported } of request.names) {
						if (imported !== null && !Object.hasOwn(namespace, imported))
							throw new SyntaxError(
								`The requested module '${request.source}' does not provide an export named '${imported}'`,
							);
						const descriptor = {
							get: () => (imported === null ? namespace : namespace[imported]),
							set: () => {
								throw new TypeError("Assignment to constant variable.");
							},
							configurable: true,
							enumerable: true,
						};
						this.#bindingGetters.add(descriptor.get);
						this.#readonlyGetters.add(descriptor.get);
						Object.defineProperty(scope, local, descriptor);
						Object.defineProperty(this.#scope, local, descriptor);
						this.#definitions.set(local, this.#executionCount);
					}
				}
				return scope;
			},
			retainTask: <T extends { unref(): unknown }>(resource: T): T => {
				if (!resource || typeof resource.unref !== "function")
					throw new TypeError(
						"retainTask expects a resource with unref(); unresolved promises already do not keep the event loop alive",
					);
				resource.unref();
				return resource;
			},
			__proto_native_console__: this.#nativeStdio?.console,
			__proto_native_stdio_write__: this.#nativeStdio?.write.bind(this.#nativeStdio),
			__proto_session__: this.#session,
			__proto_helpers__: this.helpers,
			kernelState: (options?: { limit?: number }) => this.kernelState(options),
			saveState: (snapshotPath: string, names: unknown) => this.saveState(snapshotPath, names),
			loadState: (snapshotPath: string, options?: LoadStateOptions) => this.loadState(snapshotPath, options),
			defs: () =>
				Object.fromEntries(
					[...this.#definitions].filter(
						([name]) => Object.hasOwn(globalThis, name) || Object.hasOwn(this.#scope, name),
					),
				),
			__proto_call_tool__: async (name: string, args: unknown, completionInvocationId?: string) => {
				const hooks = this.#activeHooks("tool");
				if (!hooks) return undefined;
				const id = crypto.randomUUID();
				this.#tasks.set(id, { id, kind: "tool", state: "running", cell: this.#executionCount });
				try {
					return surfaceBridgedToolImages(await hooks.callTool(name, args, completionInvocationId), hooks);
				} finally {
					this.#tasks.delete(id);
				}
			},
			__proto_next_completion_invocation__: () => {
				const context = this.#als.getStore();
				if (!context) return undefined;
				return String(context.completionInvocationCount++);
			},
			__proto_import__: (source: string, options?: ImportCallOptions) =>
				this.#moduleLoader.importForRun(this.#activeCwd(), source, options),
			__proto_import_from__: (moduleUrl: string, source: string, options?: ImportCallOptions) =>
				this.#moduleLoader.importForModule(moduleUrl, source, this.#activeCwd(), options),
			__proto_get_require__: (moduleUrl?: string) => this.#activeRequire(moduleUrl),
			__proto_get_filename__: (moduleUrl?: string) => this.#moduleFilename(moduleUrl),
			__proto_get_dirname__: (moduleUrl?: string) => this.#moduleDirname(moduleUrl),
			__proto_emit_status__: (op: string, data: Record<string, unknown> = {}) => {
				const event: JsStatusEvent = { op, ...data };
				this.#activeHooks("emitStatus")?.onDisplay({ type: "status", event });
			},
			__proto_log__: (level: string, ...args: unknown[]) => {
				const text = util.format(...args);
				this.#activeHooks("log")?.onText(
					text.endsWith("\n") ? text : `${text}\n`,
					level === "error" || level === "warn" ? "stderr" : "stdout",
				);
			},
			__proto_table__: (...args: unknown[]) => {
				const hooks = this.#activeHooks("table");
				if (!hooks) return;
				let buffer = "";
				const stream = new Writable({
					write(chunk, _enc, cb) {
						buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
						cb();
					},
				});
				const tableConsole = new Console({ stdout: stream, colorMode: false });
				const tableCapable = tableConsole as unknown as { table: (...args: unknown[]) => void };
				tableCapable.table(...args);
				hooks.onText(buffer.endsWith("\n") ? buffer : `${buffer}\n`);
			},
			__proto_display__: (value: unknown) => this.displayValue(value),
			__proto_read_text__: (filePath: string) => fs.promises.readFile(filePath, "utf8"),
			__proto_set_final_expr__: (value: unknown) => {
				const context = this.#als.getStore();
				if (!context) {
					logger.warn("js runtime final expression set outside an active run");
					return;
				}
				context.finalExpressionSet = true;
				context.finalExpressionValue = value;
			},
			webcrypto: crypto,

			require: this.#buildDynamicRequire(),
			createRequire,
			fs: trackedFsModule(fs),
		};

		const allGlobalKeys = new Set<string>([
			...Object.keys(injected),
			...Object.keys(extraGlobals ?? {}),
			...PRELUDE_GLOBAL_KEYS,
		]);

		for (const key of allGlobalKeys) {
			this.#ownGlobal(key);
		}

		Object.assign(globalThis, injected, extraGlobals ?? {});

		indirectEval(JAVASCRIPT_PRELUDE_SOURCE);
		for (const key of allGlobalKeys) recordGlobalValue(key, this.#globalOwner);
		RUN_CONTEXT_RESOLVERS.add(this.#runContextResolver);
		installProcessIdentity();
		patchStdioOnce();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#nativeStdio?.dispose();
		RUN_CONTEXT_RESOLVERS.delete(this.#runContextResolver);
		if (RUN_CONTEXT_RESOLVERS.size === 0 && processIdentity) {
			if (Object.getOwnPropertyDescriptor(process, "execPath")?.get === processIdentity.get)
				Object.defineProperty(process, "execPath", {
					...processIdentity.descriptor,
					value: processIdentity.launcher,
				});
			processIdentity = undefined;
		}
		for (const key of this.#ownedGlobalKeys) releaseGlobalKey(key, this.#globalOwner);
		this.#ownedGlobalKeys.clear();
	}
}

interface GlobalSnapshot {
	descriptor: PropertyDescriptor | undefined;
}

interface GlobalOwnerEntry {
	owner: symbol;
	state: GlobalSnapshot;
	mutable: boolean;
}

interface GlobalStack {
	base: GlobalSnapshot;
	entries: GlobalOwnerEntry[];
}

const GLOBAL_STACKS = new Map<string, GlobalStack>();

function snapshotGlobal(key: string): GlobalSnapshot {
	return { descriptor: Object.getOwnPropertyDescriptor(globalThis, key) };
}

function restoreGlobal(key: string, state: GlobalSnapshot): void {
	if (state.descriptor) Object.defineProperty(globalThis, key, state.descriptor);
	else delete (globalThis as Record<string, unknown>)[key];
}

function claimGlobalKey(key: string, owner: symbol, mutable = false): void {
	let stack = GLOBAL_STACKS.get(key);
	if (!stack) {
		stack = { base: snapshotGlobal(key), entries: [] };
		GLOBAL_STACKS.set(key, stack);
	}
	const previous = stack.entries.at(-1);
	if (previous?.mutable) previous.state = snapshotGlobal(key);
	stack.entries.push({ owner, state: snapshotGlobal(key), mutable });
}

function recordGlobalValue(key: string, owner: symbol): void {
	const stack = GLOBAL_STACKS.get(key);
	const entry = stack?.entries.findLast(item => item.owner === owner);
	if (entry) entry.state = snapshotGlobal(key);
}

function releaseGlobalKey(key: string, owner: symbol): void {
	const stack = GLOBAL_STACKS.get(key);
	if (!stack) return;
	const index = stack.entries.findIndex(entry => entry.owner === owner);
	if (index === -1) return;
	const wasTop = index === stack.entries.length - 1;
	stack.entries.splice(index, 1);
	if (!wasTop) return;
	const next = stack.entries.at(-1);
	if (next) {
		restoreGlobal(key, next.state);
		return;
	}
	restoreGlobal(key, stack.base);
	GLOBAL_STACKS.delete(key);
}

let activeGlobalRunOwner: symbol | null = null;
let activeGlobalRunDepth = 0;

function assertCanUseGlobalOwner(owner: symbol, action: string): void {
	if (activeGlobalRunOwner === null || activeGlobalRunOwner === owner) return;
	throw new Error(`Cannot ${action} while another same-realm JS runtime is running`);
}

function activateGlobalOwner(owner: symbol, keys: Iterable<string>, action: string): void {
	assertCanUseGlobalOwner(owner, action);
	for (const key of keys) {
		const stack = GLOBAL_STACKS.get(key);
		const index = stack?.entries.findIndex(entry => entry.owner === owner) ?? -1;
		if (!stack || index === -1) throw new Error(`Cannot ${action} on a disposed JS runtime`);
		const entry = stack.entries[index];
		// Restored user bindings may be reassigned or deleted between helper calls.
		if (entry.mutable && index === stack.entries.length - 1) continue;
		const previous = stack.entries.at(-1);
		if (previous?.mutable) previous.state = snapshotGlobal(key);
		stack.entries.splice(index, 1);
		stack.entries.push(entry);
		restoreGlobal(key, entry.state);
	}
}

function enterGlobalRun(owner: symbol, action: string): () => void {
	assertCanUseGlobalOwner(owner, action);
	activeGlobalRunOwner = owner;
	activeGlobalRunDepth++;
	let left = false;
	return () => {
		if (left) return;
		left = true;
		activeGlobalRunDepth--;
		if (activeGlobalRunDepth === 0) activeGlobalRunOwner = null;
	};
}

const RUN_CONTEXT_RESOLVERS = new Set<() => RunContext | undefined>();
let processIdentity: { descriptor: PropertyDescriptor; launcher: string; get: () => string } | undefined;

/** A cell sees its selected interpreter; the worker's launcher identity remains private to host code. */
function installProcessIdentity(): void {
	if (processIdentity) return;
	const descriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
	const identity = {
		descriptor,
		launcher: process.execPath,
		get: (): string => {
			for (const resolve of RUN_CONTEXT_RESOLVERS) {
				const context = resolve();
				if (context) return context.execPath;
			}
			return identity.launcher;
		},
	};
	processIdentity = identity;
	Object.defineProperty(process, "execPath", {
		configurable: descriptor.configurable,
		enumerable: descriptor.enumerable,
		get: identity.get,
		set: (value: string) => {
			for (const resolve of RUN_CONTEXT_RESOLVERS) {
				const context = resolve();
				if (context) {
					context.execPath = value;
					return;
				}
			}
			identity.launcher = value;
		},
	});
}

const PATCHED_STDIO_STREAMS = new WeakSet<NodeJS.WriteStream>();

function activeRunHooks(): RuntimeHooks | undefined {
	for (const resolve of RUN_CONTEXT_RESOLVERS) {
		const context = resolve();
		if (context) return context.hooks;
	}
	return undefined;
}

function patchStdioOnce(): void {
	const streams: NodeJS.WriteStream[] = [process.stdout, process.stderr];
	for (const stream of streams) {
		if (!stream || PATCHED_STDIO_STREAMS.has(stream)) continue;
		PATCHED_STDIO_STREAMS.add(stream);
		const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
		const routed = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
			const hooks = activeRunHooks();
			const nativeWrite = (globalThis as { __proto_native_stdio_write__?: NativeStdio["write"] })
				.__proto_native_stdio_write__;
			if (nativeWrite)
				return nativeWrite(
					stream === process.stderr ? "stderr" : "stdout",
					() => original(chunk, encoding, callback),
					chunk,
					encoding,
					callback,
				);
			if (!hooks) return original(chunk, encoding, callback);
			const cb = typeof encoding === "function" ? encoding : callback;
			const enc = typeof encoding === "string" ? (encoding as BufferEncoding) : undefined;
			const kind = stream === process.stderr ? "stderr" : "stdout";
			if (hooks.onBytes) {
				const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk), enc);
				const write = hooks.onBytes(bytes, kind);
				if (write) {
					const backpressured = hooks.outputBackpressured?.() ?? true;
					void write.then(
						() => {
							if (typeof cb === "function") (cb as () => void)();
							if (backpressured) stream.emit("drain");
						},
						error => {
							if (typeof cb === "function") (cb as (error: Error) => void)(error);
						},
					);
					return !backpressured;
				}
			} else hooks.onText(chunkToString(chunk, enc), kind);
			if (typeof cb === "function") (cb as (error?: Error | null) => void)();
			return true;
		};
		stream.write = routed as unknown as typeof stream.write;
	}
}

function chunkToString(chunk: unknown, encoding?: BufferEncoding): string {
	if (typeof chunk === "string") return chunk;
	if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding ?? "utf8");
	return String(chunk);
}
