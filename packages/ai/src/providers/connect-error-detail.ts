import { truncate } from "@oh-my-pi/pi-utils";

const GENERIC_CONNECT_ERROR_MESSAGES = new Set(["", "error", "unknown", "unknown error", "internal", "internal error"]);

const MAX_EXTRA_DETAIL_CHARS = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string | undefined {
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text || undefined;
	} catch {
		return undefined;
	}
}

export function summarizeConnectErrorDetails(details: unknown): string | undefined {
	if (!Array.isArray(details) || details.length === 0) return undefined;
	const parts: string[] = [];
	for (const entry of details) {
		if (!isRecord(entry)) continue;
		const type = typeof entry.type === "string" && entry.type ? entry.type : undefined;
		const debug = entry.debug !== undefined ? safeJson(entry.debug) : undefined;
		const value = entry.value !== undefined ? safeJson(entry.value) : undefined;
		const diagnostic = debug ?? value;
		if (type && diagnostic) parts.push(`${type}: ${diagnostic}`);
		else if (type) parts.push(type);
		else if (diagnostic) parts.push(diagnostic);
	}
	if (parts.length === 0) return undefined;
	return truncate(parts.join("; "), MAX_EXTRA_DETAIL_CHARS);
}

export function formatConnectEndStreamError(error: unknown): string {
	const record = isRecord(error) ? error : {};
	const code = typeof record.code === "string" && record.code ? record.code : "unknown";
	const message = typeof record.message === "string" ? record.message : "";
	const detail = summarizeConnectErrorDetails(record.details);
	const parts: string[] = [`Connect error ${code}: ${message || "Unknown error"}`];
	if (detail) parts.push(`[details: ${detail}]`);
	else if (GENERIC_CONNECT_ERROR_MESSAGES.has(message.trim().toLowerCase())) {
		const extras: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(record)) {
			if (key === "code" || key === "message") continue;
			extras[key] = value;
		}
		const raw = Object.keys(extras).length > 0 ? safeJson(extras) : undefined;
		if (raw && raw !== "{}") parts.push(`[trailer: ${truncate(raw, MAX_EXTRA_DETAIL_CHARS)}]`);
	}
	return parts.join(" ");
}
