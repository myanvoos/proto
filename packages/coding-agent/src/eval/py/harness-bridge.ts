import { timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { withExecutionOrigin } from "../../jobs/origin";
import type { ToolSession } from "../../tools";
import type { KernelToolRequest } from "../kernel-base";
import { MAX_GRAPH_FRAME_CHARS as MAX_GRAPH_BYTES } from "../state-limits";
import { dispatchPythonHarnessRequest } from "./harness-dispatch";
import type {
	PythonHarnessContext,
	PythonHarnessEvent,
	PythonHarnessRun,
	PythonHarnessRunOptions,
} from "./harness-types";
import { stagePythonRuntimeAssets } from "./runtime-assets";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_RUN_BYTES = 128 * 1024 * 1024;
const MAX_REQUESTS = 4096;
const MAX_ACTIVE_REQUESTS = 32;
const MAX_EVENTS = 256;

function reply(value: unknown, status = 200, limit = MAX_FRAME_BYTES): Response {
	const body = JSON.stringify(value);
	if (Buffer.byteLength(body) > limit) {
		return Response.json(
			{ error: { code: "limit", message: "Python harness response exceeds byte limit" } },
			{ status: 413 },
		);
	}
	return new Response(body, {
		status,
		headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
	});
}

/** One revocable capability per host run; no caller-supplied session or owner identity. */
export async function registerPythonHarnessRun(
	session: ToolSession,
	options: PythonHarnessRunOptions = {},
): Promise<PythonHarnessRun> {
	const root = options.transport === "stdio" ? "" : await stagePythonRuntimeAssets();
	const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	const identity = session.getSessionId?.();
	const owner = session.getEvalKernelOwnerId?.();
	const abort = new AbortController();
	const events: PythonHarnessEvent[] = [];
	const pending = new Set<Promise<void>>();
	let disposed = false;
	let requests = 0;
	let bytes = 0;
	let eventBytes = 0;
	let incomingBytes = 0;
	const context: PythonHarnessContext = {
		session,
		runId: crypto.randomUUID(),
		lane: options.lane ?? "main",
		cwd: path.resolve(session.cwd, options.cwd ?? "."),
		toolCallId: options.toolCallId ?? crypto.randomUUID(),
		kernelId: options.kernelId,
		completionContext: options.completionContext,
		signal: abort.signal,
		emit: event => {
			if (disposed) return;
			const size = Buffer.byteLength(JSON.stringify(event));
			bytes += size;
			if (size > MAX_FRAME_BYTES || bytes > MAX_RUN_BYTES)
				throw new Error("Python harness event byte limit exceeded");
			if (events.length < MAX_EVENTS && eventBytes + size <= MAX_FRAME_BYTES) {
				events.push(event);
				eventBytes += size;
			}
			options.emit?.(event);
		},
	};
	const assertActive = (): void => {
		if (
			disposed ||
			abort.signal.aborted ||
			session.isDisposed?.() ||
			session.getSessionId?.() !== identity ||
			session.getEvalKernelOwnerId?.() !== owner
		)
			throw new Error("Python harness capability is invalid or revoked");
	};
	const dispatch = async (
		request: KernelToolRequest,
		signal: AbortSignal,
		onBytes?: PythonHarnessContext["onBytes"],
	): Promise<unknown> => {
		assertActive();
		signal.throwIfAborted();
		if (
			typeof request.name !== "string" ||
			!isRecord(request.args) ||
			(request.cwd !== undefined &&
				(typeof request.cwd !== "string" || !path.isAbsolute(request.cwd) || request.cwd.includes("\0")))
		)
			throw new Error("Invalid Python harness request");
		if (request.name === "_detect") {
			const info = request.args;
			if (
				typeof info.pid !== "number" ||
				!Number.isSafeInteger(info.pid) ||
				info.pid <= 0 ||
				!Array.isArray(info.argv) ||
				!info.argv.every(arg => typeof arg === "string") ||
				typeof info.cwd !== "string" ||
				typeof info.executable !== "string"
			)
				throw new Error("Invalid Python detection metadata");
			context.emit?.({
				type: "detection",
				pid: info.pid,
				argv: info.argv,
				cwd: info.cwd,
				executable: info.executable,
			});
			return null;
		}
		const invocation: PythonHarnessContext = {
			...context,
			cwd: request.cwd ?? context.cwd,
			signal,
			onBytes,
		};
		const result = await withExecutionOrigin({ lane: context.lane, kind: "kernel", language: "python" }, () =>
			dispatchPythonHarnessRequest(invocation, request.name, request.args),
		);
		assertActive();
		signal.throwIfAborted();
		return result;
	};
	const server =
		options.transport === "stdio"
			? undefined
			: Bun.serve({
					hostname: "127.0.0.1",
					port: 0,
					maxRequestBodySize: MAX_GRAPH_BYTES,
					idleTimeout: 0,
					fetch(request) {
						const supplied = Buffer.from(request.headers.get("Authorization") ?? "");
						const expected = Buffer.from(`Bearer ${token}`);
						if (
							disposed ||
							session.isDisposed?.() ||
							session.getSessionId?.() !== identity ||
							session.getEvalKernelOwnerId?.() !== owner ||
							request.headers.has("origin") ||
							supplied.length !== expected.length ||
							!timingSafeEqual(supplied, expected)
						) {
							return reply(
								{
									error: {
										code: "authentication",
										message: "Python harness capability is invalid or revoked",
									},
								},
								403,
							);
						}
						if (request.method !== "POST" || new URL(request.url).pathname !== "/request")
							return new Response(null, { status: 404 });
						if (++requests > MAX_REQUESTS || pending.size >= MAX_ACTIVE_REQUESTS) {
							return reply({ error: { code: "limit", message: "Python harness request limit exceeded" } }, 429);
						}
						const declaredLength = request.headers.get("content-length");
						const reservation = declaredLength === null ? MAX_GRAPH_BYTES : Number(declaredLength);
						if (
							!Number.isSafeInteger(reservation) ||
							reservation < 0 ||
							reservation > MAX_GRAPH_BYTES ||
							bytes + incomingBytes + reservation > MAX_RUN_BYTES
						) {
							return reply(
								{ error: { code: "limit", message: "Python harness incoming byte limit exceeded" } },
								413,
							);
						}
						incomingBytes += reservation;
						let bodyAdmitted = true;
						const response = Promise.withResolvers<Response>();
						let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
						let drain: PromiseWithResolvers<void> | undefined;
						const callAbort = new AbortController();
						const signal = AbortSignal.any([abort.signal, request.signal, callAbort.signal]);
						let outputBytes = 0;
						const sendFrame = async (frame: unknown): Promise<void> => {
							signal.throwIfAborted();
							const encoded = Buffer.from(`${JSON.stringify(frame)}\n`);
							outputBytes += encoded.length;
							bytes += encoded.length;
							if (encoded.length > MAX_FRAME_BYTES || outputBytes > MAX_RUN_BYTES || bytes > MAX_RUN_BYTES)
								throw new Error("Python harness stream byte limit exceeded");
							streamController!.enqueue(encoded);
							if ((streamController!.desiredSize ?? 0) <= 0) {
								drain ??= Promise.withResolvers<void>();
								await drain.promise;
							}
						};
						const task = (async (): Promise<void> => {
							try {
								const body = await request.text();
								const bodyBytes = Buffer.byteLength(body);
								incomingBytes -= reservation;
								bodyAdmitted = false;
								if (bodyBytes > reservation || bodyBytes > MAX_GRAPH_BYTES)
									throw new Error("Python harness request exceeds byte limit");
								bytes += bodyBytes;
								if (bytes > MAX_RUN_BYTES) throw new Error("Python harness run byte limit exceeded");
								signal.throwIfAborted();
								const value: unknown = JSON.parse(body);
								if (
									!isRecord(value) ||
									Object.keys(value).some(key => !["name", "args", "cwd", "stream"].includes(key)) ||
									typeof value.name !== "string" ||
									!isRecord(value.args) ||
									(value.stream !== undefined && typeof value.stream !== "boolean") ||
									(value.cwd !== undefined &&
										(typeof value.cwd !== "string" ||
											!path.isAbsolute(value.cwd) ||
											value.cwd.includes("\0")))
								)
									throw new Error("Invalid Python harness request");
								const frameLimit =
									value.name === "store.get_graph" || value.name === "store.put_graph"
										? MAX_GRAPH_BYTES
										: MAX_FRAME_BYTES;
								if (bodyBytes > frameLimit) throw new Error("Python harness request exceeds byte limit");
								const invocation: PythonHarnessContext = {
									...context,
									cwd: typeof value.cwd === "string" ? value.cwd : context.cwd,
									signal,
								};
								if (value.stream === true) {
									const stream = new ReadableStream<Uint8Array>(
										{
											start(controller) {
												streamController = controller;
											},
											pull() {
												drain?.resolve();
												drain = undefined;
											},
											cancel() {
												callAbort.abort();
												drain?.resolve();
											},
										},
										{ highWaterMark: 256 * 1024, size: chunk => chunk?.byteLength ?? 0 },
									);
									invocation.onBytes = (chunk, stream) =>
										sendFrame({ stream, data: Buffer.from(chunk).toString("base64") });
									response.resolve(
										new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } }),
									);
								}
								const result = await dispatch(
									{
										name: value.name,
										args: value.args,
										cwd: typeof value.cwd === "string" ? value.cwd : undefined,
									},
									signal,
									invocation.onBytes,
								);
								signal.throwIfAborted();
								if (streamController) {
									await sendFrame({ value: result ?? null });
									streamController.close();
								} else {
									const resultResponse = reply({ value: result ?? null }, 200, frameLimit);
									const responseBytes = Number(resultResponse.headers.get("content-length") ?? 0);
									if (bytes + responseBytes > MAX_RUN_BYTES)
										throw new Error("Python harness run byte limit exceeded");
									bytes += responseBytes;
									response.resolve(resultResponse);
								}
							} catch (error) {
								const failure = {
									error: {
										code: signal.aborted ? "cancelled" : "request",
										message: error instanceof Error ? error.message : String(error),
									},
								};
								if (streamController) {
									try {
										await sendFrame(failure);
										streamController.close();
									} catch {
										try {
											streamController.error(error);
										} catch {}
									}
								} else response.resolve(reply(failure, 400));
							}
						})();
						const wakeDrain = () => drain?.resolve();
						signal.addEventListener("abort", wakeDrain, { once: true });
						pending.add(task);
						void task.finally(() => {
							if (bodyAdmitted) incomingBytes -= reservation;
							pending.delete(task);
							signal.removeEventListener("abort", wakeDrain);
						});
						return response.promise;
					},
				});
	const revoke = () => {
		if (disposed) return;
		disposed = true;
		abort.abort(new Error("Python harness run completed or aborted"));
		void server?.stop(true);
	};
	const unregister = session.registerDisposeCallback?.(revoke);
	options.signal?.addEventListener("abort", revoke, { once: true });
	if (options.signal?.aborted) revoke();
	const inheritedPath = options.env?.PYTHONPATH ?? process.env.PYTHONPATH;
	return {
		env: server
			? {
					PI_PYTHON_HARNESS_URL: `http://127.0.0.1:${server.port}/request`,
					PI_PYTHON_HARNESS_TOKEN: token,
					...(options.shell
						? { PI_PYTHON_HARNESS_PATH: root }
						: {
								PYTHONPATH: inheritedPath
									? `${root}${process.platform === "win32" ? ";" : ":"}${inheritedPath}`
									: root,
							}),
				}
			: {},
		events,
		async request(request, callerSignal) {
			assertActive();
			if (++requests > MAX_REQUESTS || pending.size >= MAX_ACTIVE_REQUESTS)
				throw new Error("Python harness request limit exceeded");
			const limit =
				request.name === "store.get_graph" || request.name === "store.put_graph"
					? MAX_GRAPH_BYTES
					: MAX_FRAME_BYTES;
			const size = Buffer.byteLength(JSON.stringify(request));
			if (size > limit || bytes + incomingBytes + size > MAX_RUN_BYTES)
				throw new Error("Python harness request exceeds byte limit");
			bytes += size;
			const signal = AbortSignal.any([abort.signal, ...(callerSignal ? [callerSignal] : [])]);
			const task = (async () => {
				const value = await dispatch(request, signal);
				const responseBytes = Buffer.byteLength(JSON.stringify({ value: value ?? null }));
				if (responseBytes > limit || bytes + incomingBytes + responseBytes > MAX_RUN_BYTES)
					throw new Error("Python harness response exceeds byte limit");
				bytes += responseBytes;
				return value;
			})();
			const settled = task.then(
				() => {},
				() => {},
			);
			pending.add(settled);
			try {
				return await task;
			} finally {
				pending.delete(settled);
			}
		},
		async dispose() {
			revoke();
			options.signal?.removeEventListener("abort", revoke);
			unregister?.();
			await server?.stop(true);
			await Promise.allSettled([...pending]);
		},
	};
}
