export type AwsCredentialsErrorKind =
	| "resolution"
	| "sso-token-missing"
	| "sso-token-expired"
	| "sso-role"
	| "credential-process"
	| "web-identity"
	| "container"
	| "profile"
	| "assume-role";

export class AwsCredentialsError extends Error {
	readonly kind: AwsCredentialsErrorKind;

	constructor(message: string, kind: AwsCredentialsErrorKind, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AwsCredentialsError";
		this.kind = kind;
	}
}

export class EventStreamFrameError extends Error {
	constructor(detail: string) {
		super(`eventstream: ${detail}`);
		this.name = "EventStreamFrameError";
	}
}
