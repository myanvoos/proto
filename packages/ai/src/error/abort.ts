import { attach, create, Flag } from "./flags";

export class AbortError extends Error {
	constructor(message = "Request was aborted", options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AbortError";
		attach(this, create(Flag.Abort));
	}
}

/**
 * The text a caller gave `AbortController.abort(reason)`, a string or an `Error` other than an abort, such as the coding
 * agent's user-interrupt label; `undefined` for a bare `abort()`, whose reason is the default `AbortError`.
 */
export function callerAbortReason(signal: AbortSignal | undefined): string | undefined {
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim().length > 0) return reason;
	if (reason instanceof Error && reason.name !== "AbortError" && reason.message.trim().length > 0)
		return reason.message;
	return undefined;
}
