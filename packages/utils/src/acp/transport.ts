import { truncate } from "../format";
import type { MaybePromise } from "./protocol";
import type { Stream } from "./stream";

export type JsonRpcId = string | number | null;

export interface AnyRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface AnyNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface ErrorResponse {
	code: number;
	message: string;
	data?: unknown;
}

export type AnyResponse = { jsonrpc: "2.0"; id: JsonRpcId } & ({ result: unknown } | { error: ErrorResponse });

export type AnyMessage = AnyRequest | AnyNotification | AnyResponse;

/**
 * Internal notification a transport emits instead of tearing the stream down
 * when a peer sends a line that is not a JSON-RPC message. The connection
 * answers it with the standard error frame and keeps reading.
 */
export const MALFORMED_MESSAGE_METHOD = "$/malformed_message";

export interface MalformedMessageParams {
	code: number;
	message: string;
	details: string;
	id?: JsonRpcId;
}

export function malformedMessage(params: MalformedMessageParams): AnyNotification {
	return { jsonrpc: "2.0", method: MALFORMED_MESSAGE_METHOD, params };
}

export class RequestError extends Error {
	readonly code: number;

	readonly data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "RequestError";
		this.code = code;
		this.data = data;
	}

	static parseError(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32700, "Parse error", data, additionalMessage);
	}

	static invalidRequest(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32600, "Invalid request", data, additionalMessage);
	}

	static methodNotFound(method: string): RequestError {
		return createStandardError(-32601, "Method not found", { method }, method);
	}

	static invalidParams(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32602, "Invalid params", data, additionalMessage);
	}

	static internalError(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32603, "Internal error", data, additionalMessage);
	}

	/** A failure that is not a protocol error: its first line names the reason, `data.details` keeps the full text. */
	static internalErrorFrom(error: unknown): RequestError {
		const details = error instanceof Error ? error.message : String(error);
		return RequestError.internalError({ details }, conciseErrorReason(details));
	}

	static requestCancelled(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32800, "Request cancelled", data, additionalMessage);
	}

	static authRequired(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32000, "Authentication required", data, additionalMessage);
	}

	static resourceNotFound(uri?: string): RequestError {
		return new RequestError(
			-32002,
			uri === undefined ? "Resource not found" : `Resource not found: ${uri}`,
			uri === undefined ? undefined : { uri },
		);
	}

	/** ACP's answer to a session-scoped request naming a session that does not exist or is not active. */
	static sessionNotFound(sessionId: string): RequestError {
		return createStandardError(-32002, "Resource not found", { sessionId }, `session ${sessionId}`);
	}

	toResult(): { error: ErrorResponse } {
		return { error: this.toErrorResponse() };
	}

	toErrorResponse(): ErrorResponse {
		return { code: this.code, message: this.message, ...(this.data === undefined ? {} : { data: this.data }) };
	}
}

function createStandardError(
	code: number,
	message: string,
	data: unknown,
	additionalMessage: string | undefined,
): RequestError {
	return new RequestError(code, additionalMessage ? `${message}: ${additionalMessage}` : message, data);
}

/** Longest reason an error `message` carries; the full text belongs in `data.details`. */
const MAX_ERROR_REASON_LENGTH = 240;

/** The first non-blank line of a failure's text, bounded: the part of it a client can show as the reason. */
export function conciseErrorReason(text: string): string {
	const trimmed = text.trimStart();
	const lineEnd = trimmed.indexOf("\n");
	return truncate((lineEnd === -1 ? trimmed : trimmed.slice(0, lineEnd)).trimEnd(), MAX_ERROR_REASON_LENGTH);
}

type Dispatcher = (
	method: string,
	params: unknown,
	notification: boolean,
	/** Abort signal for an inbound *request*: fires when the peer cancels it via `$/cancel_request`. */
	signal?: AbortSignal,
) => MaybePromise<unknown>;
type Pending = { resolve(value: unknown): void; reject(reason: unknown): void };
type InboundCanceller = { controller: AbortController; answersItself: boolean };

export interface RpcConnectionOptions {
	/** Only cancel immediately when the dispatcher honors its inbound abort signal. */
	honorsInboundCancellation?: boolean;
	/**
	 * Inbound methods whose handler answers a peer `$/cancel_request` itself, with a valid result once its work has
	 * stopped (an ACP prompt answers with the `cancelled` stop reason), instead of the immediate `-32800`.
	 */
	answersOwnCancellation?: (method: string) => boolean;
}

export interface RequestOptions {
	/** Aborting withdraws the request: the peer is sent `$/cancel_request` and the call rejects with `-32800`. */
	signal?: AbortSignal;
}

// Bounds the clean-EOF inbound drain so `closed` cannot hang on a handler that never settles.
const INBOUND_DRAIN_TIMEOUT_MS = 30_000;

export class RpcConnection {
	#nextId = 0;
	#pending = new Map<JsonRpcId, Pending>();
	#inbound = new Set<Promise<void>>();
	#openInboundIds = new Set<JsonRpcId>();
	/** Abort controller per inbound request, fired by a peer `$/cancel_request`. */
	#inboundCancellers: Map<JsonRpcId, InboundCanceller> | undefined;
	#answersOwnCancellation: (method: string) => boolean;
	#writable: WritableStream<AnyMessage>;
	#writeTail: Promise<void> = Promise.resolve();
	#abort = new AbortController();
	#closed = Promise.withResolvers<void>();
	#dispatcher: Dispatcher;

	constructor(stream: Stream, dispatcher: Dispatcher, options?: RpcConnectionOptions) {
		this.#writable = stream.writable;
		this.#dispatcher = dispatcher;
		this.#inboundCancellers = options?.honorsInboundCancellation ? new Map() : undefined;
		this.#answersOwnCancellation = options?.answersOwnCancellation ?? (() => false);
		void this.#read(stream.readable);
	}

	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	get closed(): Promise<void> {
		return this.#closed.promise;
	}

	request<Response>(method: string, params?: unknown, options?: RequestOptions): Promise<Response> {
		if (this.signal.aborted) return Promise.reject(new Error("Connection closed"));
		const signal = options?.signal;
		if (signal?.aborted) return Promise.reject(RequestError.requestCancelled({ method }));
		const id = this.#nextId++;
		const deferred = Promise.withResolvers<unknown>();
		this.#pending.set(id, deferred);
		if (signal) {
			// The side that sent a request is the one that cancels it. The peer still answers, and that late
			// answer lands on the forgotten id.
			const withdraw = () => {
				if (this.#pending.get(id) !== deferred) return;
				this.#pending.delete(id);
				deferred.reject(RequestError.requestCancelled({ requestId: id }));
				void this.notify("$/cancel_request", { requestId: id }).catch(() => undefined);
			};
			signal.addEventListener("abort", withdraw, { once: true });
			const release = () => signal.removeEventListener("abort", withdraw);
			void deferred.promise.then(release, release);
		}
		void this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch(error => {
			this.#pending.delete(id);
			deferred.reject(error);
		});
		return deferred.promise as Promise<Response>;
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
	}

	close(error?: unknown): void {
		if (this.signal.aborted) return;
		this.#abort.abort(error);
		for (const pending of this.#pending.values()) pending.reject(error ?? new Error("Connection closed"));
		this.#pending.clear();
		this.#closed.resolve();
	}

	#write(message: AnyMessage): Promise<void> {
		const write = this.#writeTail.then(async () => {
			const writer = this.#writable.getWriter();
			try {
				await writer.write(message);
			} finally {
				writer.releaseLock();
			}
		});
		this.#writeTail = write.catch(() => {});
		return write;
	}

	async #read(readable: ReadableStream<AnyMessage>): Promise<void> {
		const reader = readable.getReader();
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				this.#dispatch(next.value);
			}
			// A clean EOF (a scripted client piping requests) still owes answers to the requests it sent.
			await this.#drainInbound();
			this.close();
		} catch (error) {
			this.close(error);
		} finally {
			reader.releaseLock();
		}
	}

	#dispatch(message: AnyMessage): void {
		if ("method" in message && "id" in message) this.#openInboundIds.add(message.id);
		const task = this.#handle(message).catch(error => this.close(error));
		this.#inbound.add(task);
		void task.finally(() => this.#inbound.delete(task));
	}

	async #drainInbound(): Promise<void> {
		if (this.#inbound.size === 0) return;
		const deadline = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => deadline.resolve(true), INBOUND_DRAIN_TIMEOUT_MS);
		const timedOut = await Promise.race([Promise.allSettled(this.#inbound).then(() => false), deadline.promise]);
		clearTimeout(timer);
		if (!timedOut) return;
		const error = RequestError.internalError(undefined, "Inbound request drain timed out").toErrorResponse();
		await Promise.allSettled([...this.#openInboundIds].map(id => this.#respond(id, { error })));
	}

	#respond(id: JsonRpcId, body: { result: unknown } | { error: ErrorResponse }): Promise<void> {
		if (!this.#openInboundIds.delete(id)) return Promise.resolve();
		return this.#write({ jsonrpc: "2.0", id, ...body });
	}

	async #handle(message: AnyMessage): Promise<void> {
		if ("method" in message && message.method === MALFORMED_MESSAGE_METHOD && !("id" in message)) {
			// A garbled line is the peer's problem, not a reason to hang up: answer
			// with the error JSON-RPC prescribes and keep serving the connection.
			const params = message.params as MalformedMessageParams;
			await this.#write({
				jsonrpc: "2.0",
				id: params.id ?? null,
				error: new RequestError(params.code, params.message, { details: params.details }).toErrorResponse(),
			});
			return;
		}
		if ("id" in message && !("method" in message)) {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			if ("error" in message)
				pending.reject(new RequestError(message.error.code, message.error.message, message.error.data));
			else pending.resolve(message.result);
			return;
		}
		if (!("method" in message)) return;
		if (!("id" in message)) {
			if (message.method === "$/cancel_request" && this.#inboundCancellers) {
				this.#cancelInbound((message.params as { requestId?: JsonRpcId } | undefined)?.requestId);
			}
			try {
				await this.#dispatcher(message.method, message.params, true);
			} catch {}
			return;
		}
		const canceller = this.#inboundCancellers ? new AbortController() : undefined;
		if (canceller)
			this.#inboundCancellers?.set(message.id, {
				controller: canceller,
				answersItself: this.#answersOwnCancellation(message.method),
			});
		try {
			const result = await this.#dispatcher(message.method, message.params, false, canceller?.signal);
			await this.#respond(message.id, { result: result ?? {} });
		} catch (error) {
			const protocolError = error instanceof RequestError ? error : RequestError.internalErrorFrom(error);
			await this.#respond(message.id, { error: protocolError.toErrorResponse() });
		} finally {
			this.#inboundCancellers?.delete(message.id);
		}
	}

	#cancelInbound(id: JsonRpcId | undefined): void {
		if (id === undefined) return;
		const canceller = this.#inboundCancellers?.get(id);
		if (canceller) {
			this.#inboundCancellers?.delete(id);
			canceller.controller.abort(RequestError.requestCancelled({ requestId: id }));
			// Its handler stops the work and then answers with a valid result (spec: `$/cancel_request`).
			if (canceller.answersItself) return;
		}
		// Spec: a cancelled request still gets a response. Answer `-32800`
		// here — synchronously with the notification — so the peer is never
		// left waiting on a handler that may never settle. `#respond` closes
		// the id, so a late handler result (a handler that ignored its abort
		// signal) lands in the closed-id no-op instead of answering twice.
		void this.#respond(id, { error: RequestError.requestCancelled({ requestId: id }).toErrorResponse() }).catch(
			() => undefined,
		);
	}
}
