export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

const DEVIN_OS = process.platform === "darwin" ? "darwin" : "linux";
const DEVIN_LOCALE = "en";

// The backend gates behavior on this identity tuple: `ideType: "chisel"` unlocks router
// assignment (`AssignModel`) and the CLI model surface the Windsurf identity cannot reach.
const DEVIN_CLI_METADATA = {
	ideName: "devin-cli",
	ideType: "chisel",
	ideVersion: "3000.6.2",
	extensionName: "chisel",
	extensionVersion: "3000.6.2",
	locale: DEVIN_LOCALE,
	os: DEVIN_OS,
} as const;

// `GetCliModelConfigs` only returns the full native config set to the dev-channel `chisel` client.
const DEVIN_DISCOVERY_METADATA = {
	ideName: "chisel",
	ideVersion: "0.0.0-dev",
	extensionName: "chisel",
	extensionVersion: "0.0.0-dev",
	locale: DEVIN_LOCALE,
	os: DEVIN_OS,
} as const;

export function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

export function devinCliMetadata(apiKey: string | undefined, userJwt = "") {
	return {
		apiKey: normalizeDevinSessionToken(apiKey),
		userJwt,
		...DEVIN_CLI_METADATA,
	};
}

export function devinDiscoveryMetadata(apiKey: string | undefined) {
	return {
		apiKey: normalizeDevinSessionToken(apiKey),
		...DEVIN_DISCOVERY_METADATA,
	};
}
