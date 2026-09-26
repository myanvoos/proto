import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { Socket, TCPSocketListener } from "bun";
import { resolveFleetRoot } from "../internal-urls";
import { withExecutionOrigin } from "../jobs/origin";
import type { ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import { readInterpreterSetting } from "./backend-helpers";
import { isEvalTimeoutControlEvent } from "./bridge-timeout";
import type { EvalCompletionInvocationContext } from "./completion-bridge";
import { formatDisplayOutputForText } from "./display-text";
import { fsObservationLedgerFor, recordMutationEvents } from "./fs-observations";
import { bunBackend, namespaceSessionId as jsSessionId, nodeBackend } from "./js";
import { resolveNodeInterpreter } from "./js/node-runtime";
import { kernelLaneSessionId, resolveKernelLaneConfiguration } from "./kernel-control";
import { takeKernelCellTermination } from "./kernel-session-registry";
import { KERNEL_INPUT_CHUNK_BYTES } from "./kernel-streams";
import pythonBackend, { namespaceSessionId as pythonSessionId } from "./py";
import { type PythonCellRoute, routePythonCell } from "./py/cell-interpreter";
import { PythonDisplayBudget } from "./py/display";
import { MIN_KERNEL_PYTHON } from "./py/kernel";
import { findLiteralCompletionCalls } from "./speculation";
import { statusEventKey, upsertStatusEvent } from "./status-events";
import type { EvalDisplayOutput, EvalStatusEvent } from "./types";

export interface KernelShellBridgeOptions {
	lane?: string;
	toolCallId?: string;
	generation?: number;
}

export interface KernelShellBridgeHandle {
	env: Record<string, string>;
	drainImages(): ImageContent[];
	drainStatusEvents(): EvalStatusEvent[];
	drainJsonOutputs(): unknown[];
	queriedExecutions(): boolean;
	/** Why the last kernel cell was cancelled by something other than this run (e.g. a force-close). */
	cellFailure(): string | undefined;
	dispose(): void;
}

interface RunContext {
	queriedExecutions: boolean;
	cellFailure?: string;
	session: ToolSession;
	images: ImageContent[];
	statusEvents: EvalStatusEvent[];
	jsonOutputs: unknown[];
	displayBudget: PythonDisplayBudget;
	active: Set<AbortController>;
	onStatusEvent?: (event: EvalStatusEvent) => void;
	completionContext?: KernelShellBridgeOptions;
}

interface SocketState {
	input: Buffer[];
	inputBytes: number;
	scanChunkIndex: number;
	scanByteOffset: number;
	scannedBytes: number;
	started: boolean;
	abort?: AbortController;
	stdin?: ReadableStreamDefaultController<Uint8Array>;
	inputCredit?: PromiseWithResolvers<void>;
	outputDrain?: PromiseWithResolvers<void>;
	output: Buffer[];
	outputOffset: number;
	outputBytes: number;
	producerBytes: number;
	producerWrites: number;
	ending: boolean;
	closed: boolean;
}

/** Kernel cell languages the shell builtins send: `python`, `node`, and `bun` commands. */
type CellLanguage = "py" | "node" | "bun";

const CELL_BACKENDS = { py: pythonBackend, node: nodeBackend, bun: bunBackend };

/** The kernel session a lane's cells of `lang` run in (the id lifecycle records are keyed by). */
function cellKernelSessionId(lang: CellLanguage, laneSessionId: string): string {
	return lang === "py" ? pythonSessionId(laneSessionId) : jsSessionId(laneSessionId, lang);
}

interface CellRequest {
	token: string;
	code: string;
	lang: CellLanguage;
	cwd?: string;
	shellEnv?: Record<string, string>;
	stdin?: boolean;
	/** The command word as typed (`python`, `.venv/bin/python`). */
	program?: string;
	/** The executable the shell resolves `program` to. */
	interpreter?: string;
}

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 32 * 1024 * 1024;
const OUTPUT_CHUNK_CHARS = 1024 * 1024;
const OUTPUT_HIGH_WATER_BYTES = 256 * 1024;

const runs = new Map<string, RunContext>();
const generations = new WeakMap<ToolSession, LRUCache<string, string>>();
/** Interpreters a session was already told are too old for kernel cells. */
const tooOldNoted = new WeakMap<ToolSession, Set<string>>();

/** The fallthrough frame for a python command no kernel can run; says once per interpreter why. */
function pythonFallThrough(
	session: ToolSession,
	route: PythonCellRoute,
	request: CellRequest,
): Record<string, unknown> {
	if (route.kind !== "external" || !route.tooOld) return { t: "f" };
	const label = request.interpreter ?? request.program ?? "python";
	let noted = tooOldNoted.get(session);
	if (!noted) {
		noted = new Set();
		tooOldNoted.set(session, noted);
	}
	if (noted.has(label)) return { t: "f" };
	noted.add(label);
	return {
		t: "f",
		note: `<kernel> note: ${label} is older than Python ${MIN_KERNEL_PYTHON}, which kernel cells need; it runs as a plain process (no kernel state or helpers)`,
	};
}
let listener: TCPSocketListener<SocketState> | undefined;

export function registerKernelShellRun(
	session: ToolSession,
	onStatusEvent?: (event: EvalStatusEvent) => void,
	completionContext?: KernelShellBridgeOptions,
): KernelShellBridgeHandle {
	const server = ensureListener();
	const token = crypto.randomUUID();
	const context: RunContext = {
		queriedExecutions: false,
		session,
		images: [],
		statusEvents: [],
		jsonOutputs: [],
		displayBudget: new PythonDisplayBudget(),
		active: new Set(),
		onStatusEvent,
		completionContext,
	};
	runs.set(token, context);
	let disposed = false;
	return {
		env: {
			PI_KERNEL_BRIDGE_ADDR: `127.0.0.1:${server.port}`,
			PI_KERNEL_BRIDGE_TOKEN: token,
			PI_KERNEL_FLEET_ROOT: resolveFleetRoot(
				session.localProtocolOptions ?? {
					getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
					getSessionId: () => session.getSessionId?.() ?? null,
				},
			),
		},
		drainImages: () => context.images.splice(0),
		drainStatusEvents: () => context.statusEvents.splice(0),
		drainJsonOutputs: () => context.jsonOutputs.splice(0),
		queriedExecutions: () => context.queriedExecutions,
		cellFailure: () => context.cellFailure,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			runs.delete(token);
			context.displayBudget.release();
			context.images.length = 0;
			context.jsonOutputs.length = 0;
			context.statusEvents.length = 0;
			for (const abort of context.active) abort.abort();
			if (runs.size === 0) {
				const current = listener;
				listener = undefined;
				current?.stop(true);
			}
		},
	};
}

function ensureListener(): TCPSocketListener<SocketState> {
	if (listener) return listener;
	listener = Bun.listen<SocketState>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.data = {
					input: [],
					inputBytes: 0,
					scanChunkIndex: 0,
					scanByteOffset: 0,
					scannedBytes: 0,
					started: false,
					output: [],
					outputOffset: 0,
					outputBytes: 0,
					producerBytes: 0,
					producerWrites: 0,
					ending: false,
					closed: false,
				};
			},
			data(socket, data) {
				if (socket.data.closed || socket.data.ending) return;
				const chunk = Buffer.from(data);
				socket.data.input.push(chunk);
				socket.data.inputBytes += chunk.length;
				pump(socket);
			},
			drain: flushOutput,
			close: closeConnection,
			error: closeConnection,
		},
	});
	return listener;
}

function clearInput(state: SocketState): void {
	state.input.length = 0;
	state.inputBytes = 0;
	state.scanChunkIndex = 0;
	state.scanByteOffset = 0;
	state.scannedBytes = 0;
}

function takeLine(state: SocketState): Buffer | "too-large" | undefined {
	while (state.scanChunkIndex < state.input.length) {
		const chunk = state.input[state.scanChunkIndex]!;
		const newline = chunk.indexOf(0x0a, state.scanByteOffset);
		if (newline < 0) {
			state.scannedBytes += chunk.length - state.scanByteOffset;
			state.scanChunkIndex++;
			state.scanByteOffset = 0;
			if (state.scannedBytes > MAX_FRAME_BYTES) return "too-large";
			continue;
		}

		const lineBytes = state.scannedBytes + newline - state.scanByteOffset;
		if (lineBytes > MAX_FRAME_BYTES) return "too-large";
		let line: Buffer;
		if (state.scanChunkIndex === 0) {
			line = chunk.subarray(0, newline);
		} else {
			line = Buffer.allocUnsafe(lineBytes);
			let offset = 0;
			for (let index = 0; index < state.scanChunkIndex; index++) {
				const queued = state.input[index]!;
				queued.copy(line, offset);
				offset += queued.length;
			}
			chunk.copy(line, offset, 0, newline);
		}

		const remainder = chunk.subarray(newline + 1);
		state.input = remainder.length
			? [remainder, ...state.input.slice(state.scanChunkIndex + 1)]
			: state.input.slice(state.scanChunkIndex + 1);
		state.inputBytes -= lineBytes + 1;
		state.scanChunkIndex = 0;
		state.scanByteOffset = 0;
		state.scannedBytes = 0;
		return line;
	}
	return undefined;
}

function pump(socket: Socket<SocketState>): void {
	while (!socket.data.closed && !socket.data.ending) {
		const next = takeLine(socket.data);
		if (next === undefined) return;
		if (next === "too-large") {
			failConnection(socket, `Kernel shell bridge request frame exceeded ${MAX_FRAME_BYTES} byte limit`);
			return;
		}
		const line = next.toString("utf-8");
		if (!socket.data.started) {
			socket.data.started = true;
			void handleRequest(socket, line);
			continue;
		}
		const frame = parseLine(line);
		if (frame?.t === "c") socket.data.abort?.abort();
		else if (frame?.t === "i") receiveInput(socket, frame);
	}
}

function createInput(socket: Socket<SocketState>): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				socket.data.stdin = controller;
			},
			pull() {
				if (socket.data.closed || socket.data.ending) return;
				const credit = Promise.withResolvers<void>();
				socket.data.inputCredit = credit;
				send(socket, { t: "i" });
				return credit.promise;
			},
			cancel() {
				closeInput(socket.data);
			},
		},
		{ highWaterMark: 0 },
	);
}

function closeInput(state: SocketState, error?: Error): void {
	const controller = state.stdin;
	state.stdin = undefined;
	state.inputCredit?.resolve();
	state.inputCredit = undefined;
	if (error) {
		try {
			controller?.error(error);
		} catch {}
	}
}

function receiveInput(socket: Socket<SocketState>, frame: Record<string, unknown>): void {
	const state = socket.data;
	if (
		!state.stdin ||
		!state.inputCredit ||
		typeof frame.d !== "string" ||
		frame.d.length > Math.ceil(KERNEL_INPUT_CHUNK_BYTES / 3) * 4 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.d) ||
		typeof frame.eof !== "boolean"
	) {
		failConnection(socket, "Invalid or unrequested kernel stdin frame");
		return;
	}
	const bytes = Buffer.from(frame.d, "base64");
	if (bytes.length > KERNEL_INPUT_CHUNK_BYTES || (!frame.eof && bytes.length === 0)) {
		failConnection(socket, "Kernel stdin chunk exceeds credit or is empty without EOF");
		return;
	}
	if (bytes.length) state.stdin.enqueue(bytes);
	if (frame.eof) {
		state.stdin.close();
		state.stdin = undefined;
	}
	state.inputCredit.resolve();
	state.inputCredit = undefined;
}

function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function encodeFrame(frame: Record<string, unknown>): Buffer {
	return Buffer.from(`${JSON.stringify(frame)}\n`);
}

function enqueueUnchecked(state: SocketState, chunk: Buffer): void {
	state.output.push(chunk);
	state.outputBytes += chunk.length;
}

function failConnection(socket: Socket<SocketState>, message: string): void {
	const state = socket.data;
	if (state.closed || state.ending) return;
	state.abort?.abort(new Error(message));
	closeInput(state, new Error(message));
	state.outputDrain?.resolve();
	state.outputDrain = undefined;
	clearInput(state);
	const partialFrame = state.outputOffset > 0 ? state.output[0] : undefined;
	state.output = partialFrame ? [partialFrame] : [];
	state.outputBytes = partialFrame ? partialFrame.length - state.outputOffset : 0;
	state.ending = true;
	enqueueUnchecked(state, encodeFrame({ t: "e", d: `${message}\n` }));
	enqueueUnchecked(state, encodeFrame({ t: "x", c: 1 }));
	flushOutput(socket);
}

function send(socket: Socket<SocketState>, frame: Record<string, unknown>): boolean {
	const state = socket.data;
	if (state.closed || state.ending) return false;
	const encoded = encodeFrame(frame);
	if (encoded.length > MAX_FRAME_BYTES) {
		failConnection(socket, `Kernel shell bridge response frame exceeded ${MAX_FRAME_BYTES} byte limit`);
		return false;
	}
	if (state.outputBytes + encoded.length > MAX_PENDING_OUTPUT_BYTES) {
		failConnection(socket, `Kernel shell bridge pending output exceeded ${MAX_PENDING_OUTPUT_BYTES} byte budget`);
		return false;
	}
	enqueueUnchecked(state, encoded);
	flushOutput(socket);
	return true;
}

function sendOutput(socket: Socket<SocketState>, output: string, stream: "stdout" | "stderr" = "stdout"): void {
	for (let offset = 0; offset < output.length && !socket.data.ending; offset += OUTPUT_CHUNK_CHARS) {
		send(socket, { t: stream === "stderr" ? "e" : "o", d: output.slice(offset, offset + OUTPUT_CHUNK_CHARS) });
	}
}

async function sendBytes(socket: Socket<SocketState>, bytes: Uint8Array, stream: "stdout" | "stderr"): Promise<void> {
	const state = socket.data;
	if (state.closed || state.ending) return;
	if (state.producerBytes + bytes.byteLength > MAX_PENDING_OUTPUT_BYTES || state.producerWrites >= 4096) {
		failConnection(socket, `Kernel shell bridge pending output exceeded ${MAX_PENDING_OUTPUT_BYTES} byte budget`);
		return;
	}
	state.producerBytes += bytes.byteLength;
	state.producerWrites++;
	try {
		for (let offset = 0; offset < bytes.byteLength; offset += KERNEL_INPUT_CHUNK_BYTES) {
			const state = socket.data;
			if (state.closed || state.ending) return;
			const chunk = Buffer.from(bytes.subarray(offset, offset + KERNEL_INPUT_CHUNK_BYTES));
			const text = chunk.toString("utf8");
			const frame = Buffer.from(text).equals(chunk)
				? { t: stream === "stderr" ? "e" : "o", d: text }
				: { t: stream === "stderr" ? "e" : "o", d: chunk.toString("base64"), encoding: "base64" };
			if (!send(socket, frame)) return;
			if (state.outputBytes >= OUTPUT_HIGH_WATER_BYTES) {
				state.outputDrain ??= Promise.withResolvers<void>();
				await state.outputDrain.promise;
			}
		}
	} finally {
		state.producerBytes -= bytes.byteLength;
		state.producerWrites--;
	}
}

function finish(socket: Socket<SocketState>, frame: Record<string, unknown>): void {
	if (!send(socket, frame)) return;
	socket.data.ending = true;
	flushOutput(socket);
}

function closeConnection(socket: Socket<SocketState>): void {
	if (socket.data.closed) return;
	socket.data.closed = true;
	closeInput(socket.data, new Error("Kernel shell input closed"));
	socket.data.outputDrain?.resolve();
	socket.data.outputDrain = undefined;
	socket.data.output.length = 0;
	socket.data.outputBytes = 0;
	clearInput(socket.data);
	socket.data.abort?.abort();
	socket.terminate();
}

function flushOutput(socket: Socket<SocketState>): void {
	const state = socket.data;
	if (state.closed) return;
	try {
		while (state.output.length > 0) {
			const chunk = state.output[0]!;
			const written = socket.write(chunk, state.outputOffset, chunk.length - state.outputOffset);
			if (written < 0) {
				closeConnection(socket);
				return;
			}
			state.outputOffset += written;
			state.outputBytes -= written;
			if (state.outputOffset < chunk.length) break;
			state.output.shift();
			state.outputOffset = 0;
		}
		if (state.outputBytes < OUTPUT_HIGH_WATER_BYTES) {
			state.outputDrain?.resolve();
			state.outputDrain = undefined;
		}
		if (state.ending && state.outputBytes === 0) socket.end();
	} catch {
		closeConnection(socket);
	}
}

function parseRequest(line: string): CellRequest | undefined {
	const parsed = parseLine(line);
	if (!parsed || typeof parsed.token !== "string" || typeof parsed.code !== "string") return undefined;
	if (parsed.lang !== "py" && parsed.lang !== "node" && parsed.lang !== "bun") return undefined;
	if (
		parsed.shellEnv !== undefined &&
		(parsed.shellEnv === null ||
			typeof parsed.shellEnv !== "object" ||
			Array.isArray(parsed.shellEnv) ||
			Object.values(parsed.shellEnv).some(value => typeof value !== "string"))
	)
		return undefined;
	if (parsed.stdin !== undefined && typeof parsed.stdin !== "boolean") return undefined;
	const text = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined;
	return {
		token: parsed.token,
		code: parsed.code,
		lang: parsed.lang,
		shellEnv: parsed.shellEnv as Record<string, string> | undefined,
		stdin: parsed.stdin === true,
		cwd: text(parsed.cwd),
		program: text(parsed.program),
		interpreter: text(parsed.interpreter),
	};
}

async function handleRequest(socket: Socket<SocketState>, line: string): Promise<void> {
	const request = parseRequest(line);
	const context = request ? runs.get(request.token) : undefined;
	if (!request || !context) {
		finish(socket, { t: "f" });
		return;
	}
	const session = context.session;
	const abort = new AbortController();
	socket.data.abort = abort;
	context.active.add(abort);
	// Status events (write/delete hunks, env, agent, …) are surfaced structurally
	// to the bash tool (drainStatusEvents → rendered like an eval cell), not
	// flattened into the stdout byte stream — matching the eval tool, whose
	// model-facing text is stdout only and whose hunks are a TUI affordance.
	const cellStatusEvents: EvalStatusEvent[] = [];
	try {
		const backend = CELL_BACKENDS[request.lang];
		const backends = resolveEvalBackends(session);
		const enabled = request.lang === "py" ? backends.python : backends.js;
		const configuration = resolveKernelLaneConfiguration(
			session,
			request.lang === "py" ? "python" : request.lang,
			context.completionContext?.lane,
		);
		const remoteTarget = configuration?.target !== undefined && configuration.target.kind !== "local";
		// A python command runs on the interpreter the shell would pick for it (see routePythonCell).
		const pythonRoute =
			enabled && request.lang === "py" && !remoteTarget
				? await untilAborted(abort.signal, () =>
						routePythonCell(request, {
							cwd: configuration?.cwd ?? session.cwd,
							laneInterpreter: configuration?.interpreter,
							settingInterpreter: readInterpreterSetting(session, "python.interpreter"),
							signal: abort.signal,
						}),
					)
				: undefined;
		abort.signal.throwIfAborted();
		if (pythonRoute?.kind === "external") {
			finish(socket, pythonFallThrough(session, pythonRoute, request));
			return;
		}
		// Set only when a python command picked a kernel apart from the lane's default one.
		const routedInterpreter = pythonRoute?.kind === "kernel" ? pythonRoute.interpreter : undefined;
		const interpreter = routedInterpreter ?? configuration?.interpreter;
		// An explicitly selected interpreter/remote environment is validated at
		// launch, not against this host's unrelated default Python executable.
		const selectedRuntime = Boolean(interpreter || remoteTarget);
		// `node` runs the Node the cell's own PATH names, as the shell would; with none there, the cell
		// falls through and the builtin reports command-not-found exactly like the shell.
		const available =
			enabled &&
			(selectedRuntime ||
				(request.lang === "node"
					? resolveNodeInterpreter(request.shellEnv, configuration?.cwd ?? request.cwd ?? session.cwd) !==
						undefined
					: await untilAborted(abort.signal, () => backend.isAvailable(session).catch(() => false))));
		abort.signal.throwIfAborted();
		if (!available) {
			finish(socket, { t: "f" });
			return;
		}
		const candidateFingerprints =
			context.completionContext?.toolCallId && context.completionContext.generation !== undefined
				? findLiteralCompletionCalls(backend.id, request.code).map(call => call.fingerprint)
				: [];
		const completionContext: EvalCompletionInvocationContext | undefined =
			context.completionContext?.toolCallId && context.completionContext.generation !== undefined
				? {
						toolCallId: context.completionContext.toolCallId,
						generation: context.completionContext.generation,
						language: backend.id,
						candidateFingerprints,
					}
				: undefined;
		// Displays render into the byte stream as they arrive, in order with stdout/stderr.
		let streamedDisplays = 0;
		let jsonDisplays = 0;
		const renderDisplay = async (output: EvalDisplayOutput): Promise<void> => {
			if (output.type === "markdown" || output.type === "status") return;
			for (const admitted of context.displayBudget.addKernelOutput(output)) {
				if (admitted.type === "image") context.images.push(admitted);
				else if (admitted.type === "json") context.jsonOutputs.push(admitted.data);
				const text = formatDisplayOutputForText(admitted, admitted.type === "json" ? ++jsonDisplays : jsonDisplays);
				if (text) await sendBytes(socket, Buffer.from(`${text}\n`), "stdout");
			}
		};
		const result = await withExecutionOrigin(
			{
				lane: context.completionContext?.lane ?? "main",
				kind: "kernel",
				language: request.lang === "py" ? "python" : request.lang,
			},
			() =>
				backend.execute(request.code, {
					cwd: configuration?.cwd ?? session.cwd,
					runCwd: configuration?.cwd ?? request.cwd,
					interpreter,
					target: configuration?.target,
					shellEnv: request.shellEnv,
					stdin: request.stdin ? createInput(socket) : undefined,
					sessionId: kernelLaneSessionId(session, context.completionContext?.lane),
					sessionFile: session.getSessionFile?.() ?? undefined,
					kernelOwnerId: session.getEvalKernelOwnerId?.() ?? undefined,
					completionContext,
					signal: abort.signal,
					session,
					reset: false,
					onChunk: () => {},
					onBytes: (chunk, stream) => sendBytes(socket, chunk, stream),
					onDisplay: async output => {
						if (output.type === "status") return;
						streamedDisplays++;
						await renderDisplay(output);
					},
					onStatus: event => {
						if (isEvalTimeoutControlEvent(event)) return;
						if (event.op === "execution-query") {
							context.queriedExecutions = true;
							return;
						}
						if (event.op === "kernel-state" && typeof event.generation === "string") {
							let known = generations.get(session);
							if (!known) {
								known = new LRUCache({ max: 32 });
								generations.set(session, known);
							}
							// A lane holds one python kernel per interpreter; each has its own generation.
							const lane = `${request.lang}:${context.completionContext?.lane ?? "main"}`;
							const key = routedInterpreter ? `${lane} (${routedInterpreter})` : lane;
							const previous = known.get(key);
							if (previous && previous !== event.generation)
								sendOutput(
									socket,
									`<kernel> state lost: ${key} restarted; generation ${previous} → ${event.generation}. Earlier variables are gone.\n`,
									"stderr",
								);
							known.set(key, event.generation);
						}
						// File-observation correctness needs only mutation identity, not retained rich hunks.
						if (typeof event.path === "string" && ["write", "delete", "revert"].includes(event.op)) {
							upsertStatusEvent(cellStatusEvents, { op: event.op, path: event.path });
						}
						const previous = context.displayBudget.blocks.at(-1);
						const admitted = context.displayBudget.admitMetadata(event, statusEventKey(event));
						if (admitted) {
							upsertStatusEvent(context.statusEvents, admitted);
							context.onStatusEvent?.(admitted);
						} else {
							const notice = context.displayBudget.blocks.at(-1);
							if (notice?.type === "notice" && notice !== previous) sendOutput(socket, `${notice.text}\n`);
						}
					},
				}),
		);
		// A backend that does not stream displays reports them only in its result.
		for (const output of result.displayOutputs.slice(streamedDisplays)) await renderDisplay(output);
		await recordMutationEvents(fsObservationLedgerFor(session), request.cwd ?? session.cwd, cellStatusEvents);
		if (result.cancelled && !abort.signal.aborted) {
			const termination = takeKernelCellTermination(
				cellKernelSessionId(request.lang, kernelLaneSessionId(session, context.completionContext?.lane)),
			);
			if (termination) {
				const report = `${request.lang}:${context.completionContext?.lane ?? "main"} ${termination}; cell cancelled`;
				context.cellFailure = `kernel ${report}`;
				sendOutput(socket, `<kernel> ${report}\n`, "stderr");
			}
		}
		finish(socket, { t: "x", c: result.cancelled ? 130 : (result.exitCode ?? 0) });
	} catch (err) {
		if (abort.signal.aborted) {
			finish(socket, { t: "x", c: 130 });
			return;
		}
		logger.warn("kernel shell bridge cell failed", { error: err instanceof Error ? err.message : String(err) });
		send(socket, { t: "e", d: `${err instanceof Error ? err.message : String(err)}\n` });
		finish(socket, { t: "x", c: 1 });
	} finally {
		context.active.delete(abort);
	}
}
