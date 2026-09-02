export function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

export interface BomResult {
	bom: string;

	text: string;
}

export function stripBom(content: string): BomResult {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

const UNICODE_REPLACEMENTS: [RegExp, string][] = [
	[/[\u2010-\u2015\u2212]/g, "-"],

	[/[\u2018-\u201B]/g, "'"],

	[/[\u201C-\u201F]/g, '"'],

	[/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " "],

	[/\u2260/g, "!="],

	[/\u00BD/g, "1/2"],

	[/[\u200B-\u200D\uFEFF]/g, ""],
];

export function normalizeUnicode(s: string): string {
	let result = s.trim();
	for (const [pattern, replacement] of UNICODE_REPLACEMENTS) {
		result = result.replace(pattern, replacement);
	}
	return result.normalize("NFC");
}
