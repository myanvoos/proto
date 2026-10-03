import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";

function oneLine(message: string): string {
	return truncateToWidth(replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.LINE);
}

/** First failure: the store retries the whole transcript on the next write, so durability is not lost yet. */
export function formatPersistenceFailure(message: string): string {
	return `Session persistence failed: ${oneLine(message)}. Writes are retried; unsaved entries stay in memory until the store accepts them again.`;
}

/** Emitted only when the failure is still latched at dispose: the retry never landed. */
export function formatPersistenceDurabilityFailure(message: string): string {
	return `Session persistence is still failing at shutdown: ${oneLine(message)}. The session transcript is not durable; unsaved entries are lost.`;
}

/** Write one stderr line and wait for it to flush; a closed or broken stderr settles instead of stranding the caller. */
export async function writeStderrLineFlushed(line: string): Promise<void> {
	try {
		if (process.stderr.write(`${line}\n`)) return;
	} catch {
		return;
	}
	const { promise, resolve } = Promise.withResolvers<void>();
	const settle = (): void => {
		process.stderr.off("drain", settle);
		process.stderr.off("error", settle);
		process.stderr.off("close", settle);
		resolve();
	};
	process.stderr.on("drain", settle);
	process.stderr.on("error", settle);
	process.stderr.on("close", settle);
	await promise;
}
