import { type AuthStorage, type FetchImpl, withAuth } from "@oh-my-pi/pi-ai";
import { withHardTimeout } from "./search/providers/utils";

const KAGI_SEARCH_URL = "https://kagi.com/api/v1/search";

export interface KagiSearchRequest {
	query: string;

	workflow?: string;

	limit?: number;

	lens?: string;

	filters?: {
		after?: string;
		before?: string;
	};
}

interface KagiSearchResultItem {
	url: string;
	title: string;
	snippet?: string;

	time?: string;

	image?: { url: string; height?: number; width?: number };

	props?: Record<string, unknown>;
}

interface KagiSearchData {
	search?: KagiSearchResultItem[];
	video?: KagiSearchResultItem[];
	news?: KagiSearchResultItem[];
	infobox?: KagiSearchResultItem[];
	adjacent_question?: KagiSearchResultItem[];
	related_search?: KagiSearchResultItem[];
	direct_answer?: KagiSearchResultItem[];
}

interface KagiErrorEntry {
	code?: number;
	url?: string;
	message?: string;
	msg?: string;
	location?: string;
}

interface KagiSearchResponse {
	meta?: {
		trace?: string;
		id?: string;
		ms?: number;
	};
	data?: KagiSearchData;
	error?: KagiErrorEntry[];
}

interface KagiErrorResponse {
	meta?: Record<string, unknown>;
	error?: string | KagiErrorEntry[];
	message?: string;
	detail?: string;
}

export class KagiApiError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "KagiApiError";
		this.statusCode = statusCode;
	}
}

function extractKagiErrorMessage(payload: unknown): string | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const record = payload as Record<string, unknown>;

	for (const value of [record.message, record.detail]) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}

	for (const errors of [record.error, record.errors]) {
		if (typeof errors === "string" && errors.trim().length > 0) {
			return errors.trim();
		}
		if (!Array.isArray(errors)) continue;
		for (const entry of errors) {
			if (!entry || typeof entry !== "object") continue;
			const e = entry as Record<string, unknown>;
			for (const value of [e.message, e.msg, e.code]) {
				if (
					(typeof value === "string" && value.trim().length > 0) ||
					(typeof value === "number" && Number.isFinite(value))
				) {
					return String(value).trim();
				}
			}
		}
	}

	return null;
}

function createKagiApiError(statusCode: number, detail?: string): KagiApiError {
	return new KagiApiError(
		detail ? `Kagi API error (${statusCode}): ${detail}` : `Kagi API error (${statusCode})`,
		statusCode,
	);
}

function parseKagiErrorResponse(statusCode: number, responseText: string): KagiApiError {
	const trimmed = responseText.trim();
	if (trimmed.length === 0) {
		return createKagiApiError(statusCode);
	}

	try {
		const payload = JSON.parse(trimmed) as KagiErrorResponse;
		return createKagiApiError(statusCode, extractKagiErrorMessage(payload) ?? trimmed);
	} catch {
		return createKagiApiError(statusCode, trimmed);
	}
}

function parseKagiSuccessResponse(statusCode: number, responseText: string): KagiSearchResponse {
	let payload: unknown;
	try {
		payload = JSON.parse(responseText);
	} catch {
		throw new KagiApiError("Kagi API returned an invalid response: invalid JSON", statusCode);
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new KagiApiError("Kagi API returned an invalid response: expected an object envelope", statusCode);
	}

	const record = payload as Record<string, unknown>;
	const errorMessage = extractKagiErrorMessage(payload);
	if (errorMessage && (record.error !== undefined || record.errors !== undefined)) {
		const errors = Array.isArray(record.error) ? record.error : Array.isArray(record.errors) ? record.errors : [];
		const first = errors[0];
		const code =
			first && typeof first === "object" && typeof (first as Record<string, unknown>).code === "number"
				? ((first as Record<string, unknown>).code as number)
				: statusCode;
		throw createKagiApiError(code, errorMessage);
	}
	if (record.data !== undefined && (!record.data || typeof record.data !== "object" || Array.isArray(record.data))) {
		throw new KagiApiError("Kagi API returned an invalid response: expected data to be an object", statusCode);
	}
	return payload as KagiSearchResponse;
}

interface KagiSearchOptions {
	limit?: number;
	recency?: "day" | "week" | "month" | "year";
	sessionId?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

interface KagiSearchSource {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
}

interface KagiSearchResult {
	requestId: string;
	sources: KagiSearchSource[];
	relatedQuestions: string[];
	answer?: string;
}

function recencyToDate(recency: "day" | "week" | "month" | "year"): string {
	const d = new Date();
	switch (recency) {
		case "day":
			d.setUTCDate(d.getUTCDate() - 1);
			break;
		case "week":
			d.setUTCDate(d.getUTCDate() - 7);
			break;
		case "month":
			d.setUTCMonth(d.getUTCMonth() - 1);
			break;
		case "year":
			d.setUTCFullYear(d.getUTCFullYear() - 1);
			break;
	}
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function buildRequestBody(query: string, options: KagiSearchOptions): KagiSearchRequest {
	const req: KagiSearchRequest = {
		query,
		workflow: "search",
		limit: options.limit,
	};

	if (options.recency) {
		req.filters = { after: recencyToDate(options.recency) };
	}

	return req;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function collectSources(sources: KagiSearchSource[], items: unknown, tag?: string): void {
	if (!Array.isArray(items)) return;
	for (const value of items) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const item = value as Record<string, unknown>;
		const url = firstNonEmptyString(item.url, item.href, item.link);
		if (!url) continue;
		const title = firstNonEmptyString(item.title, item.name) ?? url;
		sources.push({
			title: tag ? `${tag} ${title}` : title,
			url,
			snippet: firstNonEmptyString(item.snippet, item.description, item.summary),
			publishedDate: firstNonEmptyString(item.time),
		});
	}
}

function questionOf(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const item = value as Record<string, unknown>;
	const props =
		item.props && typeof item.props === "object" && !Array.isArray(item.props)
			? (item.props as Record<string, unknown>)
			: undefined;
	return firstNonEmptyString(props?.question, props?.query, item.title);
}

export async function searchWithKagi(
	query: string,
	options: KagiSearchOptions = {},
	authStorage: AuthStorage,
): Promise<KagiSearchResult> {
	const fetchImpl = options.fetch ?? fetch;
	const body = JSON.stringify(buildRequestBody(query, options));

	const response = await withAuth(
		authStorage.resolver("kagi", { sessionId: options.sessionId }),
		async apiKey => {
			const res = await fetchImpl(KAGI_SEARCH_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body,
				signal: withHardTimeout(options.signal, options.timeoutMs),
			});

			if (!res.ok) {
				throw parseKagiErrorResponse(res.status, await res.text());
			}

			return res;
		},
		{
			signal: options.signal,
			missingKeyMessage: "Kagi credentials not found. Set KAGI_API_KEY or login with 'proto /login kagi'.",
		},
	);

	const payload = parseKagiSuccessResponse(response.status, await response.text());

	const data = payload.data;
	const sources: KagiSearchSource[] = [];
	const relatedQuestions: string[] = [];

	collectSources(sources, data?.search);
	collectSources(sources, data?.video, "[Video]");
	collectSources(sources, data?.news, "[News]");
	collectSources(sources, data?.infobox, "[Info]");

	const adjacentQuestions: unknown = data?.adjacent_question;
	if (Array.isArray(adjacentQuestions)) {
		for (const item of adjacentQuestions) {
			const question = questionOf(item);
			if (question) relatedQuestions.push(question);
		}
	}
	const relatedSearches: unknown = data?.related_search;
	if (Array.isArray(relatedSearches)) {
		for (const item of relatedSearches) {
			const question = questionOf(item);
			if (question) relatedQuestions.push(question);
		}
	}

	const directAnswers: unknown = data?.direct_answer;
	const directAnswer = Array.isArray(directAnswers) ? directAnswers[0] : undefined;
	const answer =
		directAnswer && typeof directAnswer === "object" && !Array.isArray(directAnswer)
			? firstNonEmptyString(
					(directAnswer as Record<string, unknown>).snippet,
					(directAnswer as Record<string, unknown>).title,
				)
			: undefined;

	return {
		requestId: payload.meta?.trace ?? payload.meta?.id ?? "",
		sources,
		relatedQuestions,
		answer,
	};
}
