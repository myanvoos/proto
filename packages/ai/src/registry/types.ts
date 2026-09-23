import type { Api, FetchImpl, Model, SimpleStreamOptions, StreamOptions } from "../types";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";

export type KeyResolver = string | (() => string | undefined);

export const AUTHENTICATED_SENTINEL = "<authenticated>";

export interface PreparedProviderRequest {
	readonly model: Model<Api>;
	readonly options: StreamOptions;
}

export type ProviderRequestPreparer = (model: Model<Api>, options: StreamOptions) => PreparedProviderRequest;
export type ProviderModelPreparer = (model: Model<Api>) => Model<Api>;
export type ProviderSimpleOptionsMapper = (options: SimpleStreamOptions) => Readonly<Record<string, unknown>>;

export interface ProviderModelDiscoveryConfig {
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly fetch?: FetchImpl;
	readonly authenticated?: boolean;
}

export type ProviderModelDiscoveryPreparer = (config: ProviderModelDiscoveryConfig) => ProviderModelDiscoveryConfig;

export interface ProviderDefinition {
	readonly id: string;
	readonly name: string;

	readonly available?: boolean;

	readonly showInLoginList?: boolean;

	readonly envKeys?: KeyResolver;

	readonly allowsMissingApiKey?: boolean;

	// Runs before API-specific option mapping, so it may re-route the model's API.
	readonly prepareModel?: ProviderModelPreparer;

	readonly prepareRequest?: ProviderRequestPreparer;

	readonly mapSimpleOptions?: ProviderSimpleOptionsMapper;

	readonly prepareModelDiscovery?: ProviderModelDiscoveryPreparer;

	readonly login?: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials | string>;

	/** Key an optional-key login stores on empty input; marks keyless mode, never counts as auth. */
	readonly emptyKeyFallback?: string;

	readonly refreshToken?: (credentials: OAuthCredentials, signal?: AbortSignal) => Promise<OAuthCredentials>;
	/** `jwt-or-never`: the credential expires only by its JWT `exp` claim, if any; stored timestamps are ignored. */
	readonly credentialExpiry?: "jwt-or-never";
	readonly getApiKey?: (credentials: OAuthCredentials) => string;

	readonly storeCredentialsAs?: string;

	readonly callbackPort?: number;

	readonly pasteCodeFlow?: boolean;
}
