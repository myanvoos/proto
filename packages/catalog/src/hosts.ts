interface HostClassSpec {
	readonly providers?: readonly string[];

	readonly providerPrefixes?: readonly string[];

	readonly urlMarkers: readonly string[];
}

export const KNOWN_HOSTS = {
	openai: { providers: ["openai"], urlMarkers: ["api.openai.com"] },
	azureOpenAI: {
		providers: ["azure"],
		urlMarkers: [".openai.azure.com", "azure.com/openai", "models.inference.ai.azure.com"],
	},
	openrouter: { providers: ["openrouter"], urlMarkers: ["openrouter.ai"] },
	vercelAIGateway: { providers: ["vercel-ai-gateway"], urlMarkers: ["ai-gateway.vercel.sh"] },
	githubCopilot: { providers: ["github-copilot"], urlMarkers: ["githubcopilot.com", "copilot-api."] },
	anthropic: { providers: ["anthropic"], urlMarkers: ["api.anthropic.com"] },

	deepseekDirect: { providers: ["deepseek"], urlMarkers: ["api.deepseek.com"] },

	deepseekFamily: { providers: ["deepseek"], urlMarkers: ["deepseek.com"] },
	cerebras: { providers: ["cerebras"], urlMarkers: ["cerebras.ai"] },
	zai: { providers: ["zai"], urlMarkers: ["api.z.ai"] },
	zhipu: { providers: ["zhipu-coding-plan"], urlMarkers: ["open.bigmodel.cn"] },
	kilo: { providers: ["kilo"], urlMarkers: ["api.kilo.ai"] },
	alibabaDashscope: {
		providers: ["alibaba-coding-plan", "alibaba-token-plan"],
		urlMarkers: ["dashscope", "token-plan."],
	},
	umans: { providers: ["umans"], urlMarkers: ["api.code.umans.ai"] },
	xiaomi: { providers: ["xiaomi"], providerPrefixes: ["xiaomi-token-plan-"], urlMarkers: ["xiaomimimo.com"] },
	xai: { providers: ["xai", "xai-oauth"], urlMarkers: ["api.x.ai"] },
	mistral: { providers: ["mistral"], urlMarkers: ["mistral.ai"] },
	together: { providers: ["together"], urlMarkers: ["api.together.xyz"] },
	baseten: { providers: ["baseten"], urlMarkers: ["baseten.co"] },

	fireworks: { urlMarkers: ["fireworks.ai"] },
	groq: { providers: ["groq"], urlMarkers: ["api.groq.com"] },
	minimax: {
		providers: ["minimax", "minimax-code", "minimax-code-cn"],
		urlMarkers: ["api.minimax.io", "api.minimaxi.com"],
	},
	qwenPortal: { providers: ["qwen-portal"], urlMarkers: ["portal.qwen.ai"] },

	nvidia: { providers: ["nvidia"], urlMarkers: ["integrate.api.nvidia.com"] },

	venice: { providers: ["venice"], urlMarkers: ["api.venice.ai"] },
	moonshotNative: { providers: ["moonshot", "kimi-code"], urlMarkers: ["api.moonshot.ai", "api.kimi.com"] },

	googleAistudio: { providers: [], urlMarkers: ["generativelanguage.googleapis.com"] },
	opencode: { providers: ["opencode-go", "opencode-zen"], urlMarkers: ["opencode.ai"] },

	zenmux: { providers: ["zenmux"], urlMarkers: ["zenmux.ai"] },
	chutes: { urlMarkers: ["chutes.ai"] },
} as const satisfies Record<string, HostClassSpec>;

export type KnownHost = keyof typeof KNOWN_HOSTS;

const MAX_URL_HOST_MATCHES = 512;
const urlHostMatches = new Map<string, Map<KnownHost, boolean>>();

function getUrlHostMatches(baseUrl: string): Map<KnownHost, boolean> {
	let matches = urlHostMatches.get(baseUrl);
	if (matches !== undefined) return matches;
	if (urlHostMatches.size === MAX_URL_HOST_MATCHES) urlHostMatches.clear();
	matches = new Map<KnownHost, boolean>();
	urlHostMatches.set(baseUrl, matches);
	return matches;
}

export function hostMatchesUrl(baseUrl: string | undefined, host: KnownHost): boolean {
	if (!baseUrl) return false;
	const matches = getUrlHostMatches(baseUrl);
	const cached = matches.get(host);
	if (cached !== undefined) return cached;
	const spec: HostClassSpec = KNOWN_HOSTS[host];
	for (const marker of spec.urlMarkers) {
		if (includesAsciiCaseInsensitive(baseUrl, marker)) {
			matches.set(host, true);
			return true;
		}
	}
	matches.set(host, false);
	return false;
}

export function modelMatchesHost(model: { provider: string; baseUrl: string }, host: KnownHost): boolean {
	const spec: HostClassSpec = KNOWN_HOSTS[host];
	if (spec.providers) {
		for (const provider of spec.providers) {
			if (model.provider === provider) return true;
		}
	}
	if (spec.providerPrefixes) {
		for (const prefix of spec.providerPrefixes) {
			if (model.provider.startsWith(prefix)) return true;
		}
	}
	return hostMatchesUrl(model.baseUrl, host);
}

function includesAsciiCaseInsensitive(value: string, lowerNeedle: string): boolean {
	const needleLength = lowerNeedle.length;
	const end = value.length - needleLength;
	for (let start = 0; start <= end; start++) {
		let offset = 0;
		for (; offset < needleLength; offset++) {
			if ((value.charCodeAt(start + offset) | 0x20) !== lowerNeedle.charCodeAt(offset)) break;
		}
		if (offset === needleLength) return true;
	}
	return false;
}

export function resolveVertexEndpointHost(location: string): string {
	if (location === "global") return "aiplatform.googleapis.com";
	if (location === "eu" || location === "us") return `aiplatform.${location}.rep.googleapis.com`;
	return `${location}-aiplatform.googleapis.com`;
}

export function isVertexExpressOpenAIUrl(baseUrl: string): boolean {
	return baseUrl.includes("/endpoints/openapi");
}

export function isVertexRawPredictUrl(baseUrl: string): boolean {
	return baseUrl.includes(":streamRawPredict") || baseUrl.includes(":rawPredict");
}

export function isAzureDeploymentsUrl(baseUrl: string): boolean {
	return baseUrl.includes("/deployments/");
}

export function isDashscopeCompatibleModeUrl(baseUrl: string): boolean {
	const normalized = baseUrl.toLowerCase();
	return (
		normalized.includes("dashscope") && normalized.includes("aliyuncs.com") && normalized.includes("/compatible-mode")
	);
}
