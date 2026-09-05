import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, ToolExample } from "@oh-my-pi/pi-ai";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import {
	DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
	formatBackgroundNotice,
	raceJobSettlement,
	resolveAutoBackgroundWaitMs,
} from "../async";
import { jsBackend, pythonBackend } from "../eval";
import type { ExecutorBackend, ExecutorBackendResult } from "../eval/backend";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../eval/bridge-timeout";
import { CellFsTracker, sha256Prefix } from "../eval/cell-file-diff";
import { formatDisplayOutputsForText } from "../eval/display-text";
import { fsObservationLedgerFor, recordMutationEvents } from "../eval/fs-observations";
import { IdleTimeout } from "../eval/idle-timeout";
import { defaultEvalSessionId } from "../eval/session-id";
import type { EvalCellResult, EvalDisplayOutput, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "../eval/types";
import evalDescription from "../prompts/tools/eval.md" with { type: "text" };
import {
	type ExecutionMetadata,
	type ExecutionStageMetadata,
	type ExecutionTimeoutMetadata,
	executionMetadataForResult,
} from "../session/execution-metadata";
import { capEventDiff } from "../utils/diff";
import "./kernel-prelude";
import * as path from "node:path";
import evalCodeModeDescription from "../prompts/tools/eval-code-mode.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, OutputSink, type OutputSummary, TailBuffer } from "../session/streaming-output";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import { webpExclusionForModel } from "../utils/image-loading";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import type { ToolSession } from ".";
import { type EvalBackendsAllowance, resolveEvalBackends } from "./eval-backends";
import { generateCodeModeDeclarations } from "./eval-format/code-mode-declarations";
import { upsertStatusEvent } from "./eval-render";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "./output-meta";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export { EVAL_DEFAULT_PREVIEW_LINES, evalToolRenderer } from "./eval-render";

type EvalLanguageToken = "py" | "js";
const EVAL_LANGUAGE_ORDER: readonly EvalLanguageToken[] = ["py", "js"];
const EVAL_LANGUAGE_RUNTIME: Record<EvalLanguageToken, string> = {
	py: '"py" for the IPython kernel',
	js: '"js" for the persistent JS VM',
};
const EVAL_LANGUAGE_NAME: Record<EvalLanguageToken, string> = {
	py: "Python",
	js: "JavaScript",
};

function joinWithOr(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} or ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function describeLanguageField(langs: readonly EvalLanguageToken[]): string {
	return `runtime: ${langs.map(lang => EVAL_LANGUAGE_RUNTIME[lang]).join(", ")}`;
}

const EVAL_CODE_FIELD_DESCRIPTION = "code to run in this eval call, verbatim. Use top-level await freely.";

function summarizeEvalLanguages(langs: readonly EvalLanguageToken[]): string {
	const names = langs.map(lang => EVAL_LANGUAGE_NAME[lang]);
	const list = names.length > 0 ? joinWithOr(names) : "Python or JavaScript";

	return `Execute ${list} code in persistent eval kernels`;
}

function enabledEvalLanguages(backends: EvalBackendsAllowance): EvalLanguageToken[] {
	const allowed: Record<EvalLanguageToken, boolean> = {
		py: backends.python,
		js: backends.js,
	};
	return EVAL_LANGUAGE_ORDER.filter(lang => allowed[lang]);
}

const evalFileSchema = type({
	path: type("string").describe("file path, absolute or relative to cwd"),
	content: type("string").describe("full file contents, written verbatim as UTF-8 text"),
});

const evalCellCommonFields = {
	"title?": type("string").describe('short label shown in transcript (e.g. "imports", "load config")'),
	"timeout?": type("number").describe(
		"timeout for this eval call in seconds (default 30; time spent inside agent()/completion() does not count); 0 disables the cell timeout",
	),
	"reset?": type("boolean").describe("wipe this language's kernel before running. Other languages are untouched."),
	"files?": evalFileSchema
		.array()
		.describe(
			"files written to disk before the code runs. The quoting-safe channel for file creation: content is a raw JSON string — no string-literal nesting, heredocs, or escaping gymnastics. Each write emits a write event with diff.",
		),
};

const evalSchema = type({
	language: type("'py' | 'js'").describe(describeLanguageField(EVAL_LANGUAGE_ORDER)),
	...evalCellCommonFields,
	code: type("string").describe(EVAL_CODE_FIELD_DESCRIPTION),
});
type EvalToolParams = typeof evalSchema.infer;

function buildEvalSchema(langs: readonly EvalLanguageToken[]): typeof evalSchema {
	const schema = type({
		language: type.enumerated(...langs).describe(describeLanguageField(langs)),
		code: type("string").describe(EVAL_CODE_FIELD_DESCRIPTION),
		...evalCellCommonFields,
	});
	return schema as unknown as typeof evalSchema;
}

type EvalToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: EvalToolDetails | undefined;
};

type EvalProxyExecutor = (params: EvalToolParams, signal?: AbortSignal) => Promise<EvalToolResult>;

interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;

	spawns?: boolean | string | null;

	autoBackgroundEnabled?: boolean;
}

export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const py = options.py ?? true;
	const js = options.js ?? true;
	const spawnPolicy = resolveSpawnPolicy(options.spawns ?? true);
	return prompt.render(evalDescription, {
		py,
		js,
		autoBackgroundEnabled: options.autoBackgroundEnabled ?? false,
		spawns: spawnPolicy.enabled,
		spawnDefaultAgent: spawnPolicy.defaultAgent,
		spawnAllowedAgentsText: spawnPolicy.allowedPromptText,
	});
}

interface EvalToolOptions {
	proxyExecutor?: EvalProxyExecutor;
}

interface ResolvedBackend {
	backend: ExecutorBackend;
	notice?: string;
}

interface EvalFileSpec {
	path: string;
	content: string;
}

interface ResolvedEvalCell {
	index: number;
	title?: string;
	code: string;
	timeoutMs: number;
	reset: boolean;
	files?: EvalFileSpec[];
	resolved: ResolvedBackend;
}

type ManagedEvalJobCompletion =
	| { kind: "completed"; result: AgentToolResult<EvalToolDetails | undefined> }
	| { kind: "failed"; error: unknown };

function uniqueEvalLanguages(cells: ResolvedEvalCell[]): EvalLanguage[] {
	return [...new Set(cells.map(cell => cell.resolved.backend.id))];
}

function detailsNotice(cells: ResolvedEvalCell[]): string | undefined {
	const notices = [
		...new Set(cells.map(cell => cell.resolved.notice).filter((notice): notice is string => Boolean(notice))),
	];
	return notices.length > 0 ? notices.join(" ") : undefined;
}

async function resolveBackend(session: ToolSession, language: EvalLanguage): Promise<ResolvedBackend> {
	const backends = resolveEvalBackends(session);
	const allowPy = backends.python;
	const allowJs = backends.js;

	if (language === "python") {
		if (!allowPy) throw new ToolError("Python backend is disabled (PI_PY=0 or eval.py = false).");
		if (!(await pythonBackend.isAvailable(session))) {
			const alternatives = [allowJs ? '"js"' : null].filter(Boolean);
			throw new ToolError(
				alternatives.length > 0
					? `Python backend is unavailable in this session. Pass language: ${alternatives.join(" or ")} or install the python kernel.`
					: 'Python backend is unavailable in this session. Install the python kernel to use language: "py".',
			);
		}
		return { backend: pythonBackend };
	}
	if (!allowJs) throw new ToolError("JavaScript backend is disabled (PI_JS=0 or eval.js = false).");
	return { backend: jsBackend };
}
function formatEvalInputLanguage(value: string): string {
	if (value === "py" || value === "python") return "python";
	if (value === "js" || value === "javascript") return "javascript";
	return value;
}

function stageMetadataForCell(cell: EvalCellResult): ExecutionStageMetadata {
	const execution = cell.execution;
	if (execution) {
		return {
			index: cell.index,
			state: execution.state,
			exitCode: execution.exitCode,
			signal: execution.signal,
			elapsedMs: execution.elapsedMs,
			timeout: execution.timeout,
		};
	}
	return {
		index: cell.index,
		state: cell.status === "running" ? "running" : "unknown",
		exitCode: cell.exitCode,
	};
}

function buildEvalExecutionMetadata(options: {
	cells: readonly EvalCellResult[];
	exitCode?: number;
	cancelled?: boolean;
	timedOut?: boolean;
	elapsedMs?: number;
	summary?: OutputSummary;
	running?: boolean;
}): ExecutionMetadata {
	const stages = options.cells.map(stageMetadataForCell);
	const timedOutStage = stages.find(stage => stage.timeout !== undefined);
	const timeout: ExecutionTimeoutMetadata | undefined = timedOutStage?.timeout
		? { ...timedOutStage.timeout, scope: "pipeline" }
		: options.timedOut
			? { cause: "unknown", scope: "pipeline" }
			: undefined;
	const metadata = executionMetadataForResult(
		{
			exitCode: options.exitCode,
			cancelled: options.cancelled === true,
			timedOut: options.timedOut,
		},
		{
			state: options.running === true ? "running" : undefined,
			elapsedMs: options.elapsedMs,
			timeout,
			summary: options.summary,
			stages,
		},
	);
	if (options.running === true) {
		return { ...metadata, collector: { state: "running" } };
	}
	return metadata;
}
function looksBinary(text: string): boolean {
	return text.slice(0, 8192).includes("\u0000");
}

export class EvalTool implements AgentTool<typeof evalSchema> {
	readonly name = "eval";
	get summary(): string {
		return summarizeEvalLanguages(this.#enabledLanguages());
	}

	supportsCodeModeTransport(): boolean {
		return this.#enabledLanguages().includes("js");
	}
	readonly loadMode = "discoverable";
	readonly label = "Eval";
	get description(): string {
		let base: string;
		if (!this.session) {
			base = getEvalToolDescription();
		} else {
			const backends = resolveEvalBackends(this.session);
			const sessionSpawns = this.session.getSessionSpawns?.() ?? "*";
			base = getEvalToolDescription({
				py: backends.python,
				js: backends.js,
				spawns: sessionSpawns,
				autoBackgroundEnabled: this.session.settings.get("eval.autoBackground.enabled"),
			});
		}
		return this.#codeModeDescription(base) ?? base;
	}

	#codeModeDescription(baseDescription: string): string | undefined {
		const session = this.session;
		const directToolNames = session?.getCodeModeDirectToolNames?.();
		if (!session || !directToolNames) return undefined;
		const direct = new Set(directToolNames);
		const declarations = generateCodeModeDeclarations(
			(session.getEvalBridgeToolNames?.() ?? [...(session.toolRegistry?.keys() ?? [])]).flatMap(name => {
				if (direct.has(name)) return [];
				const tool = session.toolRegistry?.get(name);
				return tool ? [{ name, parameters: (tool as { parameters?: unknown }).parameters }] : [];
			}),
		);
		return prompt.render(evalCodeModeDescription, { baseDescription, declarations });
	}

	private static readonly ALL_EXAMPLES: readonly ToolExample<typeof evalSchema.infer>[] = [
		{
			caption: "First call — set up once",
			call: {
				language: "py",
				title: "imports",
				code: "import json\nfrom pathlib import Path",
			},
		},
		{
			caption: "Second call — reuse, do NOT re-import",
			call: {
				language: "py",
				title: "load config",
				code: "data = json.loads(Path('package.json').read_text())\ndisplay(data)",
			},
		},
		{
			caption: "Third call — reuse the loaded config",
			call: {
				language: "py",
				title: "scan deps",
				code: "display(sorted(data['dependencies']))",
			},
		},
	];
	get examples(): readonly ToolExample<typeof evalSchema.infer>[] {
		const langs = new Set(this.#enabledLanguages());
		return EvalTool.ALL_EXAMPLES.filter(ex => "call" in ex && langs.has(ex.call.language as EvalLanguageToken));
	}
	get parameters(): typeof evalSchema {
		const langs = this.#enabledLanguages();
		if (langs.length === 0 || langs.length === EVAL_LANGUAGE_ORDER.length) return evalSchema;
		const key = langs.join(",");
		if (this.#paramsKey !== key) {
			this.#cachedParams = buildEvalSchema(langs);
			this.#paramsKey = key;
		}
		return this.#cachedParams ?? evalSchema;
	}
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly intent = (args: Partial<typeof evalSchema.infer>): string | undefined => {
		const title = typeof args.title === "string" ? args.title : undefined;
		const language = typeof args.language === "string" ? formatEvalInputLanguage(args.language) : "javascript";
		return title || `running ${language}`;
	};

	readonly #proxyExecutor?: EvalProxyExecutor;

	#paramsKey?: string;
	#cachedParams?: typeof evalSchema;

	#enabledLanguages(): EvalLanguageToken[] {
		return this.session ? enabledEvalLanguages(resolveEvalBackends(this.session)) : ["py", "js"];
	}

	constructor(
		private readonly session: ToolSession | null,
		options?: EvalToolOptions,
	) {
		this.#proxyExecutor = options?.proxyExecutor;
	}

	async execute(
		_toolCallId: string,
		params: typeof evalSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		if (this.#proxyExecutor) {
			return this.#proxyExecutor(params, signal);
		}

		if (!this.session) {
			throw new ToolError("Eval tool requires a session when not using proxy executor");
		}
		const session = this.session;
		const excludeWebP = webpExclusionForModel(session.getActiveModel?.());

		const cellLanguage: EvalLanguage = params.language === "py" ? "python" : "js";
		const resolved = await resolveBackend(session, cellLanguage);
		const cells: ResolvedEvalCell[] = [
			{
				index: 0,
				title: params.title,
				code: params.code,
				timeoutMs: (params.timeout ?? 30) * 1000,
				reset: params.reset ?? false,
				files: params.files,
				resolved,
			},
		];
		const languages = uniqueEvalLanguages(cells);
		const notice = detailsNotice(cells);
		const sessionAbortController = new AbortController();
		const emitToolUpdate = onUpdate
			? (text: string, details: EvalToolDetails): void => {
					onUpdate({ content: [{ type: "text", text }], details });
				}
			: undefined;
		const run = (
			runSignal: AbortSignal | undefined,
			emitUpdate: ((text: string, details: EvalToolDetails) => void) | undefined,
		): Promise<AgentToolResult<EvalToolDetails | undefined>> => {
			const execution = this.#runCells({
				session,
				cells,
				languages,
				notice,
				excludeWebP,
				signal: runSignal,
				sessionAbortController,
				emitUpdate,
			});
			return session.trackEvalExecution?.(execution, sessionAbortController) ?? execution;
		};

		const autoBgManager = session.asyncJobManager;

		if (!session.settings.get("eval.autoBackground.enabled") || !autoBgManager || autoBgManager.atCapacity) {
			return await run(signal, emitToolUpdate);
		}

		const thresholdMs = Math.max(
			0,
			Math.floor(session.settings.get("eval.autoBackground.thresholdMs") ?? DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS),
		);

		const cellTimeoutMs =
			cells[0].timeoutMs === 0
				? undefined
				: clampTimeout("eval", cells[0].timeoutMs / 1000, session.settings.get("tools.maxTimeout")) * 1000;
		const autoBackgroundWaitMs = resolveAutoBackgroundWaitMs(thresholdMs, cellTimeoutMs);
		const startBackgrounded = autoBackgroundWaitMs === 0;

		const rawLabel = params.title?.trim() || params.code.trim().split("\n", 1)[0] || "eval cell";
		const label = rawLabel.length > 120 ? `${rawLabel.slice(0, 117)}...` : rawLabel;

		let latestText = "";
		let latestDetails: EvalToolDetails | undefined;
		let forwardUpdates = !startBackgrounded;
		const completion = Promise.withResolvers<ManagedEvalJobCompletion>();

		const jobId = autoBgManager.register(
			"eval",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				try {
					const result = await run(runSignal, (text, details) => {
						latestText = text;
						latestDetails = details;
						void reportProgress(text, { async: { state: "running", jobId, type: "eval" } });
						if (forwardUpdates) emitToolUpdate?.(text, details);
					});
					const finalText = result.content.find(block => block.type === "text")?.text ?? "";
					latestText = finalText;

					completion.resolve({ kind: "completed", result });
					if (result.isError === true) {
						throw new ToolError(finalText || "Eval cell failed");
					}
					await reportProgress(finalText, { async: { state: "completed", jobId, type: "eval" } });
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					latestText = message;
					completion.resolve({ kind: "failed", error });
					await reportProgress(message, { async: { state: "failed", jobId, type: "eval" } });
					throw error;
				}
			},
			{ ownerId: session.getAsyncJobOwnerId?.() ?? session.getAgentId?.() ?? undefined },
		);

		if (startBackgrounded) {
			return this.#buildBackgroundStartResult(jobId, cells, languages, notice, latestText, latestDetails);
		}

		autoBgManager.acknowledgeDeliveries([jobId]);
		const waitResult = await raceJobSettlement(
			completion.promise,
			autoBackgroundWaitMs,
			signal,
			ctx?.toolCall?.steeringSignal,
		);
		if (waitResult.kind === "completed") {
			return waitResult.result;
		}
		if (waitResult.kind === "failed") {
			throw waitResult.error;
		}
		if (waitResult.kind === "aborted") {
			autoBgManager.cancel(jobId);
			throw new ToolAbortError(latestText || "Eval cell aborted");
		}
		forwardUpdates = false;
		autoBgManager.resumeDeliveries([jobId]);

		const steerNotice =
			waitResult.kind === "steer"
				? "Backgrounded early to handle an incoming message; the cell keeps running."
				: undefined;
		return this.#buildBackgroundStartResult(jobId, cells, languages, notice, latestText, latestDetails, steerNotice);
	}

	readonly #fsTracker = new CellFsTracker();

	async #materializeFiles(
		files: EvalFileSpec[] | undefined,
		cwd: string,
		onStatus: (event: EvalStatusEvent) => void,
	): Promise<void> {
		if (!files || files.length === 0) return;
		for (const file of files) {
			const abs = path.isAbsolute(file.path) ? file.path : path.join(cwd, file.path);
			let before: string | undefined = "";
			try {
				const existing = await Bun.file(abs).text();
				before = looksBinary(existing) ? undefined : existing;
			} catch (err) {
				if (!isEnoent(err)) before = undefined;
			}
			await Bun.write(abs, file.content);
			this.#fsTracker.noteWrite(abs, file.content);
			const event: EvalStatusEvent = {
				op: "write",
				path: abs,
				chars: file.content.length,
				sha: sha256Prefix(new TextEncoder().encode(file.content)),
			};
			const capped = before === undefined ? undefined : capEventDiff(before, file.content);
			if (capped) {
				event.diff = capped.diff;
				if (capped.diffTruncated) event.diffTruncated = true;
			}
			onStatus(event);
		}
	}

	#buildBackgroundStartResult(
		jobId: string,
		cells: ResolvedEvalCell[],
		languages: EvalLanguage[],
		notice: string | undefined,
		previewText: string,
		latestDetails: EvalToolDetails | undefined,
		extraNotice?: string,
	): AgentToolResult<EvalToolDetails> {
		const details: EvalToolDetails = latestDetails ?? {
			language: languages[0],
			languages,
			cells: cells.map(cell => ({
				index: cell.index,
				title: cell.title,
				code: cell.code,
				language: cell.resolved.backend.id,
				output: previewText,
				status: "running" as const,
			})),
		};
		if (notice) details.notice ??= notice;
		details.async = { state: "running", jobId, type: "eval" };
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (extraNotice) {
			lines.push(extraNotice, "");
		}
		lines.push(formatBackgroundNotice(jobId));
		return { content: [{ type: "text", text: lines.join("\n") }], details };
	}

	async #runCells(options: {
		session: ToolSession;
		cells: ResolvedEvalCell[];
		languages: EvalLanguage[];
		notice: string | undefined;
		excludeWebP: boolean | undefined;
		signal: AbortSignal | undefined;
		sessionAbortController: AbortController;
		emitUpdate?: (text: string, details: EvalToolDetails) => void;
	}): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		const { session, cells, languages, notice, excludeWebP, signal, sessionAbortController, emitUpdate } = options;
		const executionStartedAt = performance.now();
		const tailBuffer_v21 = new TailBuffer(DEFAULT_MAX_BYTES * 2);
		let outputSink: OutputSink | undefined;
		let outputSummary: OutputSummary | undefined;
		let outputDumped = false;
		const finalizeOutput = async (): Promise<OutputSummary | undefined> => {
			if (outputDumped || !outputSink) return outputSummary;
			try {
				outputSummary = await outputSink.dump();
			} catch (error) {
				const fallbackText = tailBuffer_v21.text();
				const fallbackBytes = Buffer.byteLength(fallbackText, "utf-8");
				outputSummary = {
					output: fallbackText,
					truncated: true,
					totalLines: fallbackText.length > 0 ? fallbackText.split("\n").length : 0,
					totalBytes: fallbackBytes,
					outputLines: fallbackText.length > 0 ? fallbackText.split("\n").length : 0,
					outputBytes: fallbackBytes,
					collector: {
						state: "failed",
						error: error instanceof Error ? error.message : String(error),
					},
					outputDisposition: fallbackText.length > 0 ? "truncated" : "unavailable",
				};
				logger.warn("Eval output collection failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				outputDumped = true;
			}
			return outputSummary;
		};
		try {
			if (signal?.aborted) {
				throw new ToolAbortError();
			}
			session.assertEvalExecutionAllowed?.();

			const jsonOutputs: unknown[] = [];
			const images: ImageContent[] = [];
			const statusEvents: EvalStatusEvent[] = [];

			const cellResults: EvalCellResult[] = cells.map(cell => ({
				index: cell.index,
				title: cell.title,
				code: cell.code,
				language: cell.resolved.backend.id,
				output: "",
				status: "pending",
			}));
			const cellOutputs: string[] = [];

			let activeLiveCell: { result: EvalCellResult; buf: TailBuffer } | undefined;

			const appendTail = (text: string) => {
				tailBuffer_v21.append(text);
			};

			const buildUpdateDetails = (): EvalToolDetails => {
				const details: EvalToolDetails = {
					language: languages[0],
					languages,
					execution: buildEvalExecutionMetadata({
						cells: cellResults,
						running: true,
						elapsedMs: performance.now() - executionStartedAt,
						summary: outputSummary,
					}),
					cells: cellResults.map(cell => ({
						...cell,
						statusEvents: cell.statusEvents ? [...cell.statusEvents] : undefined,
					})),
				};
				if (jsonOutputs.length > 0) {
					details.jsonOutputs = jsonOutputs;
				}
				if (images.length > 0) {
					details.images = images;
				}
				if (statusEvents.length > 0) {
					details.statusEvents = statusEvents;
				}
				if (notice) {
					details.notice = notice;
				}
				return details;
			};

			const pushUpdate = () => {
				emitUpdate?.(tailBuffer_v21.text(), buildUpdateDetails());
			};

			const sessionFile = session.getSessionFile?.() ?? undefined;
			const kernelOwnerId = session.getEvalKernelOwnerId?.() ?? undefined;
			const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.("eval")) ?? {};
			session.assertEvalExecutionAllowed?.();
			outputSink = new OutputSink({
				artifactPath,
				artifactId,
				headBytes: resolveOutputSinkHeadBytes(session.settings),
				maxColumns: resolveOutputMaxColumns(session.settings),
				onChunk: chunk => {
					appendTail(chunk);
					if (activeLiveCell) {
						activeLiveCell.buf.append(chunk);
						activeLiveCell.result.output = activeLiveCell.buf.text();
					}
					pushUpdate();
				},
			});
			const sessionId = session.getEvalSessionId?.() ?? defaultEvalSessionId(session);

			for (let i = 0; i < cells.length; i++) {
				const cell = cells[i];
				const backend = cell.resolved.backend;

				const idleTimeoutMs =
					cell.timeoutMs === 0
						? undefined
						: clampTimeout("eval", cell.timeoutMs / 1000, session.settings.get("tools.maxTimeout")) * 1000;
				const idle = idleTimeoutMs === undefined ? undefined : new IdleTimeout(idleTimeoutMs);
				const combinedSignal =
					signal && idle
						? AbortSignal.any([signal, idle.signal, sessionAbortController.signal])
						: signal
							? AbortSignal.any([signal, sessionAbortController.signal])
							: idle
								? AbortSignal.any([idle.signal, sessionAbortController.signal])
								: sessionAbortController.signal;

				const cellResult = cellResults[i];
				cellResult.status = "running";
				cellResult.output = "";
				cellResult.statusEvents = undefined;
				cellResult.exitCode = undefined;
				cellResult.durationMs = undefined;
				const materializedEvents: EvalStatusEvent[] = [];
				await this.#materializeFiles(cell.files, session.cwd, event => {
					materializedEvents.push(event);
					upsertStatusEvent(statusEvents, event);
					cellResult.statusEvents ??= [];
					upsertStatusEvent(cellResult.statusEvents, event);
					pushUpdate();
				});
				const fsBefore = await this.#fsTracker.capture(session.cwd, combinedSignal);
				activeLiveCell = { result: cellResult, buf: new TailBuffer(DEFAULT_MAX_BYTES * 2) };
				pushUpdate();

				const cellStatusEvents: EvalStatusEvent[] = [];
				const cellFsEvents: EvalStatusEvent[] = [];
				const startTime = Date.now();
				let result: ExecutorBackendResult;
				try {
					result = await backend.execute(cell.code, {
						cwd: session.cwd,
						sessionId,
						sessionFile: sessionFile ?? undefined,
						kernelOwnerId,
						signal: combinedSignal,
						session,
						idleTimeoutMs,
						reset: cell.reset,
						onChunk: chunk => {
							outputSink!.push(chunk);
						},
						onStatus: event => {
							if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
								idle?.pause();
								return;
							}
							if (event.op === EVAL_TIMEOUT_RESUME_OP) {
								idle?.resume();
								return;
							}
							cellResult.statusEvents ??= [];
							upsertStatusEvent(cellResult.statusEvents, event);
							pushUpdate();
						},
					});
				} finally {
					idle?.dispose();
					activeLiveCell = undefined;
					if (fsBefore) {
						try {
							await this.#fsTracker.emitDiffs(
								fsBefore,
								event => {
									cellResult.statusEvents ??= [];
									upsertStatusEvent(cellResult.statusEvents, event);
									upsertStatusEvent(cellFsEvents, event);
									pushUpdate();
								},
								{ reportedEvents: cellResult.statusEvents, signal: combinedSignal },
							);
						} catch {
							logger.debug("cell file-diff emission failed", { cellIndex: cell.index });
						}
					}
					await recordMutationEvents(fsObservationLedgerFor(session), session.cwd, cellResult.statusEvents);
				}
				const durationMs = Date.now() - startTime;

				const cellDisplayOutputs: EvalDisplayOutput[] = [];
				const cellImageNotes: string[] = [];
				let cellHasMarkdown = false;
				for (const output of result.displayOutputs) {
					if (output.type === "json") {
						jsonOutputs.push(output.data);
						cellDisplayOutputs.push(output);
					}
					if (output.type === "image") {
						const resized = await resizeImage(
							{
								type: "image",
								data: output.data,
								mimeType: output.mimeType,
							},
							{ excludeWebP },
						);
						const image: ImageContent = {
							type: "image",
							data: resized.data,
							mimeType: resized.mimeType,
						};
						images.push(image);
						cellDisplayOutputs.push({
							type: "image",
							data: image.data,
							mimeType: image.mimeType,
						});
						const dimensionNote = formatDimensionNote(resized);
						if (dimensionNote) {
							cellImageNotes.push(`display image ${cellImageNotes.length + 1}: ${dimensionNote}`);
						}
					}
					if (output.type === "status") {
						upsertStatusEvent(statusEvents, output.event);
						upsertStatusEvent(cellStatusEvents, output.event);
					}
					if (output.type === "markdown") {
						cellHasMarkdown = true;
					}
				}

				const stdoutTrimmed = result.output.trim();
				const imageText = cellImageNotes.join("\n");
				const displayText = formatDisplayOutputsForText(cellDisplayOutputs);
				const visibleDisplayText =
					displayText && imageText ? `${displayText}\n\n${imageText}` : displayText || imageText;
				const cellOutput =
					stdoutTrimmed && visibleDisplayText
						? `${stdoutTrimmed}\n\n${visibleDisplayText}`
						: stdoutTrimmed || visibleDisplayText;
				cellResult.output = cellOutput;
				cellResult.exitCode = result.exitCode;
				cellResult.durationMs = durationMs;
				cellResult.execution =
					result.execution ??
					executionMetadataForResult(result, {
						elapsedMs: durationMs,
						timeout: result.timedOut
							? {
									cause: "idle",
									scope: "cell",
									requestedMs: cell.timeoutMs,
									effectiveMs: idleTimeoutMs,
								}
							: undefined,
						summary: result,
					});
				for (const event of cellFsEvents) {
					upsertStatusEvent(statusEvents, event);
				}
				const mergedCellEvents = [...materializedEvents, ...cellStatusEvents, ...cellFsEvents];
				cellResult.statusEvents = mergedCellEvents.length > 0 ? mergedCellEvents : undefined;
				cellResult.hasMarkdown = cellHasMarkdown || undefined;

				if (cellOutput) {
					cellOutputs.push(cellOutput);
					appendTail(cellOutput);
				}

				if (result.cancelled) {
					cellResult.status = "error";
					pushUpdate();
					const errorMsg = result.output || "Command aborted";
					const combinedOutput = cellOutputs.join("\n\n");
					const outputText = combinedOutput || errorMsg;

					const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						execution: buildEvalExecutionMetadata({
							cells: cellResults,
							cancelled: true,
							timedOut: result.timedOut,
							elapsedMs: performance.now() - executionStartedAt,
							summary: summaryForMeta,
						}),
						cells: cellResults,
						jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
						statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
						isError: true,
					};
					if (notice) details.notice = notice;

					return toolResult(details)
						.content([{ type: "text", text: outputText }, ...images])
						.truncationFromSummary(summaryForMeta, { direction: "tail" })
						.error()
						.done();
				}

				if (result.exitCode !== 0 && result.exitCode !== undefined) {
					cellResult.status = "error";
					pushUpdate();
					const combinedOutput = cellOutputs.join("\n\n");
					const outputText = combinedOutput
						? `${combinedOutput}\n\nCommand exited with code ${result.exitCode}`
						: `Command exited with code ${result.exitCode}`;

					const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						execution: buildEvalExecutionMetadata({
							cells: cellResults,
							exitCode: result.exitCode,
							elapsedMs: performance.now() - executionStartedAt,
							summary: summaryForMeta,
						}),
						cells: cellResults,
						jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
						statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
						isError: true,
					};
					if (notice) details.notice = notice;

					return toolResult(details)
						.content([{ type: "text", text: outputText }, ...images])
						.truncationFromSummary(summaryForMeta, { direction: "tail" })
						.error()
						.done();
				}

				cellResult.status = "complete";
				pushUpdate();
			}

			const combinedOutput = cellOutputs.join("\n\n");
			const hasImages = images.length > 0;
			const outputText =
				combinedOutput ||
				(hasImages
					? `(displayed ${images.length} image${images.length === 1 ? "" : "s"}; no text output)`
					: "(no output)");
			const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);

			const details: EvalToolDetails = {
				language: languages[0],
				languages,
				execution: buildEvalExecutionMetadata({
					cells: cellResults,
					exitCode: 0,
					elapsedMs: performance.now() - executionStartedAt,
					summary: summaryForMeta,
				}),
				cells: cellResults,
				jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
				statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
			};
			if (notice) details.notice = notice;

			return toolResult(details)
				.content([{ type: "text", text: outputText }, ...images])
				.truncationFromSummary(summaryForMeta, { direction: "tail" })
				.done();
		} finally {
			if (!outputDumped) {
				try {
					await finalizeOutput();
				} catch {}
			}
		}
	}
}

async function summarizeFinal(
	combinedOutput: string,
	finalizeOutput: () => Promise<OutputSummary | undefined>,
): Promise<OutputSummary> {
	const rawSummary = (await finalizeOutput()) ?? {
		output: "",
		truncated: true,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		collector: { state: "unavailable" as const, error: "Output summary unavailable" },
		outputDisposition: "unavailable" as const,
	};
	const outputLines = combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0;
	const outputBytes = Buffer.byteLength(combinedOutput, "utf-8");
	const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
	const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
	return {
		output: combinedOutput,
		truncated: rawSummary.truncated,
		totalLines: outputLines + missingLines,
		totalBytes: outputBytes + missingBytes,
		outputLines,
		outputBytes,
		artifactId: rawSummary.artifactId,
		columnDroppedBytes: rawSummary.columnDroppedBytes,
		columnTruncatedLines: rawSummary.columnTruncatedLines,
		columnMax: rawSummary.columnMax,
		collector: rawSummary.collector,
		outputDisposition: rawSummary.outputDisposition,
		summarized: rawSummary.summarized,
		actionableDiagnostics: rawSummary.actionableDiagnostics,
	};
}
