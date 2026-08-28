import { type FluentType, type } from "@oh-my-pi/omptype";
import {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthCredentialSnapshotEntry,
	type DisabledCredentialSummary,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type RemoteOAuthCredential,
	type SnapshotCredential,
} from "../auth-storage";
import type {
	ClientUsageReportRequest,
	ClientUsageReportResponse,
	ClientUsageSummaryResponse,
	CredentialBlockRequest,
	CredentialBlockResponse,
	CredentialBlockSnapshot,
	CredentialBlocksDeleteResponse,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	DisabledCredentialsResponse,
	HealthzResponse,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEntryEvent,
	SnapshotStreamEvent,
	SnapshotStreamRemovedEvent,
	SnapshotStreamSnapshotEvent,
	UsageHistoryResponse,
	UsageResponse,
	UsageStaleResponse,
} from "./types";

export const oauthCredentialSchema: FluentType<OAuthCredential> = type({
	"apiEndpoint?": "string",
	type: "'oauth'",
	refresh: type("string").narrow(
		(value, ctx) =>
			value !== REMOTE_REFRESH_SENTINEL ||
			ctx.mustBe(`not equal to the remote sentinel (${REMOTE_REFRESH_SENTINEL})`),
	),
	access: type("string").atLeastLength(1),
	expires: "number",
	"enterpriseUrl?": "string",
	"projectId?": "string",
	"email?": "string",
	"accountId?": "string",
	"orgId?": "string",
	"orgName?": "string",
	"authorizedAt?": "number",
});

export const remoteOauthCredentialSchema: FluentType<RemoteOAuthCredential> = type({
	"apiEndpoint?": "string",
	type: "'oauth'",
	refresh: type.enumerated(REMOTE_REFRESH_SENTINEL),
	access: type("string").atLeastLength(1),
	expires: "number",
	"enterpriseUrl?": "string",
	"projectId?": "string",
	"email?": "string",
	"accountId?": "string",
	"orgId?": "string",
	"orgName?": "string",
	"authorizedAt?": "number",
});

export const apiKeyCredentialSchema: FluentType<ApiKeyCredential> = type({
	"+": "reject",
	type: "'api_key'",
	key: type("string").atLeastLength(1),
	"source?": "'login'",
});

export const writableAuthCredentialSchema: FluentType<AuthCredential> =
	oauthCredentialSchema.or(apiKeyCredentialSchema);

export const snapshotCredentialSchema: FluentType<SnapshotCredential> =
	remoteOauthCredentialSchema.or(apiKeyCredentialSchema);

export const credentialSnapshotEntrySchema: FluentType<AuthCredentialSnapshotEntry> = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	credential: snapshotCredentialSchema,
	identityKey: "string | null",
});

export const credentialBlockSnapshotSchema: FluentType<CredentialBlockSnapshot> = type({
	"+": "reject",
	providerKey: type("string").atLeastLength(1),
	blockScope: "string",
	blockedUntilMs: "number",
	"updatedAtMs?": "number",
});

export const snapshotEntrySchema: FluentType<SnapshotEntry> = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	credential: snapshotCredentialSchema,
	identityKey: "string | null",
	rotatesInMs: "number | null",
	"blocks?": credentialBlockSnapshotSchema.array(),
});

export const refresherScheduleSchema: FluentType<RefresherSchedule> = type({
	"+": "reject",
	enabled: "boolean",
	intervalMs: "number",
	skewMs: "number",
	nextSweepInMs: "number",
});

export const snapshotResponseSchema: FluentType<SnapshotResponse> = type({
	"+": "reject",
	generation: "number.integer",
	generatedAt: "number",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	credentials: snapshotEntrySchema.array(),
});

export const snapshotStreamSnapshotEventSchema: FluentType<SnapshotStreamSnapshotEvent> = type({
	"+": "reject",
	generation: "number.integer",
	generatedAt: "number",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	credentials: snapshotEntrySchema.array(),
	kind: "'snapshot'",
});

export const snapshotStreamEntryEventSchema: FluentType<SnapshotStreamEntryEvent> = type({
	"+": "reject",
	kind: "'entry'",
	generation: "number.integer",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	entry: snapshotEntrySchema,
});

export const snapshotStreamRemovedEventSchema: FluentType<SnapshotStreamRemovedEvent> = type({
	"+": "reject",
	kind: "'removed'",
	generation: "number.integer",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	id: "number.integer",
});

export const snapshotStreamEventSchema: FluentType<SnapshotStreamEvent> = snapshotStreamSnapshotEventSchema
	.or(snapshotStreamEntryEventSchema)
	.or(snapshotStreamRemovedEventSchema);

export const healthzResponseSchema: FluentType<HealthzResponse> = type({
	"+": "reject",
	ok: "boolean",
	"version?": "string",
});

const usageWindowSchema = type({
	id: "string",
	label: "string",
	"durationMs?": "number",
	"resetsAt?": "number",
});

const usageAmountSchema = type({
	"used?": "number",
	"limit?": "number",
	"remaining?": "number",
	"usedFraction?": "number",
	"remainingFraction?": "number",
	unit: "'percent' | 'tokens' | 'requests' | 'usd' | 'minutes' | 'bytes' | 'unknown'",
});

const usageScopeSchema = type({
	provider: "string",
	"accountId?": "string",
	"projectId?": "string",
	"orgId?": "string",
	"modelId?": "string",
	"tier?": "string",
	"windowId?": "string",
	"shared?": "boolean",
});

const usageLimitSchema = type({
	id: "string",
	label: "string",
	scope: usageScopeSchema,
	"window?": usageWindowSchema,
	amount: usageAmountSchema,
	"status?": "'ok' | 'warning' | 'exhausted' | 'unknown'",
	"notes?": "string[]",
});

const usageResetCreditsSchema = type({
	availableCount: "number",
	"credits?": type({
		"grantedAt?": "string",
		"expiresAt?": "string",
		"status?": "string",
	}).array(),
});

const arkUsageReportSchema = type({
	provider: "string",
	fetchedAt: "number",
	limits: usageLimitSchema.array(),
	"resetCredits?": usageResetCreditsSchema,
	"notes?": "string[]",
	"metadata?": { "[string]": "unknown" },
	"raw?": "unknown",
});

export const usageResponseSchema: FluentType<UsageResponse> = type({
	"+": "reject",
	generatedAt: "number",
	reports: arkUsageReportSchema.array(),
});

const usageHistoryEntrySchema = type({
	recordedAt: "number",
	provider: "string",
	accountKey: "string",
	"email?": "string",
	"accountId?": "string",
	limitId: "string",
	label: "string",
	"windowLabel?": "string",
	"usedFraction?": "number",
	"status?": "'ok' | 'warning' | 'exhausted' | 'unknown'",
	"resetsAt?": "number",
});

export const usageHistoryResponseSchema: FluentType<UsageHistoryResponse> = type({
	"+": "reject",
	generatedAt: "number",
	entries: usageHistoryEntrySchema.array(),
});

const observedUsageEntrySchema = type({
	at: "number",
	provider: "string",
	model: "string",
	requests: "number",
	inputTokens: "number",
	outputTokens: "number",
	cacheReadTokens: "number",
	cacheWriteTokens: "number",
	costUsd: "number",
});

export const clientUsageReportRequestSchema: FluentType<ClientUsageReportRequest> = type({
	"+": "reject",
	installId: "string",
	"hostname?": "string",
	entries: observedUsageEntrySchema.array(),
});

export const clientUsageReportResponseSchema: FluentType<ClientUsageReportResponse> = type({
	"+": "reject",
	ok: "boolean",
});

const clientUsageClientSummarySchema = type({
	installId: "string",
	"hostname?": "string",
	firstSeen: "number",
	lastSeen: "number",
	providers: type({
		provider: "string",
		requests: "number",
		inputTokens: "number",
		outputTokens: "number",
		cacheReadTokens: "number",
		cacheWriteTokens: "number",
		costUsd: "number",
	}).array(),
});

export const clientUsageSummaryResponseSchema: FluentType<ClientUsageSummaryResponse> = type({
	"+": "reject",
	generatedAt: "number",
	clients: clientUsageClientSummarySchema.array(),
});

export const credentialRefreshResponseSchema: FluentType<CredentialRefreshResponse> = type({
	"+": "reject",
	entry: credentialSnapshotEntrySchema,
});

export const credentialDisableRequestSchema: FluentType<{ cause?: string }> = type({
	"+": "reject",
	"cause?": "string",
});

export const credentialDisableResponseSchema: FluentType<CredentialDisableResponse> = type({
	"+": "reject",
	ok: "boolean",
});

export const disabledCredentialSummarySchema: FluentType<DisabledCredentialSummary> = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	type: "'oauth' | 'api_key'",
	"email?": "string",
	"accountId?": "string",
	"orgId?": "string",
	"orgName?": "string",
	cause: "string",
	"disabledAtMs?": "number",
});

export const disabledCredentialsResponseSchema: FluentType<DisabledCredentialsResponse> = type({
	"+": "reject",
	generatedAt: "number",
	disabled: disabledCredentialSummarySchema.array(),
});

export const credentialBlockRequestSchema: FluentType<CredentialBlockRequest> = credentialBlockSnapshotSchema;

export const credentialBlockResponseSchema: FluentType<CredentialBlockResponse> = type({
	"+": "reject",
	ok: "boolean",
});

export const credentialBlocksDeleteResponseSchema: FluentType<CredentialBlocksDeleteResponse> = type({
	"+": "reject",
	ok: "boolean",
});

export const usageStaleResponseSchema: FluentType<UsageStaleResponse> = type({
	"+": "reject",
	ok: "boolean",
});

export const credentialUploadRequestSchema: FluentType<CredentialUploadRequest> = type({
	"+": "reject",
	provider: type("string").atLeastLength(1),
	credential: writableAuthCredentialSchema,
});

export const credentialUploadResponseSchema: FluentType<CredentialUploadResponse> = type({
	"+": "reject",
	entries: credentialSnapshotEntrySchema.array(),
});
