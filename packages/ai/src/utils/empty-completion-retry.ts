import { scheduler } from "node:timers/promises";
import type { AssistantMessage, AssistantMessageEvent, Context } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

export const MAX_EMPTY_COMPLETION_RETRIES = 2;
export const EMPTY_COMPLETION_BASE_DELAY_MS = 500;

const NON_WHITESPACE_RE = /\S/;

export function hasVisibleAssistantContent(message: AssistantMessage): boolean {
	for (const block of message.content) {
		if (block.type === "image") return true;
		if (block.type === "toolCall") return true;
		if (block.type === "text" && NON_WHITESPACE_RE.test(block.text)) return true;
	}
	return false;
}

function isMeaningfulCompletionEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "image_end":
			return true;
		case "toolcall_start":
		case "toolcall_end":
			return true;
		default:
			return false;
	}
}

interface EmptyCompletionRetryOptions {
	signal?: AbortSignal;
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	acceptEmptyResponse?: boolean;
}

export function withEmptyCompletionRetry<M, O extends EmptyCompletionRetryOptions>(
	model: M,
	context: Context,
	options: O | undefined,
	attempt: (model: M, context: Context, options?: O) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const signal = options?.signal;
	void (async () => {
		for (let emptyAttempt = 0; ; emptyAttempt++) {
			const inner = attempt(model, context, options);
			const buffered: AssistantMessageEvent[] = [];
			let committed = options?.acceptEmptyResponse === true;
			let terminal: AssistantMessageEvent | undefined;
			const flush = (): void => {
				for (const event of buffered) outer.push(event);
				buffered.length = 0;
			};
			try {
				for await (const event of inner) {
					if (event.type === "done" || event.type === "error") {
						terminal = event;
						break;
					}

					if (!committed && !isMeaningfulCompletionEvent(event)) {
						buffered.push(event);
						continue;
					}
					committed = true;
					flush();
					outer.push(event);
					if (outer.done) return;
				}
			} catch (error) {
				flush();
				outer.fail(error);
				return;
			}

			const message = terminal?.type === "done" ? terminal.message : undefined;
			const isRetryableEmpty =
				options?.acceptEmptyResponse !== true &&
				!committed &&
				message !== undefined &&
				message.stopReason === "stop" &&
				message.stopDetails?.type !== "pause_turn" &&
				!message.errorMessage &&
				(message.usage?.output ?? 0) <= 1 &&
				!hasVisibleAssistantContent(message);

			if (isRetryableEmpty && emptyAttempt < MAX_EMPTY_COMPLETION_RETRIES && !signal?.aborted) {
				const delayMs = EMPTY_COMPLETION_BASE_DELAY_MS * 2 ** emptyAttempt;
				try {
					if (options?.providerRetryWait) await options.providerRetryWait(delayMs, signal);
					else await scheduler.wait(delayMs, { signal });
				} catch (waitError) {
					flush();
					if (signal?.aborted) {
						if (terminal) outer.push(terminal);
					} else {
						outer.fail(waitError);
					}
					return;
				}

				continue;
			}

			flush();
			if (terminal) {
				outer.push(terminal);
			} else if (!outer.done) {
				try {
					outer.end(await inner.result());
				} catch (error) {
					outer.fail(error);
				}
			}
			return;
		}
	})();
	return outer;
}
