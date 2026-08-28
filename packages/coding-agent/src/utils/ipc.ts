import { logger } from "@oh-my-pi/pi-utils";

export function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value != null &&
		(typeof value === "object" || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

export function safeSend(proc: { send(message: unknown): unknown }, message: unknown, label: string): void {
	try {
		const result = proc.send(message);
		if (isThenable(result)) result.then(undefined, () => {});
	} catch (error) {
		logger.debug(`${label}: send to subprocess failed`, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
