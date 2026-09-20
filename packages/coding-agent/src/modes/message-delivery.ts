import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { InteractiveModeContext } from "./types";

export interface MessageDeliveryOptions {
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];

	/** Keep the editor draft when the first message starts a turn; for deliveries the user did not just type. */
	preserveDraft?: boolean;
}

export type MessageDeliveryOutcome = "compaction" | "sent" | "queued";

export interface MessageDeliveryResult {
	outcome: MessageDeliveryOutcome;

	/** How many messages reached the session; short of `messages.length` only when `error` is set. */
	delivered: number;

	error?: unknown;
}

/**
 * Hands composed messages to the session the way `/queue` does: the first one starts a turn when the
 * agent is idle and nothing is already queued, every other one lands on the follow-up queue. Shared
 * by `/queue` and by timed deliveries so both honour compaction, streaming, and turn-start ordering
 * identically.
 */
export async function deliverMessages(
	ctx: InteractiveModeContext,
	messages: readonly string[],
	options: MessageDeliveryOptions = {},
): Promise<MessageDeliveryResult> {
	const images = options.images?.length ? [...options.images] : undefined;
	const imageLinks = options.imageLinks ? [...options.imageLinks] : images ? images.map(() => undefined) : undefined;

	if (ctx.session.isCompacting) {
		for (const [index, message] of messages.entries()) {
			ctx.compactionQueuedMessages.push({
				text: message,
				mode: "followUp",
				images: index === 0 ? images : undefined,
			});
		}
		return { outcome: "compaction", delivered: messages.length };
	}

	const startImmediately = !ctx.session.isStreaming && ctx.session.queuedMessageCount === 0;
	const outcome: MessageDeliveryOutcome = startImmediately ? "sent" : "queued";
	let delivered = 0;
	try {
		if (startImmediately && ctx.onInputCallback) {
			const submission = ctx.startPendingSubmission(
				{ text: messages[0] ?? "", images, imageLinks, streamingBehavior: "followUp" },
				{ preserveDraft: options.preserveDraft },
			);
			ctx.onInputCallback(submission);
			delivered = 1;
		}
		while (delivered < messages.length) {
			const message = messages[delivered] ?? "";
			const messageImages = delivered === 0 ? images : undefined;
			await ctx.withLocalSubmission(
				message,
				async () => {
					if (startImmediately && delivered === 0) {
						await ctx.session.prompt(message, { images: messageImages, streamingBehavior: "followUp" });
					} else {
						await ctx.session.followUp(message, messageImages);
					}
				},
				{ imageCount: messageImages?.length ?? 0 },
			);
			delivered++;
		}
	} catch (error) {
		return { outcome, delivered, error };
	}
	return { outcome, delivered };
}
