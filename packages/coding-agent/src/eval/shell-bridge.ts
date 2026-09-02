import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { Socket, TCPSocketListener } from "bun";
import { resolveFleetRoot } from "../internal-urls";
import type { ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import { isEvalTimeoutControlEvent } from "./bridge-timeout";
import { formatDisplayOutputsForText } from "./display-text";
import { fsObservationLedgerFor, recordMutationEvents } from "./fs-observations";
import jsBackend from "./js";
import pythonBackend from "./py";
import { defaultEvalSessionId } from "./session-id";
import type { EvalStatusEvent } from "./types";

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
}

interface SocketState {
	buffer: Buffer;
	started: boolean;
	abort?: AbortController;
}

interface CellRequest {
	token: string;
	code: string;
	lang: "py" | "js";
	cwd?: string;
}

const runs = new Map<string, RunContext>();
let listener: TCPSocketListener<SocketState> | undefined;

export function registerKernelShellRun(session: ToolSession): KernelShellBridgeHandle {
	const server = ensureListener();
	const token = crypto.randomUUID();
	const context: RunContext = { session, images: [], statusEvents: [], jsonOutputs: [], active: new Set() };
	runs.set(token, context);
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
			runs.delete(token);
			for (const abort of context.active) abort.abort();
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
				socket.data = { buffer: Buffer.alloc(0), started: false };
			},
			data(socket, data) {
				socket.data.buffer = Buffer.concat([socket.data.buffer, data]);
				pump(socket);
			},
			close(socket) {
				socket.data.abort?.abort();
			},
			error(socket) {
				socket.data.abort?.abort();
			},
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
	try {
		socket.write(`${JSON.stringify(frame)}\n`);
	} catch {}
}

function finish(socket: Socket<SocketState>, frame: Record<string, unknown>): void {
	send(socket, frame);
	try {
		socket.end();
	} catch {}
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
	const backend = request.lang === "js" ? jsBackend : pythonBackend;
	const backends = resolveEvalBackends(context.session);
	const enabled = request.lang === "js" ? backends.js : backends.python;
	if (!enabled || !(await backend.isAvailable(context.session).catch(() => false))) {
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
		const result = await backend.execute(request.code, {
			cwd: session.cwd,
			runCwd: request.cwd,
			sessionId: session.getEvalSessionId?.() ?? defaultEvalSessionId(session),
			sessionFile: session.getSessionFile?.() ?? undefined,
			kernelOwnerId: session.getEvalKernelOwnerId?.() ?? undefined,
			signal: abort.signal,
			session,
			reset: false,
			onChunk: chunk => send(socket, { t: "o", d: chunk }),
			onStatus: event => {
				if (isEvalTimeoutControlEvent(event)) return;
				cellStatusEvents.push(event);
				context.statusEvents.push(event);
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
		logger.warn("kernel shell bridge cell failed", { error: err instanceof Error ? err.message : String(err) });
		send(socket, { t: "e", d: `${err instanceof Error ? err.message : String(err)}\n` });
		finish(socket, { t: "x", c: 1 });
	} finally {
		context.active.delete(abort);
	}
}
