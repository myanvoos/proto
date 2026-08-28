import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../../config/model-registry";
import type { StructuredQuery } from "../query";
import type { SearchProviderId, SearchResponse } from "../types";

export interface SearchParams {
	query: string;

	parsedQuery?: StructuredQuery;
	limit?: number;

	recency?: "day" | "week" | "month" | "year";
	systemPrompt: string;
	signal?: AbortSignal;

	timeoutMs?: number;
	fetch?: FetchImpl;
	maxOutputTokens?: number;
	numSearchResults?: number;
	temperature?: number;
	googleSearch?: Record<string, unknown>;
	codeExecution?: Record<string, unknown>;
	urlContext?: Record<string, unknown>;

	authStorage: AuthStorage;

	modelRegistry?: ModelRegistry;

	sessionId?: string;
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
	geminiModel?: string;
}

export abstract class SearchProvider {
	abstract readonly id: SearchProviderId;
	abstract readonly label: string;

	abstract isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean;

	isExplicitlyAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return this.isAvailable(authStorage);
	}

	abstract search(params: SearchParams): Promise<SearchResponse>;
}
