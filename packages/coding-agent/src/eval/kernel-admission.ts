/** A failed start whose subprocess still needs confirmed shutdown before admission can be released. */
export class KernelStartupCleanupError extends Error {
	constructor(
		error: unknown,
		readonly shutdown: () => Promise<{ confirmed: boolean }>,
	) {
		super(error instanceof Error ? error.message : String(error), { cause: error });
		this.name = "KernelStartupCleanupError";
	}
}

/** Counts starting, live, and not-yet-confirmed-stopped interpreters across both languages. */
export class KernelAdmission {
	readonly #owners = new Map<string, number>();
	#count = 0;

	constructor(
		readonly maxKernels = 256,
		readonly maxKernelsPerOwner = 16,
	) {}

	reserve(ownerId: string): () => void {
		const owned = this.#owners.get(ownerId) ?? 0;
		if (this.#count >= this.maxKernels || owned >= this.maxKernelsPerOwner) {
			throw new Error(
				`Interpreter limit reached (${this.maxKernels} total, ${this.maxKernelsPerOwner} per owner); reuse an existing lane or dispose an unused kernel before starting another.`,
			);
		}
		this.#count += 1;
		this.#owners.set(ownerId, owned + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#count -= 1;
			const remaining = (this.#owners.get(ownerId) ?? 1) - 1;
			if (remaining === 0) this.#owners.delete(ownerId);
			else this.#owners.set(ownerId, remaining);
		};
	}
}

export const kernelAdmission = new KernelAdmission();
