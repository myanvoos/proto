// Generated from src/registry/registry.ts provider list. Static require paths keep
// every provider definition bundleable while materialization stays lazy per id.

import type { aiandProvider } from "./aiand";
import type { aimlApiProvider } from "./aimlapi";
import type { alibabaCodingPlanProvider } from "./alibaba-coding-plan";
import type { alibabaTokenPlanProvider } from "./alibaba-token-plan";
import type { amazonBedrockProvider } from "./amazon-bedrock";
import type { anthropicProvider } from "./anthropic";
import type { azureProvider } from "./azure";
import type { basetenProvider } from "./baseten";
import type { bedrockMantleProvider } from "./bedrock-mantle";
import type { cerebrasProvider } from "./cerebras";
import type { cloudflareAiGatewayProvider } from "./cloudflare-ai-gateway";
import type { coreWeaveProvider } from "./coreweave";
import type { cursorProvider } from "./cursor";
import type { deepseekProvider } from "./deepseek";
import type { devinProvider } from "./devin";
import type { exaProvider } from "./exa";
import type { firepassProvider } from "./firepass";
import type { fireworksProvider } from "./fireworks";
import type { githubCopilotProvider } from "./github-copilot";
import type { gitlabDuoProvider } from "./gitlab-duo";
import type { gitLabDuoWorkflowProvider } from "./gitlab-duo-workflow";
import type { gmiCloudProvider } from "./gmi-cloud";
import type { googleProvider } from "./google";
import type { googleAntigravityProvider } from "./google-antigravity";
import type { googleGeminiCliProvider } from "./google-gemini-cli";
import type { googleVertexProvider } from "./google-vertex";
import type { groqProvider } from "./groq";
import type { huggingfaceProvider } from "./huggingface";
import type { kagiProvider } from "./kagi";
import type { kiloProvider } from "./kilo";
import type { kimiCodeProvider } from "./kimi-code";
import type { litellmProvider } from "./litellm";
import type { llamaCppProvider } from "./llama-cpp";
import type { lmStudioProvider } from "./lm-studio";
import type { metaProvider } from "./meta";
import type { minimaxProvider } from "./minimax";
import type { minimaxCodeProvider } from "./minimax-code";
import type { minimaxCodeCnProvider } from "./minimax-code-cn";
import type { mistralProvider } from "./mistral";
import type { moonshotProvider } from "./moonshot";
import type { nanogptProvider } from "./nanogpt";
import type { novitaProvider } from "./novita";
import type { nvidiaProvider } from "./nvidia";
import type { ollamaProvider } from "./ollama";
import type { ollamaCloudProvider } from "./ollama-cloud";
import type { openaiProvider } from "./openai";
import type { openaiCodexProvider } from "./openai-codex";
import type { openaiCodexDeviceProvider } from "./openai-codex-device";
import type { opencodeGoProvider } from "./opencode-go";
import type { opencodeZenProvider } from "./opencode-zen";
import type { openrouterProvider } from "./openrouter";
import type { parallelProvider } from "./parallel";
import type { perplexityProvider } from "./perplexity";
import type { qianfanProvider } from "./qianfan";
import type { qwenPortalProvider } from "./qwen-portal";
import type { sakanaProvider } from "./sakana";
import type { siliconflowProvider } from "./siliconflow";
import type { siliconflowCnProvider } from "./siliconflow-cn";
import type { syntheticProvider } from "./synthetic";
import type { tavilyProvider } from "./tavily";
import type { togetherProvider } from "./together";
import type { umansProvider } from "./umans";
import type { veniceProvider } from "./venice";
import type { vercelAiGatewayProvider } from "./vercel-ai-gateway";
import type { vllmProvider } from "./vllm";
import type { waferServerlessProvider } from "./wafer-serverless";
import type { xaiProvider } from "./xai";
import type { xaiOauthProvider } from "./xai-oauth";
import type { xiaomiProvider } from "./xiaomi";
import type { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams";
import type { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn";
import type { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp";
import type { zaiCodingPlanProvider, zaiProvider } from "./zai";
import type { zenmuxProvider } from "./zenmux";
import type { zhipuCodingPlanProvider } from "./zhipu-coding-plan";

export type RegistryDefinition = [
	typeof azureProvider,
	typeof openaiCodexProvider,
	typeof anthropicProvider,
	typeof zaiProvider,
	typeof zaiCodingPlanProvider,
	typeof kimiCodeProvider,
	typeof openrouterProvider,
	typeof githubCopilotProvider,
	typeof cursorProvider,
	typeof devinProvider,
	typeof googleAntigravityProvider,
	typeof googleGeminiCliProvider,
	typeof openaiCodexDeviceProvider,
	typeof xaiProvider,
	typeof xaiOauthProvider,
	typeof gitlabDuoProvider,
	typeof gitLabDuoWorkflowProvider,
	typeof alibabaCodingPlanProvider,
	typeof alibabaTokenPlanProvider,
	typeof aiandProvider,
	typeof aimlApiProvider,
	typeof zhipuCodingPlanProvider,
	typeof umansProvider,
	typeof qwenPortalProvider,
	typeof sakanaProvider,
	typeof minimaxCodeProvider,
	typeof minimaxCodeCnProvider,
	typeof xiaomiProvider,
	typeof xiaomiTokenPlanSgpProvider,
	typeof xiaomiTokenPlanAmsProvider,
	typeof xiaomiTokenPlanCnProvider,
	typeof firepassProvider,
	typeof deepseekProvider,
	typeof metaProvider,
	typeof moonshotProvider,
	typeof cerebrasProvider,
	typeof basetenProvider,
	typeof fireworksProvider,
	typeof togetherProvider,
	typeof nvidiaProvider,
	typeof novitaProvider,
	typeof huggingfaceProvider,
	typeof perplexityProvider,
	typeof qianfanProvider,
	typeof veniceProvider,
	typeof siliconflowProvider,
	typeof siliconflowCnProvider,
	typeof syntheticProvider,
	typeof nanogptProvider,
	typeof waferServerlessProvider,
	typeof coreWeaveProvider,
	typeof vercelAiGatewayProvider,
	typeof cloudflareAiGatewayProvider,
	typeof litellmProvider,
	typeof kiloProvider,
	typeof zenmuxProvider,
	typeof opencodeZenProvider,
	typeof opencodeGoProvider,
	typeof tavilyProvider,
	typeof kagiProvider,
	typeof exaProvider,
	typeof parallelProvider,
	typeof ollamaProvider,
	typeof ollamaCloudProvider,
	typeof lmStudioProvider,
	typeof llamaCppProvider,
	typeof vllmProvider,
	typeof openaiProvider,
	typeof googleProvider,
	typeof googleVertexProvider,
	typeof groqProvider,
	typeof mistralProvider,
	typeof minimaxProvider,
	typeof amazonBedrockProvider,
	typeof bedrockMantleProvider,
	typeof gmiCloudProvider,
][number];

export const REGISTRY_IDS = [
	"azure",
	"openai-codex",
	"anthropic",
	"zai",
	"zai-coding-plan",
	"kimi-code",
	"openrouter",
	"github-copilot",
	"cursor",
	"devin",
	"google-antigravity",
	"google-gemini-cli",
	"openai-codex-device",
	"xai",
	"xai-oauth",
	"gitlab-duo",
	"gitlab-duo-agent",
	"alibaba-coding-plan",
	"alibaba-token-plan",
	"aiand",
	"aimlapi",
	"zhipu-coding-plan",
	"umans",
	"qwen-portal",
	"sakana",
	"minimax-code",
	"minimax-code-cn",
	"xiaomi",
	"xiaomi-token-plan-sgp",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"firepass",
	"deepseek",
	"meta",
	"moonshot",
	"cerebras",
	"baseten",
	"fireworks",
	"together",
	"nvidia",
	"novita",
	"huggingface",
	"perplexity",
	"qianfan",
	"venice",
	"siliconflow",
	"siliconflow-cn",
	"synthetic",
	"nanogpt",
	"wafer-serverless",
	"coreweave",
	"vercel-ai-gateway",
	"cloudflare-ai-gateway",
	"litellm",
	"kilo",
	"zenmux",
	"opencode-zen",
	"opencode-go",
	"tavily",
	"kagi",
	"exa",
	"parallel",
	"ollama",
	"ollama-cloud",
	"lm-studio",
	"llama.cpp",
	"vllm",
	"openai",
	"google",
	"google-vertex",
	"groq",
	"mistral",
	"minimax",
	"amazon-bedrock",
	"bedrock-mantle",
	"gmi-cloud",
] as const;

export function registryProviderIds(): readonly string[] {
	return REGISTRY_IDS;
}

export function loadProviderDefinition(id: string): RegistryDefinition | undefined {
	switch (id) {
		case "azure":
			return require("./azure").azureProvider;
		case "openai-codex":
			return require("./openai-codex").openaiCodexProvider;
		case "anthropic":
			return require("./anthropic").anthropicProvider;
		case "zai":
			return require("./zai").zaiProvider;
		case "zai-coding-plan":
			return require("./zai").zaiCodingPlanProvider;
		case "kimi-code":
			return require("./kimi-code").kimiCodeProvider;
		case "openrouter":
			return require("./openrouter").openrouterProvider;
		case "github-copilot":
			return require("./github-copilot").githubCopilotProvider;
		case "cursor":
			return require("./cursor").cursorProvider;
		case "devin":
			return require("./devin").devinProvider;
		case "google-antigravity":
			return require("./google-antigravity").googleAntigravityProvider;
		case "google-gemini-cli":
			return require("./google-gemini-cli").googleGeminiCliProvider;
		case "openai-codex-device":
			return require("./openai-codex-device").openaiCodexDeviceProvider;
		case "xai":
			return require("./xai").xaiProvider;
		case "xai-oauth":
			return require("./xai-oauth").xaiOauthProvider;
		case "gitlab-duo":
			return require("./gitlab-duo").gitlabDuoProvider;
		case "gitlab-duo-agent":
			return require("./gitlab-duo-workflow").gitLabDuoWorkflowProvider;
		case "alibaba-coding-plan":
			return require("./alibaba-coding-plan").alibabaCodingPlanProvider;
		case "alibaba-token-plan":
			return require("./alibaba-token-plan").alibabaTokenPlanProvider;
		case "aiand":
			return require("./aiand").aiandProvider;
		case "aimlapi":
			return require("./aimlapi").aimlApiProvider;
		case "zhipu-coding-plan":
			return require("./zhipu-coding-plan").zhipuCodingPlanProvider;
		case "umans":
			return require("./umans").umansProvider;
		case "qwen-portal":
			return require("./qwen-portal").qwenPortalProvider;
		case "sakana":
			return require("./sakana").sakanaProvider;
		case "minimax-code":
			return require("./minimax-code").minimaxCodeProvider;
		case "minimax-code-cn":
			return require("./minimax-code-cn").minimaxCodeCnProvider;
		case "xiaomi":
			return require("./xiaomi").xiaomiProvider;
		case "xiaomi-token-plan-sgp":
			return require("./xiaomi-token-plan-sgp").xiaomiTokenPlanSgpProvider;
		case "xiaomi-token-plan-ams":
			return require("./xiaomi-token-plan-ams").xiaomiTokenPlanAmsProvider;
		case "xiaomi-token-plan-cn":
			return require("./xiaomi-token-plan-cn").xiaomiTokenPlanCnProvider;
		case "firepass":
			return require("./firepass").firepassProvider;
		case "deepseek":
			return require("./deepseek").deepseekProvider;
		case "meta":
			return require("./meta").metaProvider;
		case "moonshot":
			return require("./moonshot").moonshotProvider;
		case "cerebras":
			return require("./cerebras").cerebrasProvider;
		case "baseten":
			return require("./baseten").basetenProvider;
		case "fireworks":
			return require("./fireworks").fireworksProvider;
		case "together":
			return require("./together").togetherProvider;
		case "nvidia":
			return require("./nvidia").nvidiaProvider;
		case "novita":
			return require("./novita").novitaProvider;
		case "huggingface":
			return require("./huggingface").huggingfaceProvider;
		case "perplexity":
			return require("./perplexity").perplexityProvider;
		case "qianfan":
			return require("./qianfan").qianfanProvider;
		case "venice":
			return require("./venice").veniceProvider;
		case "siliconflow":
			return require("./siliconflow").siliconflowProvider;
		case "siliconflow-cn":
			return require("./siliconflow-cn").siliconflowCnProvider;
		case "synthetic":
			return require("./synthetic").syntheticProvider;
		case "nanogpt":
			return require("./nanogpt").nanogptProvider;
		case "wafer-serverless":
			return require("./wafer-serverless").waferServerlessProvider;
		case "coreweave":
			return require("./coreweave").coreWeaveProvider;
		case "vercel-ai-gateway":
			return require("./vercel-ai-gateway").vercelAiGatewayProvider;
		case "cloudflare-ai-gateway":
			return require("./cloudflare-ai-gateway").cloudflareAiGatewayProvider;
		case "litellm":
			return require("./litellm").litellmProvider;
		case "kilo":
			return require("./kilo").kiloProvider;
		case "zenmux":
			return require("./zenmux").zenmuxProvider;
		case "opencode-zen":
			return require("./opencode-zen").opencodeZenProvider;
		case "opencode-go":
			return require("./opencode-go").opencodeGoProvider;
		case "tavily":
			return require("./tavily").tavilyProvider;
		case "kagi":
			return require("./kagi").kagiProvider;
		case "exa":
			return require("./exa").exaProvider;
		case "parallel":
			return require("./parallel").parallelProvider;
		case "ollama":
			return require("./ollama").ollamaProvider;
		case "ollama-cloud":
			return require("./ollama-cloud").ollamaCloudProvider;
		case "lm-studio":
			return require("./lm-studio").lmStudioProvider;
		case "llama.cpp":
			return require("./llama-cpp").llamaCppProvider;
		case "vllm":
			return require("./vllm").vllmProvider;
		case "openai":
			return require("./openai").openaiProvider;
		case "google":
			return require("./google").googleProvider;
		case "google-vertex":
			return require("./google-vertex").googleVertexProvider;
		case "groq":
			return require("./groq").groqProvider;
		case "mistral":
			return require("./mistral").mistralProvider;
		case "minimax":
			return require("./minimax").minimaxProvider;
		case "amazon-bedrock":
			return require("./amazon-bedrock").amazonBedrockProvider;
		case "bedrock-mantle":
			return require("./bedrock-mantle").bedrockMantleProvider;
		case "gmi-cloud":
			return require("./gmi-cloud").gmiCloudProvider;
		default:
			return undefined;
	}
}
