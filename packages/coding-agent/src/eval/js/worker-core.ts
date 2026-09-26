// node:timers rather than Bun.sleep: the Node kernel runtime (node-entry.ts) runs this core too.
import { setTimeout as sleep } from "node:timers/promises";
import { ToolError } from "../../tools/tool-errors";
import type { EvalCompletionInvocationContext } from "../completion-bridge";
import { PythonDisplayBudget } from "../py/display";
import { JsRuntime, type RuntimeHooks } from "./shared/runtime";
import type {
	RunErrorPayload,
	SessionSnapshot,
	ToolReply,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "./worker-protocol";
import { WorkerInput, WorkerOutput } from "./worker-streams";

interface PendingTool {
	runId: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface ActiveRun {
	input: WorkerInput;
	runId: string;
	filename: string;
	completionContext?: EvalCompletionInvocationContext;
	pendingTools: Map<string, PendingTool>;

	floatingRejections: unknown[];
	/** Rejected with the cell's CellExit when its code calls `process.exit()`. */
	exit: PromiseWithResolvers<never>;
}

type RunMessage = Extract<WorkerInbound, { type: "run" }>;
type RunResult = Extract<WorkerOutbound, { type: "result" }>;

export type RejectionInterceptor = (handler: (reason: unknown) => boolean) => () => void;

interface WorkerCoreOptions {
	mode: "isolated";

	chdir?: (cwd: string) => void;

	interceptUnhandledRejections?: RejectionInterceptor;

	/**
	 * Hosts whose uncaught exceptions postmortem handles (the Bun CLI host) pass its non-fatal marker for cell-exit
	 * throws; other hosts get the core's own listener, which ignores those throws and keeps the rest fatal.
	 */
	markNonFatal?: <T extends object>(error: T) => T;
}

const RECENT_CELL_FILES_MAX = 256;

/**
 * `process.exit()` in cell code throws this to unwind the caller: the cell ends at the call with `status`, while the
 * kernel and its state live on. Work the cell left pending (timers, listeners, unawaited promises) keeps running like
 * any finished cell's; an exit from such work after its cell ended only unwinds that callback.
 */
class CellExit extends Error {
	constructor(readonly status: number) {
		super(`process.exit(${status})`);
		this.name = "CellExit";
	}
}

/** The status `process.exit(code)` gives a process (default `process.exitCode`, else 0): an integer, low byte kept. */
function exitStatus(code: unknown): number {
	const value = code ?? process.exitCode ?? 0;
	const status = typeof value === "string" && value !== "" ? Number(value) : value;
	if (typeof status !== "number" || !Number.isSafeInteger(status))
		throw new TypeError(`process.exit() code must be an integer, got ${String(value)}`);
	return status & 0xff;
}

function errorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error.name === "ToolError" || error instanceof ToolError,
		};
	}
	return { message: String(error) };
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function foldFloatingRejections(active: ActiveRun, result: RunResult, hooks: RuntimeHooks): RunResult {
	const rejections = active.floatingRejections;
	if (rejections.length === 0) return result;
	let folded = result;
	let reported = rejections;
	// An explicit process.exit() status stands; the rejections are only reported.
	if (result.ok && result.exitCode === undefined) {
		const error = errorPayload(rejections[0]);
		error.message = `Unhandled rejection (missing await?): ${error.message}`;
		folded = { type: "result", runId: active.runId, ok: false, error };
		reported = rejections.slice(1);
	}
	for (const reason of reported) {
		const payload = errorPayload(reason);
		hooks.onText(`[unhandled rejection] ${payload.name ?? "Error"}: ${payload.message}\n`);
	}
	return folded;
}

export class WorkerCore {
	#transport: Transport;
	#runtime: JsRuntime | null = null;
	#runs = new Map<string, ActiveRun>();
	#runQueue: RunMessage[] = [];
	#drainPromise: Promise<void> | null = null;
	#closing = false;
	#outputAcks = new Map<string, () => void>();
	#outputSequence = 0;
	#recentCellFiles = new Set<string>();
	#unsubscribe: () => void;
	#uninstallRejectionGuard: () => void;
	#uninstallExitGuard: () => void;
	#options: WorkerCoreOptions;

	constructor(transport: Transport, options: WorkerCoreOptions) {
		this.#transport = transport;
		this.#options = options;
		this.#unsubscribe = transport.onMessage(msg => this.#handle(msg));
		this.#uninstallRejectionGuard = this.#installRejectionGuard();
		this.#uninstallExitGuard = this.#installExitGuard();
	}

	/** Routes `process.exit()` from cell code to CellExit; the host's own exits (no cell running them) still exit. */
	#installExitGuard(): () => void {
		const exit = process.exit;
		const exitCell = ((code?: number | string | null): never => {
			const runId = this.#runtime?.currentRunId();
			if (runId === undefined) return exit.call(process, code);
			const cellExit = new CellExit(exitStatus(code));
			// Printed by a cell that catches it, the stack starts at the cell's own `process.exit()` call.
			Error.captureStackTrace(cellExit, exitCell);
			this.#options.markNonFatal?.(cellExit);
			this.#runs.get(runId)?.exit.reject(cellExit);
			throw cellExit;
		}) as typeof process.exit;
		process.exit = exitCell;
		// Thrown from a timer or listener, the exit escapes as an uncaught exception after it already ended its cell.
		const onUncaught = (error: unknown): void => {
			if (error instanceof CellExit) return;
			// A listener disables the runtime's default crash; rethrowing restores it for everything else.
			throw error;
		};
		if (!this.#options.markNonFatal) process.on("uncaughtException", onUncaught);
		return () => {
			if (process.exit === exitCell) process.exit = exit;
			process.off("uncaughtException", onUncaught);
		};
	}

	#installRejectionGuard(): () => void {
		if (this.#options.interceptUnhandledRejections) {
			return this.#options.interceptUnhandledRejections(reason => this.#consumeRejection(reason));
		}
		const onRejection = (reason: unknown): void => {
			if (this.#consumeRejection(reason)) return;

			setTimeout(() => {
				throw reason;
			}, 0);
		};
		process.on("unhandledRejection", onRejection);
		return () => {
			process.off("unhandledRejection", onRejection);
		};
	}

	#consumeRejection(reason: unknown): boolean {
		// A process.exit() unwinding through a promise chain; the exit already ended its cell.
		if (reason instanceof CellExit) return true;
		const stack = reason instanceof Error && typeof reason.stack === "string" ? reason.stack : undefined;
		if (stack) {
			let owner: ActiveRun | undefined;
			let ownerIndex = -1;
			for (const run of this.#runs.values()) {
				const index = stack.lastIndexOf(run.filename);
				if (index > ownerIndex) {
					ownerIndex = index;
					owner = run;
				}
			}
			if (owner) {
				owner.floatingRejections.push(reason);
				return true;
			}
			let recent: string | undefined;
			let recentIndex = -1;
			for (const filename of this.#recentCellFiles) {
				const index = stack.lastIndexOf(filename);
				if (index > recentIndex) {
					recentIndex = index;
					recent = filename;
				}
			}
			if (recent) {
				this.#transport.send({
					type: "log",
					level: "warn",
					msg: "Unhandled rejection from a finished eval cell (missing await?)",
					meta: { filename: recent, error: errorPayload(reason) },
				});
				return true;
			}
		}
		if (this.#runs.size > 0) {
			if (this.#runs.size === 1) {
				const only = this.#runs.values().next().value;
				only?.floatingRejections.push(reason);
				return true;
			}
			this.#transport.send({
				type: "log",
				level: "warn",
				msg: "Unhandled rejection during concurrent eval runs; cannot attribute to a cell",
				meta: { error: errorPayload(reason) },
			});
			return true;
		}
		return false;
	}

	#handle(msg: WorkerInbound): void {
		switch (msg.type) {
			case "init":
				try {
					this.#ensureRuntime(msg.snapshot);
					this.#transport.send({ type: "ready", interpreter: process.execPath });
				} catch (error) {
					this.#transport.send({ type: "init-failed", error: errorPayload(error) });
				}
				return;
			case "run":
				this.#enqueueRun(msg);
				return;
			case "stdin":
				this.#runs.get(msg.runId)?.input.feed(msg.data, msg.eof);
				return;
			case "output-ack":
				this.#outputAcks.get(msg.id)?.();
				this.#outputAcks.delete(msg.id);
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				void this.#close();
				return;
		}
	}

	#enqueueRun(msg: RunMessage): void {
		if (this.#closing) return;
		this.#runQueue.push(msg);
		if (this.#drainPromise) return;
		const drain = this.#drainRuns();
		this.#drainPromise = drain;
		void drain.finally(() => {
			if (this.#drainPromise !== drain) return;
			this.#drainPromise = null;
			if (!this.#closing && this.#runQueue.length > 0) this.#enqueueDrain();
		});
	}

	#enqueueDrain(): void {
		if (this.#drainPromise || this.#closing || this.#runQueue.length === 0) return;
		const drain = this.#drainRuns();
		this.#drainPromise = drain;
		void drain.finally(() => {
			if (this.#drainPromise !== drain) return;
			this.#drainPromise = null;
			this.#enqueueDrain();
		});
	}

	async #drainRuns(): Promise<void> {
		while (!this.#closing) {
			const msg = this.#runQueue.shift();
			if (!msg) return;
			await this.#runOne(msg.runId, msg.code, msg.filename, msg.snapshot, msg.completionContext);
		}
	}

	#ensureRuntime(snapshot: SessionSnapshot, currentRunId?: string): JsRuntime {
		this.#syncProcessCwd(snapshot.cwd, currentRunId);
		if (this.#runtime) {
			this.#runtime.setCwd(snapshot.cwd);
			this.#runtime.setLocalRoots(snapshot.localRoots ?? {});
			return this.#runtime;
		}
		this.#runtime = new JsRuntime({
			initialCwd: snapshot.cwd,
			generation: snapshot.generation,
			target: snapshot.target,
			sessionId: snapshot.sessionId,
			localRoots: snapshot.localRoots,
			trackFileWrites: true,
		});
		return this.#runtime;
	}

	#syncProcessCwd(cwd: string, currentRunId?: string): void {
		if (!this.#options.chdir) return;
		try {
			if (process.cwd() === cwd) return;
		} catch {}

		for (const runId of this.#runs.keys()) {
			if (runId === currentRunId) continue;
			this.#transport.send({
				type: "log",
				level: "warn",
				msg: "JS eval subprocess kept its process cwd: other cells are mid-run",
				meta: { cwd },
			});
			return;
		}
		try {
			this.#options.chdir(cwd);
		} catch (error) {
			this.#transport.send({
				type: "log",
				level: "warn",
				msg: "JS eval subprocess could not enter the session cwd",
				meta: { cwd, error: errorPayload(error) },
			});
		}
	}

	async #runOne(
		runId: string,
		code: string,
		filename: string,
		snapshot: SessionSnapshot,
		completionContext?: EvalCompletionInvocationContext,
	): Promise<void> {
		const active: ActiveRun = {
			runId,
			filename,
			completionContext,
			pendingTools: new Map(),
			floatingRejections: [],
			input: new WorkerInput(runId, this.#transport, snapshot.stdin === true),
			exit: Promise.withResolvers<never>(),
		};
		this.#runs.set(runId, active);
		const displayBudget = new PythonDisplayBudget();
		const output = new WorkerOutput(async (chunk, stream) => {
			if (this.#closing) return;
			const id = String(++this.#outputSequence);
			const ack = Promise.withResolvers<void>();
			this.#outputAcks.set(id, ack.resolve);
			this.#transport.send(
				typeof chunk === "string"
					? { type: "text", runId, id, chunk, stream }
					: { type: "bytes", runId, id, data: Buffer.from(chunk).toString("base64"), stream },
			);
			await ack.promise;
		});
		const hooks: RuntimeHooks = {
			onText: (chunk, stream) => {
				void output.write(chunk, stream);
			},
			onBytes: (chunk, stream) => output.write(chunk, stream),
			outputBackpressured: () => output.backpressured(),
			onDisplay: output => {
				if (output.type === "status") {
					this.#transport.send({ type: "display", runId, output });
					return;
				}
				for (const accepted of displayBudget.addKernelOutput(output)) {
					if (accepted.type !== "markdown") this.#transport.send({ type: "display", runId, output: accepted });
				}
				displayBudget.release();
			},
			callTool: (name, args, completionInvocationId) => this.#callTool(active, name, args, completionInvocationId),
		};
		let result: RunResult;
		try {
			const runtime = this.#ensureRuntime(snapshot, runId);
			runtime.setCwd(snapshot.cwd);
			const value = await runtime.run(code, filename, hooks, {
				runId,
				cwd: snapshot.cwd,
				shellEnv: snapshot.shellEnv,
				stdin: active.input,
				stop: active.exit.promise,
			});
			runtime.displayValue(value, hooks);
			result = { type: "result", runId, ok: true };
		} catch (error) {
			result =
				error instanceof CellExit
					? { type: "result", runId, ok: true, exitCode: error.status }
					: { type: "result", runId, ok: false, error: errorPayload(error) };
		}
		try {
			await sleep(0);
			result = foldFloatingRejections(active, result, hooks);
			await output.flush();
		} catch (error) {
			result = { type: "result", runId, ok: false, error: errorPayload(error) };
		} finally {
			active.input.destroy();
			this.#runs.delete(runId);
			this.#rememberCellFile(filename);
			if (!this.#closing) this.#transport.send(result);
			displayBudget.release();
		}
	}

	#rememberCellFile(filename: string): void {
		this.#recentCellFiles.delete(filename);
		this.#recentCellFiles.add(filename);
		if (this.#recentCellFiles.size > RECENT_CELL_FILES_MAX) {
			const oldest = this.#recentCellFiles.values().next().value;
			if (oldest !== undefined) this.#recentCellFiles.delete(oldest);
		}
	}

	async #callTool(active: ActiveRun, name: string, args: unknown, completionInvocationId?: string): Promise<unknown> {
		const id = `tc-${active.runId}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { runId: active.runId, resolve, reject });
		try {
			this.#transport.send({
				type: "tool-call",
				id,
				runId: active.runId,
				name,
				args,
				...(completionInvocationId !== undefined ? { completionInvocationId } : {}),
			});
		} catch (error) {
			active.pendingTools.delete(id);
			reject(error);
		}
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		for (const active of this.#runs.values()) {
			const pending = active.pendingTools.get(id);
			if (!pending) continue;
			active.pendingTools.delete(id);
			if (reply.ok) pending.resolve(reply.value);
			else pending.reject(errorFromPayload(reply.error));
			return;
		}
	}

	async #close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		this.#runQueue.length = 0;
		this.#rejectActiveTools();
		await this.#drainPromise?.catch(() => undefined);
		this.#finishClose(true);
	}

	#rejectActiveTools(): void {
		for (const resolve of this.#outputAcks.values()) resolve();
		this.#outputAcks.clear();
		for (const active of this.#runs.values()) {
			active.input.destroy();
			for (const pending of active.pendingTools.values()) {
				pending.reject(new ToolError("JS worker closed"));
			}
			active.pendingTools.clear();
		}
	}

	#finishClose(sendAck: boolean): void {
		this.#runs.clear();
		this.#runtime?.dispose?.();
		this.#runtime = null;
		if (sendAck) this.#transport.send({ type: "closed" });
		this.#uninstallRejectionGuard();
		this.#uninstallExitGuard();
		this.#unsubscribe();
		this.#transport.close();
	}

	dispose(): void {
		if (this.#closing) return;
		this.#closing = true;
		this.#runQueue.length = 0;
		this.#rejectActiveTools();
		this.#finishClose(false);
	}
}
