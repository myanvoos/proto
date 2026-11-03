import { isRecord } from "./type-guards";

const ESC_CHAR = "\x1b";

const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

const REPLACEMENT_CHAR = "\ufffd";

export function sanitizeText(text: string): string {
	const wellFormed = text.toWellFormed();
	if (wellFormed !== text) {
		return sanitizeWellFormedText(wellFormed.replaceAll(REPLACEMENT_CHAR, ""));
	}
	return sanitizeWellFormedText(text);
}

const ALL_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Strip every C0 control, DEL, and C1 control (U+0000-U+001F, U+007F,
 * U+0080-U+009F). Unlike sanitizeText this also removes tab and newline; use
 * for protocol payloads (terminal titles, notifications) and single-line
 * render fields.
 */
export function stripControlChars(text: string): string {
	return text.replace(ALL_CONTROL_RE, "");
}

function sanitizeWellFormedText(text: string): string {
	CONTROL_RE.lastIndex = 0;
	if (CONTROL_RE.exec(text) === null) return text;

	const stripped = text.indexOf(ESC_CHAR) === -1 ? text : Bun.stripANSI(text);
	CONTROL_RE.lastIndex = 0;
	return stripped.replace(CONTROL_RE, "");
}

export function escapeXmlText(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else output += char;
	}
	return output;
}

export function escapeXmlAttribute(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62 || char === 34) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else if (char === '"') output += "&quot;";
		else output += char;
	}
	return output;
}

/**
 * Apply {@link sanitizeText} to every string value inside a JSON-shaped value.
 * Only plain objects and arrays are walked; class instances, typed arrays, and
 * cyclic back-references pass through untouched. Object keys are kept as-is.
 *
 * Returns the input reference when nothing changed, so reference-keyed caches
 * stay warm; changed containers are copied and the input is never mutated.
 * Display layers use it on structured payloads (tool-result `details`) whose
 * strings carry untrusted file or command text.
 */
export function sanitizeTextDeep(value: unknown): unknown {
	return sanitizeValue(value, new Set());
}

function sanitizeValue(value: unknown, ancestors: Set<object>): unknown {
	if (typeof value === "string") return sanitizeText(value);
	if (typeof value !== "object" || value === null || ancestors.has(value)) return value;
	if (Array.isArray(value)) {
		ancestors.add(value);
		let copy: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const item: unknown = value[index];
			const clean = sanitizeValue(item, ancestors);
			if (clean !== item) {
				copy ??= value.slice();
				copy[index] = clean;
			}
		}
		ancestors.delete(value);
		return copy ?? value;
	}
	const proto: unknown = Object.getPrototypeOf(value);
	if (!isRecord(value) || (proto !== Object.prototype && proto !== null)) return value;
	ancestors.add(value);
	let copy: Record<string, unknown> | undefined;
	for (const key in value) {
		const item = value[key];
		const clean = sanitizeValue(item, ancestors);
		if (clean !== item) {
			copy ??= { ...value };
			copy[key] = clean;
		}
	}
	ancestors.delete(value);
	return copy ?? value;
}
