export type ImageFetcherVendor = "openai" | "anthropic" | "xai" | "google";

export type ImageFetcherId =
	| "openai-file-downloader"
	| "anthropic-claude-user"
	| "anthropic-claude-user-preview"
	| "xai-image-api-fetch"
	| "google";

export interface ImageFetcherIdentity {
	vendor: ImageFetcherVendor;

	label: string;

	userAgent: string | RegExp;

	markerHeaders: readonly string[];

	observedVia: string;

	note?: string;
}

export const IMAGE_FETCHERS: Readonly<Record<ImageFetcherId, ImageFetcherIdentity>> = {
	"openai-file-downloader": {
		vendor: "openai",
		label: "OpenAI File Downloader",
		userAgent: "OpenAI File Downloader",
		markerHeaders: ["openai-internal-smokescreener"],
		observedVia: "chatgpt.com/backend-api/codex/responses, input_image.image_url",
		note: "Issues two near-simultaneous GETs per image; a blob server must treat a duplicate hit as expected rather than as replay.",
	},
	"anthropic-claude-user": {
		vendor: "anthropic",
		label: "Claude image fetcher",
		userAgent: "Claude-User",
		markerHeaders: [],
		observedVia: "api.anthropic.com/v1/messages, image.source.type=url",
		note: "Sends only generic trace headers, so the bare agent string is the sole signal. Distinct from the versioned Claude-User/<version> agent used for links appearing in conversation text.",
	},
	"anthropic-claude-user-preview": {
		vendor: "anthropic",
		label: "Claude link fetcher",
		userAgent: /\bClaude-User\/\d+(?:\.\d+)*\b/,
		markerHeaders: [],
		observedVia:
			"unsolicited fetch after a URL appeared in assistant output; never observed serving an image request",
		note: "Not an image fetcher. Listed so a blob server can separate it from the image path instead of counting it as a provider image fetch.",
	},
	"xai-image-api-fetch": {
		vendor: "xai",
		label: "xAI image API fetch",
		userAgent: /^XaiImageApiFetch\/\d+(?:\.\d+)*\s/,
		markerHeaders: ["x-xaifetchid"],
		observedVia: "api.x.ai/v1/responses, input_image.image_url",
		note: "Sends an image-only `accept` allowlist and rejects any other content type before the model sees the response.",
	},
	google: {
		vendor: "google",
		label: "Google",
		userAgent: "Google",
		markerHeaders: [],
		observedVia: "cloudcode-pa.googleapis.com v1internal:streamGenerateContent, fileData.fileUri",
		note: "Weakest signal of the set: the agent string is a bare vendor name with no version and no proprietary header.",
	},
};

export interface ImageFetcherMatch {
	id: ImageFetcherId;
	identity: ImageFetcherIdentity;

	corroborated: boolean;
}

export type InboundHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

function headerValue(headers: InboundHeaders, name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	const direct = headers[name];
	if (direct !== undefined) return Array.isArray(direct) ? direct[0] : (direct as string);
	for (const key in headers) {
		if (key.toLowerCase() !== name) continue;
		const value = headers[key];
		return Array.isArray(value) ? value[0] : (value as string | undefined);
	}
	return undefined;
}

export function identifyImageFetcher(headers: InboundHeaders): ImageFetcherMatch | null {
	const agent = headerValue(headers, "user-agent");
	if (!agent) return null;
	for (const id in IMAGE_FETCHERS) {
		const identity = IMAGE_FETCHERS[id as ImageFetcherId];
		const { userAgent } = identity;
		const matched = typeof userAgent === "string" ? agent === userAgent : userAgent.test(agent);
		if (!matched) continue;
		return {
			id: id as ImageFetcherId,
			identity,
			corroborated:
				identity.markerHeaders.length > 0 &&
				identity.markerHeaders.every(header => headerValue(headers, header) !== undefined),
		};
	}
	return null;
}
