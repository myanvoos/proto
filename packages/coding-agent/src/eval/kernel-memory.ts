import { dlopen, FFIType, type Library, ptr } from "bun:ffi";
export interface KernelPrivateMemory {
	bytes: number | null;
	metric: "phys_footprint" | "smaps_private" | "unsupported";
	reason?: string;
}
let libproc:
	| Library<{
			proc_pid_rusage: {
				args: [typeof FFIType.i32, typeof FFIType.i32, typeof FFIType.ptr];
				returns: typeof FFIType.i32;
			};
	  }>
	| undefined;

/** Per-process private physical footprint; deliberately never sums shared RSS. */
export async function measureKernelPrivateMemory(pid: number): Promise<KernelPrivateMemory> {
	try {
		if (process.platform === "darwin") {
			libproc ??= dlopen("/usr/lib/libproc.dylib", {
				proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			});
			const usage = new Uint8Array(256);
			if (libproc.symbols.proc_pid_rusage(pid, 2, ptr(usage)) !== 0)
				throw new Error("proc_pid_rusage refused process");
			// rusage_info_v2: UUID[16], seven uint64 counters, then ri_phys_footprint.
			const bytes = Number(new DataView(usage.buffer).getBigUint64(72, true));
			return { bytes, metric: "phys_footprint" };
		}
		if (process.platform === "linux") {
			let source: string;
			try {
				source = await Bun.file(`/proc/${pid}/smaps_rollup`).text();
			} catch {
				source = await Bun.file(`/proc/${pid}/smaps`).text();
			}
			let bytes = 0;
			let found = false;
			for (const match of source.matchAll(/^Private_(?:Clean|Dirty|Hugetlb):\s+(\d+) kB$/gm)) {
				bytes += Number(match[1]) * 1024;
				found = true;
			}
			if (!found) throw new Error("No private mappings available");
			return { bytes, metric: "smaps_private" };
		}
		return {
			bytes: null,
			metric: "unsupported",
			reason: "Private footprint measurement is supported only on macOS and Linux",
		};
	} catch (error) {
		return {
			bytes: null,
			metric: process.platform === "darwin" ? "phys_footprint" : "smaps_private",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export interface ResidentKernel {
	readonly id: string;
	readonly pid?: number;
	readonly forkserverPid?: number;
	isAlive(): boolean;
	isBusy(): Promise<boolean | undefined>;
	shutdown(): Promise<{ confirmed: boolean }>;
}
export interface KernelResidencyReport {
	residency: "resident" | "parked" | "unmeasured";
	privateBytes: number | null;
	memoryMetric: KernelPrivateMemory["metric"];
	residencyReason?: string;
}
interface ResidentEntry {
	kernel: ResidentKernel;
	lastUsed: number;
	report: KernelResidencyReport;
	active: number;
	confirmedStopped?: boolean;
}

/** Residency only: execution admission and turn limits remain the caller's responsibility. */
export class KernelMemoryResidency {
	readonly #entries = new Map<string, ResidentEntry>();
	#gate: Promise<void> = Promise.resolve();
	constructor(
		readonly budget: () => Promise<{ bytes: number; maxResidentCount: number }>,
		readonly safeToPark: (id: string) => boolean,
		readonly sharedProcesses?: { pids(): number[]; releaseIdle(): Promise<boolean> },
	) {}

	forget(id: string): void {
		this.#entries.delete(id);
	}

	register(kernel: ResidentKernel): void {
		this.#entries.set(kernel.id, {
			kernel,
			active: 0,
			lastUsed: Date.now(),
			report: {
				residency: "unmeasured",
				privateBytes: null,
				memoryMetric: "unsupported",
				residencyReason: "Not measured yet",
			},
		});
	}
	activity(id: string, delta: 1 | -1): void {
		const entry = this.#entries.get(id);
		if (entry) {
			entry.active += delta;
			entry.lastUsed = Date.now();
		}
	}
	report(id: string): KernelResidencyReport | undefined {
		return this.#entries.get(id)?.report;
	}

	async start<T extends ResidentKernel>(launch: () => Promise<T>): Promise<T> {
		const prior = this.#gate;
		const next = Promise.withResolvers<void>();
		this.#gate = next.promise;
		await prior;
		try {
			await this.#enforce(undefined, true);
			const kernel = await launch();
			this.register(kernel);
			await this.#enforce(kernel.id, false);
			return kernel;
		} finally {
			next.resolve();
		}
	}

	async enforce(protectedId?: string, starting = false): Promise<void> {
		const prior = this.#gate;
		const next = Promise.withResolvers<void>();
		this.#gate = next.promise;
		await prior;
		try {
			await this.#enforce(protectedId, starting);
		} finally {
			next.resolve();
		}
	}

	async #enforce(protectedId: string | undefined, starting: boolean): Promise<void> {
		const limit = await this.budget();
		if (
			!Number.isSafeInteger(limit.bytes) ||
			limit.bytes < 1 ||
			!Number.isSafeInteger(limit.maxResidentCount) ||
			limit.maxResidentCount < 1
		)
			throw new Error("Python residency budget bytes and maximum resident count must be positive safe integers");
		for (const entry of this.#entries.values()) {
			if (!entry.kernel.isAlive() && !entry.confirmedStopped)
				entry.confirmedStopped = (await entry.kernel.shutdown()).confirmed;
		}
		const resident = [...this.#entries.values()].filter(entry => entry.kernel.isAlive() || !entry.confirmedStopped);
		let total = 0;
		let unknown = false;
		const servers = new Set<number>(this.sharedProcesses?.pids());
		for (const entry of resident) {
			const memory =
				entry.kernel.pid === undefined
					? {
							bytes: null,
							metric: "unsupported" as const,
							reason: "Remote memory is not measured by the local host",
						}
					: await measureKernelPrivateMemory(entry.kernel.pid);
			entry.report = {
				residency: memory.bytes === null ? "unmeasured" : "resident",
				privateBytes: memory.bytes,
				memoryMetric: memory.metric,
				residencyReason: memory.reason,
			};
			if (memory.bytes === null) unknown = true;
			else total += memory.bytes;
			if (entry.kernel.forkserverPid) servers.add(entry.kernel.forkserverPid);
		}
		for (const pid of servers) {
			const memory = await measureKernelPrivateMemory(pid);
			if (memory.bytes === null) unknown = true;
			else total += memory.bytes;
		}
		let count = resident.length;
		if (!unknown && total <= limit.bytes && count + Number(starting) <= limit.maxResidentCount) return;
		if (!unknown && this.sharedProcesses && (await this.sharedProcesses.releaseIdle()))
			return this.#enforce(protectedId, starting);
		const reason = unknown ? "Private memory pressure is unknown" : "Private memory residency budget exceeded";
		for (const entry of resident.sort((a, b) => a.lastUsed - b.lastUsed)) {
			if (unknown || entry.kernel.id === protectedId || entry.active > 0 || !this.safeToPark(entry.kernel.id))
				continue;
			if ((await entry.kernel.isBusy()) !== false) continue;
			// The status probe awaited: never race a newly admitted execution or dirty state.
			if (entry.active > 0 || !this.safeToPark(entry.kernel.id)) continue;
			const result = await entry.kernel.shutdown();
			if (!result.confirmed) continue;
			entry.confirmedStopped = true;
			total -= entry.report.privateBytes ?? 0;
			count--;
			entry.report = {
				...entry.report,
				residency: "parked",
				privateBytes: 0,
				residencyReason: "Idle LRU; durable namespace retained",
			};
			if (total <= limit.bytes && count + Number(starting) <= limit.maxResidentCount) return;
		}
		for (const entry of resident) if (entry.kernel.isAlive()) entry.report.residencyReason = reason;
		if (starting)
			throw new Error(
				`${reason}; no safely durable idle kernel can be parked. Busy, dirty, and unmeasured kernels are retained.`,
			);
	}
}
