import type { FetchImpl } from "@oh-my-pi/pi-utils";
import type { AntigravityModelWireProfile } from "../types";

export function getGeminiCliUserAgent(modelId = "gemini-3.1-pro-preview"): string {
	const version = process.env.PI_AI_GEMINI_CLI_VERSION || "0.46.0";
	const platform = process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}

export const getGeminiCliHeaders = (modelId?: string) => ({
	"User-Agent": getGeminiCliUserAgent(modelId),
	"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
});

export const DEFAULT_ANTIGRAVITY_VERSION = "2.26.0";

const ANTIGRAVITY_VERSION_MANIFEST_URL =
	"https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5_000;

let discoveredAntigravityVersion: string | null = null;
let antigravityVersionFetch: Promise<void> | null = null;

export function getAntigravityVersion(): string {
	return process.env.PI_AI_ANTIGRAVITY_VERSION || discoveredAntigravityVersion || DEFAULT_ANTIGRAVITY_VERSION;
}

export function parseAntigravityManifestVersion(yamlText: string): string | null {
	for (const line of yamlText.split(/\r?\n/)) {
		const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
		if (!match) continue;
		const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
	}
	return null;
}

export function ensureAntigravityVersion(fetcher: FetchImpl = fetch, signal?: AbortSignal): Promise<void> {
	if (process.env.PI_AI_ANTIGRAVITY_VERSION || discoveredAntigravityVersion) return Promise.resolve();
	if (antigravityVersionFetch) return antigravityVersionFetch;

	antigravityVersionFetch = (async () => {
		try {
			const timeoutSignal = AbortSignal.timeout(ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS);
			const response = await fetcher(ANTIGRAVITY_VERSION_MANIFEST_URL, {
				headers: { "Cache-Control": "no-cache", "User-Agent": "electron-builder" },
				signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
			});
			if (response.ok) {
				discoveredAntigravityVersion = parseAntigravityManifestVersion(await response.text());
			}
		} catch {
		} finally {
			if (!discoveredAntigravityVersion) antigravityVersionFetch = null;
		}
	})();
	return antigravityVersionFetch;
}

export function getAntigravityUserAgent(): string {
	const version = getAntigravityVersion();

	const cl = process.env.PI_AI_ANTIGRAVITY_CL || "1005016104";
	const host = getAntigravityPlatform();
	const os = process.env.PI_AI_ANTIGRAVITY_OS || host.os;
	const arch = process.env.PI_AI_ANTIGRAVITY_ARCH || host.arch;
	return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

export function getAntigravityPlatform(platform: NodeJS.Platform = process.platform): { os: string; arch: string } {
	return platform === "darwin"
		? { os: "darwin", arch: "arm64" }
		: platform === "win32"
			? { os: "windows", arch: "amd64" }
			: { os: "linux", arch: "amd64" };
}

export function getAntigravityHeaders(userAgent = getAntigravityUserAgent()): {
	"User-Agent": string;
	"Accept-Encoding": string;
} {
	return { "User-Agent": userAgent, "Accept-Encoding": "gzip" };
}
export const ANTIGRAVITY_MODEL_WIRE_PROFILES: Readonly<Record<string, AntigravityModelWireProfile>> = {
	"gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65536 },
	"gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
	"gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65536 },
	"gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65535 },
	"gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },

	"claude-sonnet-4-6": { maxOutputTokens: 64000 },
	"claude-opus-4-6-thinking": { maxOutputTokens: 64000 },
};
export function getAntigravityModelWireProfile(
	wireModelId: string,
	...discovered: (Readonly<Record<string, AntigravityModelWireProfile>> | undefined)[]
): AntigravityModelWireProfile | undefined {
	for (const profiles of discovered) if (profiles?.[wireModelId] !== undefined) return profiles[wireModelId];
	return ANTIGRAVITY_MODEL_WIRE_PROFILES[wireModelId];
}
