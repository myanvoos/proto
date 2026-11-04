import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import {
	hasDeclaredStateContinuity,
	releaseDeclaredStateOwner,
	withDeclaredStateBoundary,
} from "../eval/declared-state";
import { releaseFsObservationLedger, retainFsObservationLedger } from "../eval/fs-observations";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { type KernelDisplayOutput, normalizePythonDisplayOutputs } from "../eval/py/display";
import { disposeKernelSessionsByOwner, type PythonResult } from "../eval/py/executor";
import { executeFreshPython } from "../eval/py/fresh-executor";
import { hasPythonStore, releasePythonStore } from "../eval/py/python-store";
import { defaultEvalSessionId } from "../eval/session-id";
import type { ExtensionRunner } from "../extensibility/extensions";
import type { ToolSession } from "../tools";
import { outputMeta } from "../tools/output-meta";
import type { PythonExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";
import { captureSessionState, stageSessionStateOnResume } from "./state-manifest";

export interface EvalRunnerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	extensionRunner(): ExtensionRunner | undefined;
	toolSession(): ToolSession | undefined;
	isStreaming(): boolean;
	appendSessionMessage(message: PythonExecutionMessage): void;
}

export class EvalRunner {
	readonly #host: EvalRunnerHost;
	readonly #kernelOwnerId: string;
	readonly #parentSessionId: string | undefined;
	#abortControllers = new Set<AbortController>();
	#pendingMessages: PythonExecutionMessage[] = [];
	#activeExecutions = new Set<Promise<unknown>>();
	#observationSessionId: string | undefined;
	#disposing = false;
	#stateSessionId: string | undefined;

	constructor(host: EvalRunnerHost, options: { kernelOwnerId: string; parentSessionId: string | undefined }) {
		this.#host = host;
		this.#kernelOwnerId = options.kernelOwnerId;
		this.#parentSessionId = options.parentSessionId;
		this.#stageResumedState();
	}

	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: {
			excludeFromContext?: boolean;
			onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;
		},
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.sessionManager.getCwd();
		this.assertExecutionAllowed();
		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			const extensionRunner = this.#host.extensionRunner();
			if (extensionRunner?.hasHandlers("user_python")) {
				const hookResult = await extensionRunner.emitUserPython(
					{
						type: "user_python",
						code,
						excludeFromContext,
						cwd,
					},
					abortController.signal,
				);
				abortController.signal.throwIfAborted();
				this.assertExecutionAllowed();
				if (hookResult?.result) {
					for (const output of hookResult.result.displayOutputs ?? []) {
						abortController.signal.throwIfAborted();
						await options?.onDisplay?.(output);
						abortController.signal.throwIfAborted();
					}
					abortController.signal.throwIfAborted();
					this.recordPythonResult(code, hookResult.result, options);
					if (!this.#host.isStreaming()) await captureSessionState(this.#host.sessionManager, this.#kernelOwnerId);
					return hookResult.result;
				}
			}
			const result = await executeFreshPython(code, {
				cwd,
				settings: this.#host.settings,
				toolSession: this.#host.toolSession(),
				onChunk,
				onDisplay: options?.onDisplay,
				signal: abortController.signal,
			});
			this.recordPythonResult(code, result, options);
			if (!this.#host.isStreaming()) await captureSessionState(this.#host.sessionManager, this.#kernelOwnerId);
			return result;
		})();
		return await this.trackExecution(execution, abortController);
	}

	assertExecutionAllowed(): void {
		if (this.#disposing) throw new Error("Python execution is unavailable while session disposal is in progress");
	}

	trackExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#abortControllers.add(abortController);
		this.#activeExecutions.add(execution);
		void execution.then(
			() => {
				this.#abortControllers.delete(abortController);
				this.#activeExecutions.delete(execution);
			},
			() => {
				this.#abortControllers.delete(abortController);
				this.#activeExecutions.delete(execution);
			},
		);
		return execution;
	}

	recordPythonResult(
		code: string,
		result: PythonResult,
		options?: {
			excludeFromContext?: boolean;
			onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;
		},
	): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const message: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			execution: result.execution,
			displayOutputs: normalizePythonDisplayOutputs(result.displayOutputs),
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};
		if (this.#host.isStreaming()) {
			this.#pendingMessages.push(message);
		} else {
			this.#host.appendSessionMessage(message);
		}
	}

	abort(): void {
		for (const abortController of this.#abortControllers) abortController.abort();
	}

	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	get hasPendingMessages(): boolean {
		return this.#pendingMessages.length > 0;
	}

	getKernelOwnerId(): string {
		return this.#kernelOwnerId;
	}

	getSessionId(): string | null {
		if (this.#stateSessionId !== this.#host.sessionManager.getSessionId()) this.#stageResumedState();
		const sessionId =
			this.#parentSessionId ??
			defaultEvalSessionId({
				cwd: this.#host.sessionManager.getCwd(),
				getSessionFile: () => this.#host.sessionManager.getSessionFile() ?? null,
			});
		if (!this.#disposing && sessionId !== this.#observationSessionId) {
			if (this.#observationSessionId !== undefined) {
				releaseFsObservationLedger(this.#observationSessionId, this.#kernelOwnerId);
			}
			retainFsObservationLedger(sessionId, this.#kernelOwnerId);
			this.#observationSessionId = sessionId;
		}
		return sessionId;
	}

	#stageResumedState(): void {
		const manager = this.#host.sessionManager;
		const evalSessionId =
			this.#parentSessionId ??
			defaultEvalSessionId({ cwd: manager.getCwd(), getSessionFile: () => manager.getSessionFile() ?? null });
		stageSessionStateOnResume(manager, this.#kernelOwnerId, evalSessionId);
		this.#stateSessionId = manager.getSessionId();
	}

	syncObservationSession(): void {
		this.getSessionId();
	}

	disposeObservations(): void {
		if (this.#observationSessionId === undefined) return;
		releaseFsObservationLedger(this.#observationSessionId, this.#kernelOwnerId);
		this.#observationSessionId = undefined;
	}

	flushPending(): void {
		if (this.#pendingMessages.length === 0) return;
		for (const message of this.#pendingMessages) this.#host.appendSessionMessage(message);
		this.#pendingMessages = [];
	}

	beginDispose(): void {
		this.#disposing = true;
	}

	/** Refusal precedes beginDispose/detachment; the lease spans exit capture and actual interpreter teardown. */
	async prepareRuntimeRelease<T>(release: () => Promise<T>, prepareHistory?: () => void): Promise<T> {
		if (this.#activeExecutions.size > 0) throw new Error("Cannot release a runtime with active eval execution");
		return withDeclaredStateBoundary(this.#kernelOwnerId, async () => {
			if (this.#activeExecutions.size > 0) throw new Error("Cannot release a runtime with admitted eval execution");
			if (
				hasDeclaredStateContinuity(this.#kernelOwnerId) ||
				hasPythonStore(this.#kernelOwnerId, this.#host.sessionManager)
			)
				await captureSessionState(
					this.#host.sessionManager,
					this.#kernelOwnerId,
					this.#host.sessionManager.getLeafId(),
					prepareHistory,
				);
			else prepareHistory?.();
			return await release();
		});
	}

	async disposeKernels(): Promise<void> {
		const settled = await this.#prepareExecutionsForDispose();
		if (!settled) {
			logger.warn("Detaching retained eval-kernel ownership during dispose while eval execution is still active");
		}
		const errors: unknown[] = [];
		const results = await Promise.allSettled([
			disposeKernelSessionsByOwner(this.#kernelOwnerId),
			disposeVmContextsByOwner(this.#kernelOwnerId),
		]);
		for (const result of results) if (result.status === "rejected") errors.push(result.reason);
		if (settled && results.every(result => result.status === "fulfilled")) {
			releaseDeclaredStateOwner(this.#kernelOwnerId);
			releasePythonStore(this.#kernelOwnerId);
		}
		if (errors.length > 0)
			throw new AggregateError(errors, "Failed to preserve declared state or dispose eval kernels");
	}

	async #waitForExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return false;
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeExecutions.size > 0) return false;
		}
		return true;
	}

	async #prepareExecutionsForDispose(): Promise<boolean> {
		if (!(await this.#waitForExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abort();
			if (!(await this.#waitForExecutionsToSettle(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}
}
