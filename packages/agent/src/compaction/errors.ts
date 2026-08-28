export class CompactionCancelledError extends Error {
	override readonly name = "CompactionCancelledError" as const;

	constructor(message = "Compaction cancelled", options?: ErrorOptions) {
		super(message, options);
	}
}

export class NativeCompactionError extends Error {
	override readonly name = "NativeCompactionError" as const;

	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
	}
}

export type CompactionOutcome = "ok" | "cancelled" | "failed";
