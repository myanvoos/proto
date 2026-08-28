import type { Api } from "../types";
import type { AbortSourceTracker } from "../utils/abort";
import type { CapturedHttpErrorResponse, RawHttpRequestDump } from "../utils/http-inspector";
import { classify, classifyMessage, status } from "./flags";
import { formatMessage } from "./format";

export interface FinalizeOptions {
	api?: Api;

	provider?: string;

	model?: string;

	signal?: AbortSignal;

	abortTracker?: AbortSourceTracker;

	rawRequestDump?: RawHttpRequestDump;

	capturedErrorResponse?: CapturedHttpErrorResponse;
}

export interface FinalizeResult {
	id: number;

	status: number | undefined;

	stopReason: "aborted" | "error";

	message: string;
}

export async function finalize(error: unknown, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
	const aborted = opts.abortTracker ? opts.abortTracker.wasCallerAbort() : opts.signal?.aborted === true;
	const currentStatus = status(error) ?? opts.capturedErrorResponse?.status;

	let message: string;
	try {
		const localReason = opts.abortTracker?.getLocalAbortReason();
		message = localReason?.message ?? (await formatMessage(error, opts));
	} catch {
		message = error instanceof Error ? error.message : String(error);
	}

	const id = classifyMessage({
		api: opts.api,
		provider: opts.provider,
		model: opts.model,
		errorId: classify(error, opts.api),
		errorMessage: message,
		errorStatus: currentStatus,
	});

	return {
		id,
		status: currentStatus,
		stopReason: aborted ? "aborted" : "error",
		message,
	};
}
