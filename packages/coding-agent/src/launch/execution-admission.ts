import { atomicWriteFile, isEnoent, logger } from "@oh-my-pi/pi-utils";
import {
	ExecutionAdmission,
	type ExecutionBroker,
	type ExecutionPermit,
	type ExecutionTurn,
} from "../task/execution-admission";
import { type DaemonBrokerClient, daemonClientForProject } from "./client";

export const EXECUTION_ADMISSION_CAPABILITY = "execution-admission";

interface BrokerLease {
	ownerPid: number;
	nodeId: string;
	treeId: string;
	controller: AbortController;
	release(): void;
	ready: Promise<void>;
	granted: boolean;
	settled: Promise<void>;
}

/** Broker-owned permits span all session hosts connected to this project broker. */
export class BrokerExecutionAdmission {
	readonly #scheduler = new ExecutionAdmission();
	readonly #leases = new Map<string, BrokerLease>();
	#reaper?: NodeJS.Timeout;
	#persistTail: Promise<void> = Promise.resolve();

	constructor(
		readonly limit = 32,
		readonly filePath?: string,
	) {}

	async initialize(): Promise<void> {
		if (!this.filePath) return;
		let raw: unknown;
		try {
			raw = await Bun.file(this.filePath).json();
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		if (!Array.isArray(raw) || raw.length > this.limit) throw new Error("Invalid persisted broker execution leases");
		const restored: Array<{ leaseId: string; ownerPid: number; nodeId: string; treeId: string; restored: true }> = [];
		const ids = new Set<string>();
		for (const item of raw) {
			if (
				!item ||
				typeof item !== "object" ||
				typeof item.leaseId !== "string" ||
				typeof item.nodeId !== "string" ||
				typeof item.treeId !== "string" ||
				!Number.isSafeInteger(item.ownerPid)
			)
				throw new Error("Invalid persisted execution lease");
			if (ids.has(item.leaseId)) throw new Error("Duplicate persisted execution lease");
			ids.add(item.leaseId);
			try {
				process.kill(item.ownerPid, 0);
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") continue;
				throw error;
			}
			restored.push({
				leaseId: item.leaseId,
				ownerPid: item.ownerPid,
				nodeId: item.nodeId,
				treeId: item.treeId,
				restored: true,
			});
		}
		await Promise.all(restored.map(item => this.acquire(item)));
		await this.#persist();
	}

	async acquire(options: {
		leaseId: string;
		ownerPid: number;
		nodeId: string;
		treeId: string;
		restored?: boolean;
	}): Promise<void> {
		if (this.#leases.size >= 4096) throw new Error("Broker execution admission queue is full");
		if ([options.leaseId, options.nodeId, options.treeId].some(id => id.length === 0 || id.length > 256))
			throw new Error("Execution lease identities must contain 1–256 characters");
		if (this.#leases.has(options.leaseId)) throw new Error("Execution lease identity is already in use");
		if (!Number.isSafeInteger(options.ownerPid) || options.ownerPid <= 0)
			throw new Error("Invalid execution owner pid");
		const ready = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const controller = new AbortController();
		const lease: BrokerLease = {
			...options,
			controller,
			release: released.resolve,
			ready: ready.promise,
			granted: options.restored === true,
			settled: Promise.resolve(),
		};
		this.#leases.set(options.leaseId, lease);
		this.#reaper ??= setInterval(() => this.#reap(), 1_000);
		this.#reaper.unref();
		lease.settled = this.#scheduler
			.runTurn(
				{ nodeId: options.nodeId, treeId: options.treeId, maxConcurrency: this.limit, signal: controller.signal },
				async () => {
					lease.granted = true;
					await this.#persist();
					ready.resolve();
					await released.promise;
				},
			)
			.catch(error => ready.reject(error))
			.finally(async () => {
				this.#leases.delete(options.leaseId);
				await this.#persist();
				if (this.#leases.size === 0) {
					clearInterval(this.#reaper);
					this.#reaper = undefined;
				}
			});
		void lease.settled.catch(error => ready.reject(error));
		await ready.promise;
	}

	async release(leaseId: string, ownerPid: number): Promise<void> {
		const lease = this.#leases.get(leaseId);
		if (!lease) return;
		if (lease.ownerPid !== ownerPid) throw new Error("Execution lease belongs to another host");
		const granted = lease.granted;
		lease.granted = false;
		try {
			await this.#persist();
		} catch (error) {
			lease.granted = granted;
			throw error;
		}
		lease.controller.abort(new Error("Execution lease released"));
		lease.release();
		await lease.settled;
	}

	/** Broker teardown does not imply the supervised host has settled; retain its durable reservation. */
	async detach(): Promise<void> {
		clearInterval(this.#reaper);
		this.#reaper = undefined;
		await this.#persist();
	}

	async close(): Promise<void> {
		await Promise.all([...this.#leases].map(([id, lease]) => this.release(id, lease.ownerPid)));
		clearInterval(this.#reaper);
	}

	#persist(): Promise<void> {
		if (!this.filePath) return Promise.resolve();
		const text = JSON.stringify(
			[...this.#leases]
				.filter(([, lease]) => lease.granted)
				.map(([leaseId, lease]) => ({
					leaseId,
					ownerPid: lease.ownerPid,
					nodeId: lease.nodeId,
					treeId: lease.treeId,
				})),
		);
		const pending = this.#persistTail.then(() => atomicWriteFile(this.filePath!, text));
		this.#persistTail = pending.catch(() => {});
		return pending;
	}

	#reap(): void {
		for (const [id, lease] of this.#leases) {
			try {
				process.kill(lease.ownerPid, 0);
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code === "ESRCH")
					void this.release(id, lease.ownerPid).catch(error =>
						logger.warn("Failed to retire dead host execution lease", { leaseId: id, error: String(error) }),
					);
			}
		}
	}
}

export class BrokerExecutionAdmissionClient implements ExecutionBroker {
	constructor(readonly client: DaemonBrokerClient) {}

	async acquire(turn: ExecutionTurn): Promise<ExecutionPermit> {
		await this.client.ensureCapability(EXECUTION_ADMISSION_CAPABILITY, turn.signal);
		turn.signal.throwIfAborted();
		const leaseId = crypto.randomUUID();
		const release = async () => {
			await this.client.request({ op: "execution-release", leaseId, ownerPid: process.pid });
		};
		try {
			await this.client.request(
				{ op: "execution-acquire", leaseId, ownerPid: process.pid, nodeId: turn.nodeId, treeId: turn.treeId },
				turn.signal,
			);
			turn.signal.throwIfAborted();
			return { release };
		} catch (error) {
			// Cancellation/response loss may race a granted lease. Reconnect and explicitly retire that identity.
			await release();
			throw error;
		}
	}
}

export async function createBrokerExecutionAdmissionClient(
	projectDir: string,
	runtimeDir?: string,
): Promise<ExecutionBroker> {
	return new BrokerExecutionAdmissionClient(await daemonClientForProject(projectDir, { runtimeDir }));
}
