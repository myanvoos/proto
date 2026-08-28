import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";

interface AppendOnlyContextModel {
	provider: string;
	baseUrl: string;

	compatConfig?: object;
}

const LOCAL_INFERENCE_PROVIDERS = new Set(["ollama", "ollama-cloud", "lm-studio", "llama.cpp"]);

function hasLocalLoopbackBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "0.0.0.0" ||
		hostname === "::1" ||
		hostname === "[::1]"
	) {
		return true;
	}

	if (/^10\./.test(hostname)) return true;
	if (/^192\.168\./.test(hostname)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;

	if (hostname.endsWith(".local")) return true;
	return false;
}

function shouldAutoEnableAppendOnlyContext(model: AppendOnlyContextModel | null | undefined): boolean {
	if (!model) return false;
	if (model.provider === "deepseek") return true;
	if (LOCAL_INFERENCE_PROVIDERS.has(model.provider)) return true;
	if (hostMatchesUrl(model.baseUrl, "xiaomi")) return true;
	if (hasLocalLoopbackBaseUrl(model.baseUrl)) return true;
	return !!model.compatConfig && "supportsStore" in model.compatConfig && model.compatConfig.supportsStore === true;
}

export function shouldEnableAppendOnlyContext(
	setting: "auto" | "on" | "off" | undefined,
	model: AppendOnlyContextModel | null | undefined,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default:
			return shouldAutoEnableAppendOnlyContext(model);
	}
}
