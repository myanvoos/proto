import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { Socket, TCPSocketListener } from "bun";
import { resolveFleetRoot } from "../internal-urls";
import type { ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import { isEvalTimeoutControlEvent } from "./bridge-timeout";
import type { EvalCompletionInvocationContext } from "./completion-bridge";
import { formatDisplayOutputsForText } from "./display-text";
import { fsObservationLedgerFor, recordMutationEvents } from "./fs-observations";
import jsBackend from "./js";
import pythonBackend from "./py";
import { defaultEvalSessionId } from "./session-id";
import { findLiteralCompletionCalls } from "./speculation";
import { upsertStatusEvent } from "./status-events";
import type { EvalStatusEvent } from "./types";

export interface KernelShellBridgeOptions {
	toolCallId?: string;
	generation?: number;
}

export interface KernelShellBridgeHandle {
	env: Record<string, string>;
	drainImages(): ImageContent[];
	drainStatusEvents(): EvalStatusEvent[];
	drainJsonOutputs(): unknown[];
	dispose(): void;
}

interface RunContext {
	session: ToolSession;
	images: ImageContent[];
	statusEvents: EvalStatusEvent[];
	jsonOutputs: unknown[];
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
	output: Buffer[];
	outputOffset: number;
	outputBytes: number;
	ending: boolean;
	closed: boolean;
}

interface CellRequest {
	token: string;
	code: string;
	lang: "py" | "js";
	cwd?: string;
}

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 32 * 1024 * 1024;
const OUTPUT_CHUNK_CHARS = 1024 * 1024;

const runs = new Map<string, RunContext>();
let listener: TCPSocketListener<SocketState> | undefined;

export function registerKernelShellRun(
	session: ToolSession,
	onStatusEvent?: (event: EvalStatusEvent) => void,
	completionContext?: KernelShellBridgeOptions,
): KernelShellBridgeHandle {
	const server = ensureListener();
	const token = crypto.randomUUID();
	const context: RunContext = {
		session,
		images: [],
		statusEvents: [],
		jsonOutputs: [],
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
		dispose: () => {
			if (disposed) return;
			disposed = true;
			runs.delete(token);
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
		if (parseLine(line)?.t === "c") socket.data.abort?.abort();
	}
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

function sendOutput(socket: Socket<SocketState>, output: string): void {
	for (let offset = 0; offset < output.length && !socket.data.ending; offset += OUTPUT_CHUNK_CHARS) {
		send(socket, { t: "o", d: output.slice(offset, offset + OUTPUT_CHUNK_CHARS) });
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
			if (state.outputOffset < chunk.length) return;
			state.output.shift();
			state.outputOffset = 0;
		}
		if (state.ending) socket.end();
	} catch {
		closeConnection(socket);
	}
}

function parseRequest(line: string): CellRequest | undefined {
	const parsed = parseLine(line);
	if (!parsed || typeof parsed.token !== "string" || typeof parsed.code !== "string") return undefined;
	if (parsed.lang !== "py" && parsed.lang !== "js") return undefined;
	return {
		token: parsed.token,
		code: parsed.code,
		lang: parsed.lang,
		cwd: typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? parsed.cwd : undefined,
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
		const backend = request.lang === "js" ? jsBackend : pythonBackend;
		const backends = resolveEvalBackends(session);
		const enabled = request.lang === "js" ? backends.js : backends.python;
		const available =
			enabled && (await untilAborted(abort.signal, () => backend.isAvailable(session).catch(() => false)));
		abort.signal.throwIfAborted();
		if (!available) {
			finish(socket, { t: "f" });
			return;
		}
		const candidateFingerprints =
			context.completionContext?.toolCallId && context.completionContext.generation !== undefined
				? findLiteralCompletionCalls(request.lang === "js" ? "js" : "python", request.code).map(
						call => call.fingerprint,
					)
				: [];
		const completionContext: EvalCompletionInvocationContext | undefined =
			context.completionContext?.toolCallId && context.completionContext.generation !== undefined
				? {
						toolCallId: context.completionContext.toolCallId,
						generation: context.completionContext.generation,
						language: request.lang === "js" ? "js" : "python",
						candidateFingerprints,
					}
				: undefined;
		const result = await backend.execute(request.code, {
			cwd: session.cwd,
			runCwd: request.cwd,
			sessionId: session.getEvalSessionId?.() ?? defaultEvalSessionId(session),
			sessionFile: session.getSessionFile?.() ?? undefined,
			kernelOwnerId: session.getEvalKernelOwnerId?.() ?? undefined,
			completionContext,
			signal: abort.signal,
			session,
			reset: false,
			onChunk: chunk => sendOutput(socket, chunk),
			onStatus: event => {
				if (isEvalTimeoutControlEvent(event)) return;
				upsertStatusEvent(cellStatusEvents, event);
				upsertStatusEvent(context.statusEvents, event);
				context.onStatusEvent?.(event);
			},
		});
		for (const output of result.displayOutputs) {
			if (output.type === "image") {
				context.images.push({ type: "image", data: output.data, mimeType: output.mimeType });
			} else if (output.type === "json") {
				context.jsonOutputs.push(output.data);
			}
		}
		const displayText = formatDisplayOutputsForText(result.displayOutputs);
		if (displayText) sendOutput(socket, `${displayText}\n`);
		await recordMutationEvents(fsObservationLedgerFor(session), request.cwd ?? session.cwd, cellStatusEvents);
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
