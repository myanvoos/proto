import type { FetchImpl } from "../../types";
import type { OAuthProviderUnion } from "../registry";

export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
	accountId?: string;
	apiEndpoint?: string;

	orgId?: string;

	orgName?: string;

	authorizedAt?: number;
};

export type OAuthProvider = OAuthProviderUnion;

export type OAuthProviderId = OAuthProvider | (string & {});

export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
	// Masked entry; hosts that cannot hide input must reject the prompt.
	secret?: boolean;
};

export type OAuthAuthInfo = {
	url: string;

	launchUrl?: string;
	instructions?: string;
};

export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;

	storeCredentialsAs?: string;
}

export type OAuthBrowserSessionRequest = {
	url: string;
	// Preference order; the host returns the first non-empty matching cookie value.
	cookieNames: readonly string[];
};

export interface OAuthController {
	onAuth?(info: OAuthAuthInfo): void;
	onProgress?(message: string): void;
	// Hosts must stop the visible prompt when `signal` aborts (e.g. a native callback won the race).
	onManualCodeInput?(signal?: AbortSignal): Promise<string>;
	onPrompt?(prompt: OAuthPrompt): Promise<string>;
	// Completes sign-in in an isolated host-owned browser and returns one cookie value privately.
	onBrowserSession?(request: OAuthBrowserSessionRequest, signal?: AbortSignal): Promise<string>;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export interface OAuthLoginCallbacks extends OAuthController {
	onAuth: (info: OAuthAuthInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
}

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;
	readonly sourceId?: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;

	refreshToken?(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
	getApiKey?(credentials: OAuthCredentials): string;

	readonly storeCredentialsAs?: string;
}
