import { CompactionCancelledError, type CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import type { CompactOptions } from "./types";

interface AdvisoryCompactionSession {
	advisoryCompactionAllowed?(): boolean;
}

interface CompactableSession extends AdvisoryCompactionSession {
	compact(instructions?: string, options?: CompactOptions): Promise<CompactionResult>;
}

/**
 * Extension event handlers request compaction on their own schedule, but the session owns when
 * context maintenance is worth its prompt-cache invalidation: a compaction rewrites the cached
 * prefix, and cache writes cost far more than cache reads. An advisory request that arrives while
 * the session is still well below its own compaction threshold is cancelled instead of honored.
 *
 * Suppression reports the standard cancellation error so requesters release their in-flight state
 * and stay quiet, exactly as they do when a user aborts a compaction.
 */
export function advisoryCompactionSuppressed(
	session: AdvisoryCompactionSession,
	instructionsOrOptions: string | CompactOptions | undefined,
	advisory: boolean | undefined,
): boolean {
	if (advisory !== true || session.advisoryCompactionAllowed?.() !== false) return false;
	const options =
		instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
	options?.onError?.(new CompactionCancelledError());
	return true;
}

export async function runExtensionCompact(
	session: CompactableSession,
	instructionsOrOptions: string | CompactOptions | undefined,
	advisory?: boolean,
): Promise<void> {
	if (advisoryCompactionSuppressed(session, instructionsOrOptions, advisory)) return;
	const options =
		instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
	const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : options?.customInstructions;
	const { onComplete, onError, ...compactOptions } = options ?? {};
	let result: CompactionResult;
	try {
		// Own callbacks here: session.compact also rejects after reporting failures, and extensions may
		// intentionally leave the promise detached when they supply an error callback.
		result = await session.compact(instructions, options ? compactOptions : undefined);
	} catch (error) {
		if (!onError) throw error;
		onError(error instanceof Error ? error : new Error(String(error)));
		return;
	}
	onComplete?.(result);
}

interface SetModelCapableSession {
	modelRegistry: { getApiKey(model: Model): Promise<string | undefined> };
	setModel(model: Model): Promise<unknown>;
}

export async function runExtensionSetModel(session: SetModelCapableSession, model: Model): Promise<boolean> {
	const key = await session.modelRegistry.getApiKey(model);
	if (!key) return false;
	await session.setModel(model);
	return true;
}
