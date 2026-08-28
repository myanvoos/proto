import { ProviderHttpError } from "./classes";
import { attach, create, Flag } from "./flags";

export type ProviderResponseErrorKind =
	| "incomplete-stream"
	| "output"
	| "empty-body"
	| "empty-output"
	| "envelope"
	| "content-blocked"
	| "runtime";

export interface ProviderResponseErrorOptions {
	provider?: string;
	kind?: ProviderResponseErrorKind;
	cause?: unknown;
}

export class ProviderResponseError extends Error {
	readonly provider: string | undefined;
	readonly kind: ProviderResponseErrorKind;

	constructor(message: string, options: ProviderResponseErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderResponseError";
		this.provider = options.provider;
		this.kind = options.kind ?? "output";

		if (this.kind === "content-blocked") attach(this, create(Flag.ContentBlocked));
		else if (this.kind === "empty-output") attach(this, create(Flag.Transient, Flag.EmptyResponse));
		else if (this.kind === "incomplete-stream" || this.kind === "empty-body") attach(this, create(Flag.Transient));
	}
}

export class DevinApiError extends ProviderHttpError {
	override readonly name = "DevinApiError";
}

export class GitLabDuoApiError extends ProviderHttpError {
	override readonly name = "GitLabDuoApiError";
}

export class GitLabDuoWorkflowApiError extends ProviderHttpError {
	override readonly name = "GitLabDuoWorkflowApiError";
}
