import { type } from "@oh-my-pi/omptype";
import type { FetchImpl } from "@oh-my-pi/pi-utils";
import { parseGeminiModel, semverGte } from "../identity/classify";
import { isGeminiModelId } from "../identity/family";
import { createBundledReferenceMap } from "../provider-models/bundled-references";
import type { ModelSpec } from "../types";
import { discoveryFetch } from "../utils";
import {
	collapseEffortVariants,
	GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
	type VariantCollapseTable,
} from "../variant-collapse";
import { getGeminiCliHeaders } from "../wire/gemini-headers";

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
const RETRIEVE_USER_QUOTA_PATH = "/v1internal:retrieveUserQuota";

const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_MAX_TOKENS = 65_536;

const REASONING_MIN_VERSION = "2.5";

const LoadCodeAssistResponseSchema = type({
	"cloudaicompanionProject?": type("unknown").pipe(value => {
		if (typeof value === "string") return value;
		if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
			return value.id;
		}
		return undefined;
	}),
});

const QuotaBucketSchema = type({
	"modelId?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
});

const RetrieveUserQuotaResponseSchema = type({
	"buckets?": type("unknown").pipe(value => {
		if (!Array.isArray(value)) return undefined;
		const buckets: Array<{ modelId?: string }> = [];
		for (const bucket of value) {
			const parsed = QuotaBucketSchema(bucket);
			if (!(parsed instanceof type.errors)) {
				buckets.push(parsed);
			}
		}
		return buckets;
	}),
});

export interface FetchGeminiCliQuotaModelsOptions {
	token: string;

	endpoint?: string;

	projectId?: string;

	signal?: AbortSignal;

	fetcher?: typeof fetch;

	collapseTable?: VariantCollapseTable;
}

export async function fetchGeminiCliQuotaModels(
	options: FetchGeminiCliQuotaModelsOptions,
): Promise<ModelSpec<"google-gemini-cli">[] | null> {
	const fetcher = discoveryFetch(options.fetcher);
	const endpoint = (options.endpoint?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");
	const headers = {
		Authorization: `Bearer ${options.token}`,
		"Content-Type": "application/json",
		...getGeminiCliHeaders(),
	};

	const projectId = options.projectId ?? (await loadProjectId(fetcher, endpoint, headers, options.signal));

	let response: Response;
	try {
		response = await fetcher(`${endpoint}${RETRIEVE_USER_QUOTA_PATH}`, {
			method: "POST",
			headers,
			body: JSON.stringify(projectId ? { project: projectId } : {}),
			signal: options.signal,
		});
	} catch {
		return null;
	}

	if (!response.ok) {
		return null;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}

	const parsed = RetrieveUserQuotaResponseSchema(payload);
	if (parsed instanceof type.errors) {
		return null;
	}

	const seen = new Set<string>();
	const models: ModelSpec<"google-gemini-cli">[] = [];
	const bundled = createBundledReferenceMap<"google-gemini-cli">("google-gemini-cli");

	for (const bucket of parsed.buckets ?? []) {
		const modelId = bucket.modelId?.trim();
		if (!modelId || seen.has(modelId) || !isGeminiModelId(modelId)) {
			continue;
		}
		seen.add(modelId);

		const reference = bundled.get(modelId);
		if (reference) {
			models.push({ ...reference, baseUrl: endpoint });
			continue;
		}

		const parsedId = parseGeminiModel(modelId);
		models.push({
			id: modelId,
			name: modelId,
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: endpoint,
			reasoning: parsedId ? semverGte(parsedId.version, REASONING_MIN_VERSION) : false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
		});
	}

	const collapsed = collapseEffortVariants(models, options.collapseTable ?? GEMINI_CLI_VARIANT_COLLAPSE_TABLE);
	collapsed.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	return collapsed;
}

async function loadProjectId(
	fetcher: FetchImpl,
	endpoint: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	let response: Response;
	try {
		response = await fetcher(`${endpoint}${LOAD_CODE_ASSIST_PATH}`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
			}),
			signal,
		});
	} catch {
		return undefined;
	}

	if (!response.ok) {
		return undefined;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return undefined;
	}

	const parsed = LoadCodeAssistResponseSchema(payload);
	return parsed instanceof type.errors ? undefined : parsed.cloudaicompanionProject;
}
