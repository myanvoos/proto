import { scheduler } from "node:timers/promises";
import { isRetryableError } from "@oh-my-pi/pi-utils";
import { isCopilotTransientModelError, status } from "../error/flags";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "./retry-after";

export { isCopilotTransientModelError };

const COPILOT_MODEL_RETRY_MAX_ATTEMPTS = 8;

const COPILOT_GENERIC_RETRY_MAX_ATTEMPTS = 3;
const COPILOT_MODEL_RETRY_BASE_DELAY_MS = 400;

const COPILOT_RETRY_AFTER_MAX_WAIT_MS = 30_000;

export async function callWithCopilotModelRetry<T>(
	fn: () => Promise<T>,
	options: { provider: string; signal?: AbortSignal; retryBaseDelayMs?: number; rng?: () => number },
): Promise<T> {
	if (options.provider !== "github-copilot") return fn();

	let lastError: unknown;
	const retryBaseDelayMs = options.retryBaseDelayMs ?? COPILOT_MODEL_RETRY_BASE_DELAY_MS;
	for (let attempt = 0; attempt < COPILOT_MODEL_RETRY_MAX_ATTEMPTS; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;

			if (options.signal?.aborted) throw error;
			const transientModelError = isCopilotTransientModelError(error);
			if (!transientModelError && !isRetryableError(error)) throw error;

			const maxAttempts = transientModelError
				? COPILOT_MODEL_RETRY_MAX_ATTEMPTS
				: COPILOT_GENERIC_RETRY_MAX_ATTEMPTS;
			if (attempt >= maxAttempts - 1) break;

			const backoffDelayMs = transientModelError ? retryBaseDelayMs : retryBaseDelayMs * (attempt + 1);
			let retryAfterMinimumMs = 0;
			if (!transientModelError) {
				const errorStatus = status(error);
				if (errorStatus !== undefined) {
					const retryAfterMs = getRetryAfterMsFromHeaders(getHeadersFromError(error));
					if (retryAfterMs === undefined || retryAfterMs > COPILOT_RETRY_AFTER_MAX_WAIT_MS) throw error;
					retryAfterMinimumMs = retryAfterMs;
				}
			}
			const delayMs = Math.max(Math.floor(backoffDelayMs * (options.rng ?? Math.random)()), retryAfterMinimumMs);
			await scheduler.wait(delayMs, { signal: options.signal });
		}
	}
	throw lastError;
}
