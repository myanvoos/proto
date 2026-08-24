/**
 * Search query language for the agents view, ported from prime-agent's
 * session-view-search.ts: `re:` regex mode, quoted phrases, and fuzzy tokens
 * scored with the TUI's fuzzy matcher.
 */

export interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	/** If set, parsing failed and the query should be treated as non-matching. */
	error?: string;
}

export interface MatchResult {
	matches: boolean;
	/** Lower is better; only meaningful when matches === true */
	score: number;
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Join arbitrary session fields into the common search corpus. */
export function createSessionSearchText(parts: readonly (string | undefined | null)[]): string {
	return parts.filter(part => typeof part === "string" && part.length > 0).join(" ");
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	// Regex mode: re:<pattern>
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	const flush = (kind: "fuzzy" | "phrase"): void => {
		const v = buf.trim();
		buf = "";
		if (!v) return;
		tokens.push({ kind, value: v });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map(t => t.trim())
				.filter(t => t.length > 0)
				.map(t => ({ kind: "fuzzy" as const, value: t })),
			regex: null,
		};
	}

	flush(inQuote ? "phrase" : "fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

/**
 * Strict fuzzy ceiling for accepting a token, ported from prime-agent's
 * session-view-search (STRICT_FUZZY_MAX_TOKEN_SCORE).
 */
const STRICT_FUZZY_MAX_TOKEN_SCORE = 25;

/**
 * Fuzzy scorer ported verbatim from prime-agent's pi-tui `fuzzyMatch`
 * (in-order subsequence, word-boundary/consecutive/exact bonuses,
 * alphanumeric-swap fallback). The scoring scale is what
 * {@link STRICT_FUZZY_MAX_TOKEN_SCORE} is calibrated against; the shared
 * @oh-my-pi/pi-tui matcher uses a different word-local scale and cannot be
 * substituted without changing which sessions match.
 */
function primeFuzzyMatch(query: string, text: string): MatchResult {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const matchQuery = (normalizedQuery: string): MatchResult => {
		if (normalizedQuery.length === 0) {
			return { matches: true, score: 0 };
		}

		if (normalizedQuery.length > textLower.length) {
			return { matches: false, score: 0 };
		}

		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;

		for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
			if (textLower[i] === normalizedQuery[queryIndex]) {
				const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1] ?? "");

				if (lastMatchIndex === i - 1) {
					consecutiveMatches++;
					score -= consecutiveMatches * 5;
				} else {
					consecutiveMatches = 0;
					if (lastMatchIndex >= 0) {
						score += (i - lastMatchIndex - 1) * 2;
					}
				}

				if (isWordBoundary) {
					score -= 10;
				}

				score += i * 0.1;

				lastMatchIndex = i;
				queryIndex++;
			}
		}

		if (queryIndex < normalizedQuery.length) {
			return { matches: false, score: 0 };
		}

		if (normalizedQuery === textLower) {
			score -= 100;
		}

		return { matches: true, score };
	};

	const primaryMatch = matchQuery(queryLower);
	if (primaryMatch.matches) {
		return primaryMatch;
	}

	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";

	if (!swappedQuery) {
		return primaryMatch;
	}

	const swappedMatch = matchQuery(swappedQuery);
	if (!swappedMatch.matches) {
		return primaryMatch;
	}

	return { matches: true, score: swappedMatch.score + 5 };
}

/** Match a precomputed search corpus using the query language. */
export function matchSearchText(text: string, parsed: ParsedSearchQuery): MatchResult {
	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		const idx = text.search(parsed.regex);
		if (idx < 0) return { matches: false, score: 0 };
		return { matches: true, score: idx * 0.1 };
	}

	if (parsed.tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	let totalScore = 0;
	const normalizedText = normalizeWhitespaceLower(text);

	for (const token of parsed.tokens) {
		const needle = normalizeWhitespaceLower(token.value);
		if (!needle) continue;
		const idx = normalizedText.indexOf(needle);
		if (idx >= 0) {
			totalScore += idx * 0.1;
			continue;
		}
		if (token.kind === "phrase") return { matches: false, score: 0 };
		const m = primeFuzzyMatch(token.value, text);
		if (!m.matches || m.score > STRICT_FUZZY_MAX_TOKEN_SCORE) return { matches: false, score: 0 };
		totalScore += m.score;
	}

	return { matches: true, score: totalScore };
}

export function matchesSearchText(text: string, query: string): boolean {
	const parsed = parseSearchQuery(query);
	return !parsed.error && matchSearchText(text, parsed).matches;
}
