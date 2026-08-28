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
		return new RequestError(-32601, `"Method not found": ${method}`, { method });
	}

	static invalidParams(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32602, "Invalid params", data, additionalMessage);
	}

	static internalError(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32603, "Internal error", data, additionalMessage);
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

type Dispatcher = (method: string, params: unknown, notification: boolean) => MaybePromise<unknown>;
type Pending = { resolve(value: unknown): void; reject(reason: unknown): void };

export class RpcConnection {
	#nextId = 0;
	#pending = new Map<JsonRpcId, Pending>();
	#writable: WritableStream<AnyMessage>;
	#writeTail: Promise<void> = Promise.resolve();
	#abort = new AbortController();
	#closed = Promise.withResolvers<void>();
	#dispatcher: Dispatcher;

	constructor(stream: Stream, dispatcher: Dispatcher) {
		this.#writable = stream.writable;
		this.#dispatcher = dispatcher;
		void this.#read(stream.readable);
	}

	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	get closed(): Promise<void> {
		return this.#closed.promise;
	}

	request<Response>(method: string, params?: unknown): Promise<Response> {
		if (this.signal.aborted) return Promise.reject(new Error("Connection closed"));
		const id = this.#nextId++;
		const deferred = Promise.withResolvers<unknown>();
		this.#pending.set(id, deferred);
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
				void this.#handle(next.value).catch(error => this.close(error));
			}
			this.close();
		} catch (error) {
			this.close(error);
		} finally {
			reader.releaseLock();
		}
	}

	async #handle(message: AnyMessage): Promise<void> {
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
			try {
				await this.#dispatcher(message.method, message.params, true);
			} catch {}
			return;
		}
		try {
			const result = await this.#dispatcher(message.method, message.params, false);
			await this.#write({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
		} catch (error) {
			const protocolError =
				error instanceof RequestError
					? error
					: RequestError.internalError({ details: error instanceof Error ? error.message : String(error) });
			await this.#write({ jsonrpc: "2.0", id: message.id, error: protocolError.toErrorResponse() });
		}
	}
}
