import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatScraperQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import type { LoadedHtmlPage } from "./browser-page";
import { browserFetch } from "./browser-page";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const STARTPAGE_HOME_URL = "https://www.startpage.com/";
const STARTPAGE_SEARCH_URL = "https://www.startpage.com/sp/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

const RECENCY_TO_STARTPAGE_WITH_DATE: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "d",
	week: "w",
	month: "m",
	year: "y",
};

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function isChallengeResponse(page: LoadedHtmlPage): boolean {
	if (/\/(?:errors|captcha)\//.test(page.url) || page.url.includes("/sp/captcha")) return true;
	return page.html.includes("component---src-pages-captcha") || page.html.includes("/sp/captcha");
}

function parseSearchFormInputs(html: string): Record<string, string> | undefined {
	const { document } = parseHTML(html);
	const form = document.querySelector('form[action="/sp/search"]');
	if (!form) return undefined;
	const inputs: Record<string, string> = {};
	for (const input of form.querySelectorAll('input[type="hidden"]')) {
		const name = input.getAttribute("name");
		if (name) inputs[name] = input.getAttribute("value") ?? "";
	}
	return inputs.sc ? inputs : undefined;
}

function sanitizeResultUrl(href: string | null | undefined): string | undefined {
	if (!href) return undefined;
	let url: URL;
	try {
		url = new URL(href, STARTPAGE_HOME_URL);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.hostname === "startpage.com" || url.hostname.endsWith(".startpage.com")) return undefined;
	return url.href;
}

function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const block of document.querySelectorAll("div.result")) {
		const anchor = block.querySelector("a.result-link");
		if (!anchor) continue;
		const url = sanitizeResultUrl(anchor.getAttribute("href"));
		if (!url) continue;
		const title = normalizeText(anchor.querySelector("h2, h3")?.textContent ?? anchor.textContent);
		if (!title) continue;
		const snippet = normalizeText(block.querySelector("p.description")?.textContent);
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

async function fetchFormInputs(
	fetchImpl: FetchImpl,
	signal: AbortSignal,
	timeoutMs?: number,
): Promise<Record<string, string> | undefined> {
	let page: LoadedHtmlPage;
	try {
		page = await browserFetch(STARTPAGE_HOME_URL, { fetch: fetchImpl, signal, timeoutMs });
	} catch (error) {
		if (signal.aborted) throw error;
		return undefined;
	}
	if (page.status < 200 || page.status >= 300 || isChallengeResponse(page)) return undefined;
	return parseSearchFormInputs(page.html);
}

async function callStartpageHtml(params: SearchParams): Promise<string> {
	const fetchImpl = params.fetch ?? fetch;
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const withDate = params.recency ? RECENCY_TO_STARTPAGE_WITH_DATE[params.recency] : undefined;

	const query = formatScraperQuery(params.query, params.parsedQuery);

	const formInputs = await fetchFormInputs(fetchImpl, signal, params.timeoutMs);
	let page: LoadedHtmlPage;
	if (formInputs) {
		const form = new URLSearchParams(formInputs);
		form.set("query", query);
		if (withDate) form.set("with_date", withDate);
		page = await browserFetch(STARTPAGE_SEARCH_URL, {
			fetch: fetchImpl,
			signal,
			timeoutMs: params.timeoutMs,
			referer: STARTPAGE_HOME_URL,
			init: { method: "POST", body: form.toString() },
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
		});
	} else {
		const url = new URL(STARTPAGE_SEARCH_URL);
		url.searchParams.set("query", query);
		if (withDate) url.searchParams.set("with_date", withDate);
		page = await browserFetch(url.href, {
			fetch: fetchImpl,
			signal,
			timeoutMs: params.timeoutMs,
			referer: STARTPAGE_HOME_URL,
		});
	}

	if (isChallengeResponse(page)) {
		throw new SearchProviderError(
			"startpage",
			"Startpage blocked the request with a CAPTCHA challenge. Startpage rate-limits automated searches from datacenter/shared-egress IPs; try another provider such as DuckDuckGo or Mojeek, or retry later.",
			429,
		);
	}
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("startpage", page.status, page.html);
		if (classified) throw classified;
		throw new SearchProviderError("startpage", `Startpage HTML error (${page.status})`, page.status);
	}
	return page.html;
}

async function searchStartpage(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const html = await callStartpageHtml(params);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "startpage", sources };
}

export class StartpageProvider extends SearchProvider {
	readonly id = "startpage";
	readonly label = "Startpage";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchStartpage(params);
	}
}
