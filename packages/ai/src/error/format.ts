import {
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	rewriteCopilotError,
} from "../utils/http-inspector";
import { formatErrorMessageWithRetryAfter } from "../utils/retry-after";
import { LLAMA_CPP_TOOL_CALL_PARSE_PATTERN } from "./flags";

function rewriteOllamaToolCallJsonError(message: string): string {
	if (!LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(message)) return message;
	return `Local Ollama model emitted malformed tool-call JSON and llama.cpp rejected it (HTTP 500). This is usually a deterministic model-output failure after context degradation, not a transient server outage; reload the model or reduce context, then retry.\n${message}`;
}

export interface FormatMessageOptions {
	rawRequestDump?: RawHttpRequestDump;

	capturedErrorResponse?: CapturedHttpErrorResponse;

	provider?: string;
}

export async function formatMessage(error: unknown, opts: FormatMessageOptions = {}): Promise<string> {
	let message = opts.rawRequestDump
		? await finalizeErrorMessage(error, opts.rawRequestDump, opts.capturedErrorResponse)
		: formatErrorMessageWithRetryAfter(error);
	if (opts.provider === "github-copilot") {
		message = rewriteCopilotError(message, error, opts.provider);
	}
	if (opts.provider === "ollama") {
		message = rewriteOllamaToolCallJsonError(message);
	}
	return message;
}
