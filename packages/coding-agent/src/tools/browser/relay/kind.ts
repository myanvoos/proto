import { parseFlag } from "@oh-my-pi/pi-utils";

export interface RelayKind {
	kind: "relay";
	cdpUrl: string;
}

export const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";

interface ResolveRelayKindOptions {
	settingEnabled?: boolean;

	url?: string;
}

export function resolveRelayKind(
	options?: ResolveRelayKindOptions | null,
	env: Record<string, string | undefined> = process.env,
): RelayKind | null {
	if (!parseFlag(env.PI_BROWSER_RELAY, options?.settingEnabled ?? false)) {
		return null;
	}
	const url = options?.url?.trim() || DEFAULT_RELAY_URL;
	return { kind: "relay", cdpUrl: url.replace(/\/+$/, "") };
}
