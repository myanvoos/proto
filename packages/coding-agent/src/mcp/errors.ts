import { isRecord } from "@oh-my-pi/pi-utils";
import type { JsonRpcError } from "./types";

const SECRET_KEY =
	/(?:authorization|bearer|cookie|secret|passw(?:or)?d|pwd|token|credential|api[-_]?key|private[-_]?key|access[-_]?key|signature)/i;
const JSON_SECRET_VALUE =
	/((?:"[A-Za-z0-9_.-]*(?:authorization|bearer|cookie|secret|passw(?:or)?d|pwd|token|credential|api[-_]?key|private[-_]?key|access[-_]?key|signature)[A-Za-z0-9_.-]*")\s*:\s*)("(?:\\.|[^"\\])*"|[^,\s}\]]+)/gi;
const DIAGNOSTIC_SECRET_VALUE =
	/((?:authorization|api[-_]?key|private[-_]?key|access[-_]?key|token|secret|passw(?:or)?d|pwd|credential)\s*[:=]\s*)[^\s,;}]+/gi;

interface SanitizedValue {
	value: unknown;
	changed: boolean;
}

function sanitizeDiagnosticValue(value: string): string {
	return value
		.replace(/\s*For more information, pass `verbose: true` in the second argument to fetch\(\)\.?/gi, "")
		.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
		.replace(/([?&](?:access[-_]?token|api[-_]?key|key|token|secret|password)=)[^&#\s]+/gi, "$1[redacted]")
		.replace(JSON_SECRET_VALUE, '$1"[redacted]"')
		.replace(DIAGNOSTIC_SECRET_VALUE, "$1[redacted]");
}

function sanitizeData(value: unknown): SanitizedValue {
	if (typeof value === "string") {
		const sanitized = sanitizeDiagnosticValue(value);
		return { value: sanitized, changed: sanitized !== value };
	}
	if (Array.isArray(value)) {
		let changed = false;
		const sanitized = value.map(item => {
			const result = sanitizeData(item);
			if (result.changed) changed = true;
			return result.value;
		});
		return changed ? { value: sanitized, changed } : { value, changed };
	}
	if (!isRecord(value)) return { value, changed: false };

	let changed = false;
	const sanitized: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (SECRET_KEY.test(key)) {
			sanitized[key] = "[redacted]";
			if (item !== "[redacted]") changed = true;
			continue;
		}
		const result = sanitizeData(item);
		sanitized[key] = result.value;
		if (result.changed) changed = true;
	}
	return changed ? { value: sanitized, changed } : { value, changed };
}

function sanitizeJsonDiagnostic(value: string): string {
	try {
		const sanitized = sanitizeData(JSON.parse(value) as unknown);
		return sanitized.changed ? JSON.stringify(sanitized.value) : value;
	} catch {
		return value;
	}
}

/** Redact credential values from MCP diagnostics while preserving safe context. */
export function sanitizeMCPDiagnostic(value: string): string {
	return sanitizeDiagnosticValue(sanitizeJsonDiagnostic(value));
}

export type MCPTransportKind = "http" | "stdio" | "unknown";
export type MCPFailureStage = "connect" | "send" | "receive" | "decode" | "protocol";
export type MCPFailureClass =
	| "connect"
	| "timeout"
	| "eof"
	| "reset"
	| "malformed_response"
	| "json_rpc"
	| "http_status"
	| "closed"
	| "unknown";

interface MCPTransportErrorOptions {
	transport: MCPTransportKind;
	stage: MCPFailureStage;
	failure: MCPFailureClass;
	message: string;
	retryable: boolean;
	requestAccepted?: boolean;
	code?: string | number;
	data?: string;
	traceId?: string;
	cause?: unknown;
}

export class MCPTransportError extends Error {
	readonly transport: MCPTransportKind;
	readonly stage: MCPFailureStage;
	readonly failure: MCPFailureClass;
	readonly retryable: boolean;
	readonly requestAccepted: boolean;
	readonly code: string | number | undefined;
	readonly data: string | undefined;
	readonly traceId: string | undefined;

	constructor(options: MCPTransportErrorOptions) {
		super(sanitizeMCPDiagnostic(options.message).slice(0, 1000), { cause: options.cause });
		this.name = "MCPTransportError";
		this.transport = options.transport;
		this.stage = options.stage;
		this.failure = options.failure;
		this.requestAccepted = options.requestAccepted ?? false;
		this.retryable = options.retryable && !this.requestAccepted;
		this.code = typeof options.code === "string" ? sanitizeMCPDiagnostic(options.code).slice(0, 128) : options.code;
		this.data = options.data;
		this.traceId = safeTraceId(options.traceId);
	}
}

function safeTraceId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text.length <= 128 && /^[A-Za-z0-9._:/-]+$/.test(text) ? text : undefined;
}

export function mcpTraceIdFromHeaders(headers: Headers): string | undefined {
	for (const name of ["traceparent", "x-request-id", "x-trace-id", "x-correlation-id", "cf-ray"]) {
		const traceId = safeTraceId(headers.get(name));
		if (traceId) return traceId;
	}
	return undefined;
}

export function createMCPJsonRpcError(
	transport: MCPTransportKind,
	error: JsonRpcError,
	traceId?: string,
): MCPTransportError {
	let remaining = 100;
	const seen = new WeakSet<object>();
	const visit = (value: unknown, depth: number): unknown => {
		if (remaining-- <= 0 || depth > 5) return "[truncated]";
		if (typeof value === "string") return sanitizeMCPDiagnostic(value).slice(0, 256);
		if (value === null || typeof value === "number" || typeof value === "boolean") return value;
		if (typeof value !== "object") return undefined;
		if (seen.has(value)) return "[circular]";
		seen.add(value);
		if (Array.isArray(value)) return value.slice(0, 30).map(item => visit(item, depth + 1));
		const result: Record<string, unknown> = Object.create(null);
		let entries = 0;
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			if (entries++ >= 30 || remaining <= 0) break;
			const item = (value as Record<string, unknown>)[key];
			if (!traceId && /^(?:trace[-_]?id|request[-_]?id|correlation[-_]?id|traceparent)$/i.test(key))
				traceId = safeTraceId(item);
			result[sanitizeMCPDiagnostic(key).slice(0, 128)] = SECRET_KEY.test(key)
				? "[redacted]"
				: visit(item, depth + 1);
		}
		return result;
	};
	let data: string | undefined;
	try {
		data = JSON.stringify(visit(error.data, 0));
		if (data && data.length > 2000) {
			// JSON escaping can double the preview length; keep the wrapper valid JSON.
			data = JSON.stringify({ truncated: true, preview: data.slice(0, 900) });
		}
	} catch {}
	return new MCPTransportError({
		transport,
		stage: "protocol",
		failure: "json_rpc",
		message: `MCP error ${error.code}: ${error.message}`,
		retryable: false,
		code: error.code,
		data,
		traceId,
	});
}

export function normalizeMCPTransportError(
	error: unknown,
	options: { transport: MCPTransportKind; stage: MCPFailureStage; traceId?: string; requestAccepted?: boolean },
): MCPTransportError {
	if (error instanceof MCPTransportError) {
		if (!options.requestAccepted || error.requestAccepted) return error;
		return new MCPTransportError({ ...error, message: error.message, requestAccepted: true, cause: error });
	}
	const message = sanitizeMCPDiagnostic(error instanceof Error ? error.message : String(error));
	let code: string | number | undefined;
	let source = error;
	for (let depth = 0; depth < 5 && isRecord(source); depth++) {
		if (typeof source.code === "string" || typeof source.code === "number") {
			code = source.code;
			break;
		}
		source = source.cause;
	}
	const signature = `${code ?? ""} ${message}`;
	const status = /^HTTP (\d{3})\b/i.exec(message);
	let failure: MCPFailureClass = "unknown";
	let retryable = false;
	if (status) {
		failure = "http_status";
		code = Number(status[1]);
		retryable = code === 404 || code === 502 || code === 503;
	} else if (/timeout|timed out/i.test(signature)) {
		failure = "timeout";
		retryable = /request timeout/i.test(message);
	} else if (
		error instanceof SyntaxError ||
		/invalid JSON-RPC|malformed|JSON.*(?:parse|parser)|exceeded.*bytes/i.test(message)
	) {
		failure = "malformed_response";
	} else if (/transport (?:not connected|closed)/i.test(message)) {
		failure = "closed";
		retryable = true;
	} else if (
		/ECONNREFUSED|ConnectionRefused|ENETUNREACH|EHOSTUNREACH|fetch failed|network error|not connected/i.test(
			signature,
		)
	) {
		failure = "connect";
		retryable = true;
	} else if (/ECONNRESET/i.test(signature)) {
		failure = "reset";
		retryable = true;
	} else if (/EPIPE|\beof\b|transport closed|socket closed|No response received/i.test(signature)) {
		failure = "eof";
		retryable = true;
	}
	return new MCPTransportError({
		...options,
		stage: failure === "connect" ? "connect" : failure === "malformed_response" ? "decode" : options.stage,
		failure,
		message,
		retryable,
		code,
		cause: error,
	});
}

export function formatMCPToolFailure(error: unknown, serverName: string, toolName: string): string {
	const diagnostic = normalizeMCPTransportError(error, { transport: "unknown", stage: "protocol" });
	const hints: Record<MCPFailureClass, string> = {
		connect: "Check that the MCP server is running and reachable.",
		timeout: "Check server health or increase the MCP timeout; the request outcome is unknown.",
		eof: "Inspect the MCP server logs for an interrupted response.",
		reset: "Check the MCP server logs and network connection.",
		malformed_response: "Inspect the MCP server logs for an invalid JSON-RPC response.",
		json_rpc: "Address the server-reported MCP error before retrying.",
		http_status: "Check the MCP endpoint, server status, and authentication configuration.",
		closed: "Reconnect the MCP server.",
		unknown: "Inspect the MCP server logs and transport configuration.",
	};
	const lines = [
		"MCP failure",
		`server: ${sanitizeMCPDiagnostic(serverName).slice(0, 256)}`,
		`tool: ${sanitizeMCPDiagnostic(toolName).slice(0, 256)}`,
		`transport: ${diagnostic.transport}`,
		`stage: ${diagnostic.stage}`,
		`failure: ${diagnostic.failure}`,
		`retryable: ${diagnostic.retryable ? "yes" : "no"}`,
		`message: ${diagnostic.message}`,
	];
	if (diagnostic.code !== undefined) lines.push(`code: ${diagnostic.code}`);
	if (diagnostic.traceId !== undefined) lines.push(`trace_id: ${diagnostic.traceId}`);
	if (diagnostic.data !== undefined) lines.push(`data: ${diagnostic.data}`);
	lines.push(
		`next: ${hints[diagnostic.failure]}${diagnostic.requestAccepted ? " The server accepted the request; verify its outcome before retrying." : ""}`,
	);
	return lines.join("\n");
}
