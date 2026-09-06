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
	buffer: Buffer;
	started: boolean;
	abort?: AbortController;
	output: Buffer[];
	outputOffset: number;
	ending: boolean;
	closed: boolean;
}

interface CellRequest {
	token: string;
	code: string;
	lang: "py" | "js";
	cwd?: string;
}

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
					buffer: Buffer.alloc(0),
					started: false,
					output: [],
					outputOffset: 0,
					ending: false,
					closed: false,
				};
			},
			data(socket, data) {
				socket.data.buffer = Buffer.concat([socket.data.buffer, data]);
				pump(socket);
			},
			drain: flushOutput,
			close: closeConnection,
			error: closeConnection,
		},
	});
	return listener;
}

function pump(socket: Socket<SocketState>): void {
	while (true) {
		const newline = socket.data.buffer.indexOf(0x0a);
		if (newline < 0) return;
		const line = socket.data.buffer.subarray(0, newline).toString("utf-8");
		socket.data.buffer = socket.data.buffer.subarray(newline + 1);
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

function send(socket: Socket<SocketState>, frame: Record<string, unknown>): void {
	if (socket.data.closed || socket.data.ending) return;
	socket.data.output.push(Buffer.from(`${JSON.stringify(frame)}\n`));
	flushOutput(socket);
}

function finish(socket: Socket<SocketState>, frame: Record<string, unknown>): void {
	send(socket, frame);
	socket.data.ending = true;
	flushOutput(socket);
}

function closeConnection(socket: Socket<SocketState>): void {
	if (socket.data.closed) return;
	socket.data.closed = true;
	socket.data.output.length = 0;
	socket.data.buffer = Buffer.alloc(0);
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
			onChunk: chunk => send(socket, { t: "o", d: chunk }),
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
		if (displayText) send(socket, { t: "o", d: `${displayText}\n` });
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
