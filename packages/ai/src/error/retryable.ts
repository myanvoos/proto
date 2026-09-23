import { isRetryableError, isUnexpectedSocketCloseMessage } from "@oh-my-pi/pi-utils";
import {
	CODEX_HTTP_BODY_READ_ERROR_PATTERN,
	isRetryableStreamEnvelopeError,
	isTransientStreamDropError,
	isTransientStreamParseError,
	isUsageLimit,
	status,
	TRANSIENT_TRANSPORT_PATTERN,
} from "./flags";

export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && (status === 408 || status === 429 || status >= 500);
}

const PROVIDER_TRANSIENT_EXTRA_PATTERN = /bad record mac|stream error.*received from peer|1302/i;

function isTransientTransportMessage(message: string): boolean {
	return message.includes("tls: bad record mac") || message.includes("type=server_error");
}

// Every 4xx other than 408/429 is terminal: a request the provider rejected as
// malformed, unauthorized, or unentitled fails identically on replay.
export function isProviderRetryableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (isUsageLimit(error)) return false;
	const httpStatus = status(error);
	if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
		return false;
	}
	const msg = error.message.toLowerCase();
	if (
		isUnexpectedSocketCloseMessage(msg) ||
		isTransientTransportMessage(msg) ||
		TRANSIENT_TRANSPORT_PATTERN.test(msg) ||
		CODEX_HTTP_BODY_READ_ERROR_PATTERN.test(msg) ||
		PROVIDER_TRANSIENT_EXTRA_PATTERN.test(msg) ||
		isTransientStreamParseError(error) ||
		isTransientStreamDropError(error) ||
		isRetryableStreamEnvelopeError(error)
	) {
		return true;
	}
	return isRetryableError(error);
}
