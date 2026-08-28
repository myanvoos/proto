import { $env } from "@oh-my-pi/pi-utils";
import type { ExaSearchResponse } from "./types";

export function findApiKey(): string | null {
	return $env.EXA_API_KEY;
}

export function formatSearchResults(data: ExaSearchResponse): string {
	const results = data.results ?? [];
	if (results.length === 0) return "No results found.";

	let output = "";
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		output += `\n## ${r.title ?? "Untitled"}`;
		if (r.url) output += `\n**URL:** ${r.url}`;
		if (r.author) output += `\n**Author:** ${r.author}`;
		if (r.publishedDate) output += `\n**Published Date:** ${r.publishedDate}`;
		if (r.text) output += `\n**Text:** ${r.text}`;
		if (r.highlights?.length) {
			output += `\n**Highlights:**`;
			for (const h of r.highlights) {
				output += `\n- ${h}`;
			}
		}
		output += "\n";
	}

	if (data.costDollars) {
		output += `\n**Cost:** $${data.costDollars.total.toFixed(4)}`;
	}
	if (data.searchTime) {
		output += `\n**Search Time:** ${data.searchTime.toFixed(2)}s`;
	}

	return output.trim();
}

export function isSearchResponse(data: unknown): data is ExaSearchResponse {
	return (
		typeof data === "object" &&
		data !== null &&
		("results" in data || "statuses" in data || "costDollars" in data || "searchTime" in data)
	);
}
