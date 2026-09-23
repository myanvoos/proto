import { CliUsageError } from "@oh-my-pi/pi-utils/cli";

/** Reject invalid dimensions/counts before allocating render state or touching session storage. */
export function validatePositiveIntegerFlag(name: string, value: number | undefined): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
		throw new CliUsageError(`--${name} must be a positive integer`);
	}
}
