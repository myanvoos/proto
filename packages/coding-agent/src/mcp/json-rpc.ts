import { isRecord, logger, readSseEvents } from "@oh-my-pi/pi-utils";
import { withTimeoutSignal } from "../utils/fetch-timeout";

const MCP_DEFAULT_TIMEOUT_MS = 60_000;

const SENSITIVE_QUERY_PARAM = /key|token|secret|auth/i;

export function redactUrlForLog(url: string): string {
	try {
		const parsed = new URL(url);
		for (const name of parsed.searchParams.keys()) {
			if (SENSITIVE_QUERY_PARAM.test(name)) parsed.searchParams.set(name, "[redacted]");
		}
		return parsed.toString();
	} catch {
		return url.split("?")[0];
	}
}

function selectJsonRpcResponse(value: unknown, expectedId?: string | number): unknown | null {
	const messages: unknown[] = Array.isArray(value) ? value : [value];
	for (const message of messages) {
		if (
			!isRecord(message) ||
			message.jsonrpc !== "2.0" ||
			"method" in message ||
			!Object.hasOwn(message, "id") ||
			(typeof message.id !== "string" && typeof message.id !== "number") ||
			(expectedId !== undefined && message.id !== expectedId)
		) {
			continue;
		}

		const hasResult = Object.hasOwn(message, "result");
		const hasError = Object.hasOwn(message, "error");
		if (hasResult === hasError) continue;
		if (hasError) {
			const error = message.error;
			if (!isRecord(error) || !Number.isInteger(error.code) || typeof error.message !== "string") continue;
		}
		return message;
	}
	return null;
}

function parseJsonRpcResponse(data: string, expectedId?: string | number): unknown | null {
	try {
		return selectJsonRpcResponse(JSON.parse(data) as unknown, expectedId);
	} catch {
		return null;
	}
}

function readSseEventData(event: string): string | null {
	const data: string[] = [];
	for (let line of event.split("\n")) {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line === "data") {
			data.push("");
		} else if (line.startsWith("data:")) {
			let value = line.slice(5);
			if (value.startsWith(" ")) value = value.slice(1);
			data.push(value);
		}
	}
	return data.length > 0 ? data.join("\n") : null;
}

export function parseSSE(text: string, expectedId?: string | number): unknown {
	for (const event of text.split(/\r?\n\r?\n/)) {
		const data = readSseEventData(event);
		if (data === null || data === "[DONE]") continue;
		const response = parseJsonRpcResponse(data, expectedId);
		if (response !== null) return response;
	}

	return parseJsonRpcResponse(text, expectedId);
}

async function readSseJsonRpcResponse(
	body: ReadableStream<Uint8Array>,
	expectedId: string | number,
	signal: AbortSignal,
): Promise<{ result: unknown | null; responseText: string }> {
	let responseText = "";
	for await (const event of readSseEvents(body, signal)) {
		if (responseText.length < 500) {
			const addition = `${responseText.length > 0 ? "\n\n" : ""}${event.data.slice(0, 500)}`;
			responseText += addition.slice(0, 500 - responseText.length);
		}
		if (event.data === "[DONE]") break;
		if (event.data === "") continue;
		const result = parseJsonRpcResponse(event.data, expectedId);
		if (result !== null) return { result, responseText };
	}
	signal.throwIfAborted();
	return { result: null, responseText };
}

export interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	id: string | number;
	result?: T;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export interface CallMcpOptions {
	signal?: AbortSignal;
}

export async function callMCP<T = unknown>(
	url: string,
	method: string,
	params?: Record<string, unknown>,
	options?: CallMcpOptions,
): Promise<JsonRpcResponse<T>> {
	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method,
		params: params ?? {},
	};

	const signal = withTimeoutSignal(MCP_DEFAULT_TIMEOUT_MS, options?.signal);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const errorMsg = `MCP request failed: ${response.status} ${response.statusText}`;
		logger.error(errorMsg, { url: redactUrlForLog(url), method, params });
		throw new Error(errorMsg);
	}

	const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
	let responseText: string;
	let parsed: unknown | null;
	if (contentType === "text/event-stream" && response.body) {
		({ result: parsed, responseText } = await readSseJsonRpcResponse(response.body, body.id, signal));
	} else {
		responseText = await response.text();
		parsed = parseSSE(responseText, body.id);
	}
	const result = parsed as JsonRpcResponse<T> | null;

	if (!result) {
		logger.error("Failed to parse MCP response", {
			url: redactUrlForLog(url),
			method,
			responseText: responseText.slice(0, 500),
		});
		throw new Error("Failed to parse MCP response");
	}

	return result;
}
