import { isRecord } from "@oh-my-pi/pi-utils";

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
