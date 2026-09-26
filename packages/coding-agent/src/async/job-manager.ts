import { logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { MonitorDetails } from "../monitor/types";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 15;

export const ASYNC_JOB_MANAGER_SHUTDOWN_REASON = Symbol("AsyncJobManager shutdown");

const POLL_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const;

const POLL_ESCALATION_RESET_MS = 60_000;

interface PollEscalationState {
	level: number;

	lastPollEndAt: number;
}

export type AsyncJobType = "bash" | "worker" | "monitor";

export interface AsyncJobEvent {
	jobId: string;
	label: string;
	sequence: number;
	kind: "output" | "exit" | "limit" | "timeout" | "error";
	text: string;
	timestamp: number;
}

export interface AsyncJob {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	startTime: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;

	latestDetails?: Record<string, unknown>;
	monitor?: MonitorDetails;
	events?: AsyncJobEvent[];

	ownerId?: string;

	agentId?: string;

	queued?: boolean;
}

type AsyncJobDeliverySink = (
	jobId: string,
	text: string,
	job?: AsyncJob,
	event?: AsyncJobEvent,
) => void | Promise<void>;
type AsyncJobCapacityWaiter = (error?: Error) => void;

export interface AsyncJobManagerOptions {
	onJobComplete?: AsyncJobDeliverySink;
	/** Direct finite registrations; queued work uses its external runnable scheduler and total admission below. */
	maxRunningJobs?: number;
	/** Includes queued turns, pre-allocation reservations, and cancelled work still cleaning up. */
	maxTotalJobs?: number;
	maxTotalBytes?: number;
	maxOwnerJobs?: number;
	maxOwnerBytes?: number;
	retentionMs?: number;
	maxRetainedJobs?: number;
	maxRetainedBytes?: number;
	maxDeliveryBytes?: number;
	maxDeliveries?: number;
	maxDeliveryCalls?: number;
	deliveryRetentionMs?: number;
	deliveryTimeoutMs?: number;
}

export interface AsyncJobAdmission {
	/** Re-estimates unused admission atomically; rejection preserves its original byte charge. */
	resize(bytes: number): void;
	/** Releases an unused reservation. After registration, only callback settlement releases it. */
	release(): void;
}

interface AdmissionState {
	ownerId?: string;
	bytes: number;
	registered: boolean;
}

interface AsyncJobDelivery {
	event?: AsyncJobEvent;
	jobId: string;
	text: string;
	attempt: number;
	nextAttemptAt: number;
	ownerId?: string;
	timer?: NodeJS.Timeout;
	bytes: number;
	expiresAt: number;
	expired?: boolean;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
	retainedBytes: number;
	/** Timed-out calls still own a slot and their payload until the sink actually settles. */
	unresolvedCalls: number;
	dropped: number;
}

interface AsyncJobReapResult {
	settled: boolean;
	pendingJobIds: string[];
	completion: Promise<void>;
}

export interface AsyncJobRegisterOptions {
	id?: string;
	monitor?: MonitorDetails;

	ownerId?: string;

	agentId?: string;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;

	queued?: boolean;
	/** Callback input bytes beyond its label and monitor command metadata, unless admission was reserved earlier. */
	bytes?: number;
	admission?: AsyncJobAdmission;
}

interface AsyncJobFilter {
	ownerId?: string;
	excludeMonitors?: boolean;
}

export class AsyncJobManager {
	static #instance: AsyncJobManager | undefined;

	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #jobs = new Map<string, AsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #inFlightDeliveries: AsyncJobDelivery[] = [];
	readonly #retainedDeliveries = new Set<AsyncJobDelivery>();
	#deliveryBytes = 0;
	#droppedDeliveries = 0;
	#deliveryExpiryTimer: NodeJS.Timeout | undefined;
	readonly #suppressedDeliveries = new Set<string>();
	readonly #watchedJobs = new Set<string>();
	readonly #eventSequences = new Map<string, number>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #pollEscalation = new LRUCache<string | undefined, PollEscalationState>({
		max: 256,
		maxSize: 64 * 1024,
		sizeCalculation: (_value, key) => 32 + (key?.length ?? 0) * 2,
		ttl: POLL_ESCALATION_RESET_MS,
	});
	readonly #admissions = new Map<AsyncJobAdmission, AdmissionState>();
	readonly #unsettledJobs = new Set<string>();
	readonly #retainedJobs = new Map<string, number>();
	#retainedJobBytes = 0;
	#nextJobId = 1;
	readonly #deliverySinks = new Map<string, AsyncJobDeliverySink>();
	readonly #capacityWaiters = new Set<AsyncJobCapacityWaiter>();
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #maxTotalJobs: number;
	readonly #maxTotalBytes: number;
	readonly #maxOwnerJobs: number;
	readonly #maxOwnerBytes: number;
	readonly #retentionMs: number;
	readonly #maxRetainedJobs: number;
	readonly #maxRetainedBytes: number;
	readonly #maxDeliveryBytes: number;
	readonly #maxDeliveries: number;
	readonly #maxDeliveryCalls: number;
	readonly #deliveryRetentionMs: number;
	readonly #deliveryTimeoutMs: number;
	#deliveryLoop: Promise<void> | undefined;
	#deliveryQueueChanged = Promise.withResolvers<void>();
	#disposed = false;
	#deliveryClosed = false;

	#filterJobs(jobs: Iterable<AsyncJob>, filter?: AsyncJobFilter): AsyncJob[] {
		return Array.from(jobs).filter(
			job =>
				(!filter?.ownerId || job.ownerId === filter.ownerId) &&
				(!filter?.excludeMonitors || job.type !== "monitor" || job.status !== "running"),
		);
	}

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#maxTotalJobs = Math.max(1, Math.floor(options.maxTotalJobs ?? this.#maxRunningJobs * 4));
		this.#maxTotalBytes = Math.max(1, Math.floor(options.maxTotalBytes ?? 64 * 1024 * 1024));
		this.#maxOwnerJobs = Math.max(1, Math.floor(options.maxOwnerJobs ?? this.#maxTotalJobs));
		this.#maxOwnerBytes = Math.max(1, Math.floor(options.maxOwnerBytes ?? 16 * 1024 * 1024));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
		this.#maxRetainedJobs = Math.max(0, Math.floor(options.maxRetainedJobs ?? 256));
		this.#maxRetainedBytes = Math.max(0, Math.floor(options.maxRetainedBytes ?? 16 * 1024 * 1024));
		this.#maxDeliveryBytes = Math.max(1, Math.floor(options.maxDeliveryBytes ?? 8 * 1024 * 1024));
		this.#maxDeliveries = Math.max(1, Math.floor(options.maxDeliveries ?? 256));
		this.#maxDeliveryCalls = Math.max(1, Math.floor(options.maxDeliveryCalls ?? 8));
		this.#deliveryRetentionMs = Math.max(1, Math.floor(options.deliveryRetentionMs ?? DEFAULT_RETENTION_MS));
		this.#deliveryTimeoutMs = Math.max(1, Math.floor(options.deliveryTimeoutMs ?? 30_000));
	}

	#checkAdmission(bytes: number, ownerId: string | undefined, exclude?: AsyncJobAdmission): void {
		if (this.#disposed) throw new Error("Async job manager is disposed");
		if (!Number.isSafeInteger(bytes) || bytes < 0)
			throw new Error("Async job admission bytes must be a nonnegative integer");
		let totalBytes = 0;
		let ownerBytes = 0;
		let ownerJobs = 0;
		for (const [admission, state] of this.#admissions) {
			if (admission === exclude) continue;
			totalBytes += state.bytes;
			if (state.ownerId === ownerId) {
				ownerBytes += state.bytes;
				ownerJobs++;
			}
		}
		if (this.#admissions.size - (exclude ? 1 : 0) >= this.#maxTotalJobs || ownerJobs >= this.#maxOwnerJobs) {
			throw new Error("Background job admission limit reached. Wait for outstanding work to settle.");
		}
		if (totalBytes + bytes > this.#maxTotalBytes || ownerBytes + bytes > this.#maxOwnerBytes) {
			throw new Error(
				"Background job admission byte limit reached. Reduce queued input or wait for work to settle.",
			);
		}
	}

	reserve(options: { bytes?: number; ownerId?: string } = {}): AsyncJobAdmission {
		const bytes = options.bytes ?? 0;
		this.#checkAdmission(bytes, options.ownerId);
		const admission: AsyncJobAdmission = {
			resize: bytes => {
				const state = this.#admissions.get(admission);
				if (!state || state.registered) throw new Error("Async job admission is unavailable for resizing");
				this.#checkAdmission(bytes, state.ownerId, admission);
				const previousBytes = state.bytes;
				state.bytes = bytes;
				if (bytes < previousBytes) this.#notifyCapacityAvailable();
			},
			release: () => {
				if (this.#admissions.get(admission)?.registered !== false) return;
				this.#admissions.delete(admission);
				this.#notifyCapacityAvailable();
			},
		};
		this.#admissions.set(admission, { bytes, ownerId: options.ownerId, registered: false });
		return admission;
	}

	get atCapacity(): boolean {
		if (this.#disposed) return true;

		return this.#runningCount() >= this.#maxRunningJobs || this.#admissions.size >= this.#maxTotalJobs;
	}

	#runningCount(): number {
		let count = 0;
		for (const id of this.#unsettledJobs) {
			const job = this.#jobs.get(id);
			if (job && job.type !== "monitor" && !job.queued) count++;
		}
		return count;
	}

	onCapacityAvailable(callback: (error?: Error) => void): () => void {
		if (this.#disposed) {
			callback(new Error("Async job manager is disposed"));
			return () => {};
		}
		if (!this.atCapacity) {
			callback();
			return () => {};
		}
		this.#capacityWaiters.add(callback);
		return () => this.#capacityWaiters.delete(callback);
	}

	register(
		type: AsyncJobType,
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
			emitEvent: (kind: AsyncJobEvent["kind"], text: string) => void;

			markRunning: () => void;
		}) => Promise<string>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error("Async job manager is disposed");
		}

		if (type === "monitor" && !options?.ownerId) throw new Error("Monitor jobs require an owner");
		if (type !== "monitor" && !options?.queued && this.#runningCount() >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for outstanding work to settle.`,
			);
		}
		const bytes = options?.bytes ?? 0;
		if (!Number.isSafeInteger(bytes) || bytes < 0)
			throw new Error("Async job admission bytes must be a nonnegative integer");
		const admission =
			options?.admission ??
			this.reserve({
				ownerId: options?.ownerId,
				bytes:
					bytes +
					[
						label,
						options?.monitor?.command ?? "",
						options?.monitor?.cwd ?? "",
						options?.monitor?.match ?? "",
					].reduce((total, text) => total + Buffer.byteLength(text), 0),
			});
		const state = this.#admissions.get(admission);
		if (!state || state.registered || state.ownerId !== options?.ownerId) {
			throw new Error("Async job admission is unavailable or belongs to another owner");
		}
		state.registered = true;

		const id = this.#resolveJobId(options?.id);
		this.#suppressedDeliveries.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();

		const job: AsyncJob = {
			id,
			type,
			status: "running",
			startTime,
			label,
			abortController,
			promise: Promise.resolve(),
			ownerId: options?.ownerId,
			agentId: options?.agentId,
			queued: options?.queued === true,
			monitor: options?.monitor,
			...(type === "monitor" ? { events: [] } : {}),
		};

		const reportProgress = async (text: string, details?: Record<string, unknown>): Promise<void> => {
			if (job.status !== "running" || this.#disposed) return;
			if (details) job.latestDetails = details;
			if (!options?.onProgress) return;
			try {
				await options.onProgress(text, details);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		this.#jobs.set(id, job);
		this.#unsettledJobs.add(id);
		job.promise = (async () => {
			try {
				const text = await run({
					jobId: id,
					signal: abortController.signal,
					reportProgress,
					emitEvent: (kind, text) => this.#emitEvent(job, kind, text),
					markRunning: () => {
						job.queued = false;
					},
				});
				job.resultText = text;
				if (job.status !== "cancelled") {
					job.status = "completed";
					if (type !== "monitor") this.#enqueueDelivery(id, text);
				}
			} catch (error) {
				job.errorText = error instanceof Error ? error.message : String(error);
				if (job.status !== "cancelled") {
					job.status = "failed";
					if (type !== "monitor") this.#enqueueDelivery(id, job.errorText);
				}
			} finally {
				this.#unsettledJobs.delete(id);
				this.#admissions.delete(admission);
				this.#scheduleEviction(id);
				this.#notifyCapacityAvailable();
			}
		})();

		return id;
	}

	cancel(id: string, filter?: AsyncJobFilter): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
		if (job.status !== "running") return false;
		job.status = "cancelled";
		this.acknowledgeEvents(job.events ?? []);
		job.abortController.abort();
		return true;
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter).filter(job => job.status === "running");
	}

	getRecentJobs(limit = 10, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter)
			.filter(job => job.status !== "running")
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter);
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		const deliveries = this.#filterDeliveries(filter);
		const inFlightDeliveries = this.#filterInFlightDeliveries(filter);
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
			retainedBytes: [...this.#retainedDeliveries]
				.filter(
					delivery =>
						(!filter?.ownerId || delivery.ownerId === filter.ownerId) &&
						(!filter?.excludeMonitors || !delivery.event),
				)
				.reduce((total, delivery) => total + delivery.bytes, 0),
			unresolvedCalls: this.#inFlightDeliveries.filter(
				delivery =>
					delivery.expired &&
					(!filter?.ownerId || delivery.ownerId === filter.ownerId) &&
					(!filter?.excludeMonitors || !delivery.event),
			).length,
			dropped: this.#droppedDeliveries,
		};
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.getDeliveryState(filter).queued > 0;
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let watched = 0;
		for (const jobId of uniqueJobIds) {
			if (!this.#jobs.has(jobId)) continue;
			this.#watchedJobs.add(jobId);
			watched++;
		}
		this.#notifyDeliveryQueueChanged();
		return watched;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#watchedJobs.delete(jobId)) {
				removed += 1;
			}
		}
		this.#notifyDeliveryQueueChanged();
		this.#ensureDeliveryLoop();
		return removed;
	}

	nextPollWaitMs(ownerId: string | undefined, now: number = Date.now()): number {
		const prev = this.#pollEscalation.get(ownerId);
		const reset = !prev || now - prev.lastPollEndAt >= POLL_ESCALATION_RESET_MS;
		const level = reset ? 0 : Math.min(prev.level + 1, POLL_WAIT_LADDER_MS.length - 1);
		this.#pollEscalation.set(ownerId, { level, lastPollEndAt: prev?.lastPollEndAt ?? now });
		return POLL_WAIT_LADDER_MS[level];
	}

	recordPollWaitEnd(ownerId: string | undefined, now: number = Date.now()): void {
		const prev = this.#pollEscalation.get(ownerId);
		this.#pollEscalation.set(ownerId, { level: prev?.level ?? 0, lastPollEndAt: now });
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		if (uniqueJobIds.length === 0) return 0;

		for (const jobId of uniqueJobIds) {
			const job = this.#jobs.get(jobId);
			if (job && job.type !== "monitor") this.#suppressedDeliveries.add(jobId);
		}

		const before = this.#deliveries.length;
		for (const delivery of [...this.#deliveries]) {
			if (this.#isDeliverySuppressed(delivery)) this.#releaseDelivery(delivery);
		}
		this.#notifyDeliveryQueueChanged();
		return before - this.#deliveries.length;
	}

	resumeDeliveries(jobIds: string[]): void {
		for (const rawId of jobIds) {
			const jobId = rawId.trim();
			if (!jobId) continue;
			if (!this.#suppressedDeliveries.delete(jobId)) continue;
			const job = this.#jobs.get(jobId);
			if (!job || (job.status !== "completed" && job.status !== "failed")) continue;
			const queued =
				this.#deliveries.some(delivery => delivery.jobId === jobId) ||
				this.#inFlightDeliveries.some(delivery => delivery.jobId === jobId);
			if (queued) continue;
			this.#enqueueDelivery(jobId, job.status === "completed" ? (job.resultText ?? "") : (job.errorText ?? ""));
		}
	}

	cancelAll(filter?: AsyncJobFilter, reason?: unknown): void {
		this.#cancelJobs(filter, reason);
	}

	#cancelJobs(filter?: AsyncJobFilter, reason?: unknown): void {
		for (const job of this.getRunningJobs(filter)) {
			job.status = "cancelled";
			this.acknowledgeEvents(job.events ?? []);
			job.abortController.abort(reason);
		}
	}

	evictCompletedJobs(filter?: AsyncJobFilter): number {
		let evicted = 0;
		for (const job of this.#filterJobs(this.#jobs.values(), filter)) {
			if (job.status !== "completed" && job.status !== "failed") continue;
			this.acknowledgeDeliveries([job.id]);
			if (this.#evictJob(job.id)) evicted += 1;
		}
		return evicted;
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	registerDeliverySink(ownerId: string, sink: AsyncJobDeliverySink): () => void {
		this.#deliverySinks.set(ownerId, sink);
		this.#notifyDeliveryQueueChanged();
		return () => {
			if (this.#deliverySinks.get(ownerId) !== sink) return;
			this.#deliverySinks.delete(ownerId);
			this.#pollEscalation.delete(ownerId);
			this.#notifyDeliveryQueueChanged();
		};
	}

	async waitForOwnerJobs(
		ownerId: string,
		options?: { timeoutMs?: number; excludeSuppressed?: boolean; excludeMonitors?: boolean },
	): Promise<boolean> {
		const deadline =
			options?.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, options.timeoutMs);
		const awaited = new Set<string>();
		for (;;) {
			const pending = this.#filterJobs(this.#jobs.values(), {
				ownerId,
				excludeMonitors: options?.excludeMonitors,
			}).filter(
				job =>
					!awaited.has(job.id) &&
					(job.type === "monitor" || options?.excludeSuppressed !== true || !this.isDeliverySuppressed(job.id)),
			);
			if (pending.length === 0) return true;
			for (const job of pending) awaited.add(job.id);
			const settled = await this.#waitForDeliveryPromise(
				Promise.all(pending.map(job => job.promise)).then(() => {}),
				deadline,
			);
			if (!settled) return false;
		}
	}

	async cancelAndReapOwnerJobs(
		ownerId: string,
		deadlineAt: number,
		options?: { excludeMonitors?: boolean },
	): Promise<AsyncJobReapResult> {
		this.cancelAll({ ownerId, excludeMonitors: options?.excludeMonitors });
		const timeoutMs = Math.max(0, deadlineAt - Date.now());
		const settled = await this.waitForOwnerJobs(ownerId, { timeoutMs, excludeMonitors: options?.excludeMonitors });
		if (settled) {
			return { settled: true, pendingJobIds: [], completion: Promise.resolve() };
		}
		const pendingJobIds = this.getAllJobs({ ownerId, excludeMonitors: options?.excludeMonitors })
			.filter(job => this.#unsettledJobs.has(job.id))
			.map(job => job.id);
		const completion = this.waitForOwnerJobs(ownerId, options).then(() => {});
		return { settled: false, pendingJobIds, completion };
	}

	async #waitForAllUntil(deadline: number): Promise<boolean> {
		const promises = Array.from(this.#jobs.values()).map(job => job.promise);
		if (promises.length === 0) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await Promise.all(promises);
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;

		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), remainingMs);
		timer.unref();
		try {
			const result = await Promise.race([Promise.all(promises).then(() => "settled" as const), timeout.promise]);
			return result === "settled";
		} finally {
			clearTimeout(timer);
		}
	}

	async drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		const deadline =
			options?.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(options.timeoutMs, 0);
		while (this.hasPendingDeliveries(options?.filter)) {
			if (Date.now() >= deadline) return false;
			const changed = this.#deliveryQueueChanged.promise;
			this.#ensureDeliveryLoop();
			if (!(await this.#waitForDeliveryPromise(changed, deadline))) return false;
		}
		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		this.#disposed = true;
		this.#clearEvictionTimers();
		this.#cancelJobs(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		this.#notifyCapacityAvailable(new Error("Async job manager is disposed"));
		const timeoutMs = Math.max(options?.timeoutMs ?? 3_000, 0);
		const deadline = Date.now() + timeoutMs;
		const jobsSettled = await this.#waitForAllUntil(deadline);
		const drained = await this.drainDeliveries({ timeoutMs: Math.max(deadline - Date.now(), 0) });
		this.#clearEvictionTimers();
		this.#deliveryClosed = true;
		for (const delivery of this.#inFlightDeliveries) {
			clearTimeout(delivery.timer);
			delivery.timer = undefined;
		}
		clearTimeout(this.#deliveryExpiryTimer);
		this.#deliveryExpiryTimer = undefined;
		this.#retainedDeliveries.clear();
		this.#deliveryBytes = 0;
		this.#jobs.clear();
		this.#admissions.clear();
		this.#unsettledJobs.clear();
		this.#retainedJobs.clear();
		this.#retainedJobBytes = 0;
		this.#deliveries.length = 0;
		this.#notifyDeliveryQueueChanged();
		this.#inFlightDeliveries.length = 0;
		this.#suppressedDeliveries.clear();
		this.#watchedJobs.clear();
		this.#eventSequences.clear();
		this.#pollEscalation.clear();
		this.#deliverySinks.clear();
		return jobsSettled && drained;
	}

	#notifyCapacityAvailable(error?: Error): void {
		if (error === undefined && this.atCapacity) return;
		const waiters = [...this.#capacityWaiters];
		this.#capacityWaiters.clear();
		for (const waiter of waiters) {
			if (error === undefined && this.atCapacity) {
				this.#capacityWaiters.add(waiter);
				continue;
			}
			try {
				waiter(error);
			} catch (callbackError) {
				logger.warn("Async job capacity callback failed", {
					error: callbackError instanceof Error ? callbackError.message : String(callbackError),
				});
			}
		}
	}

	#resolveJobId(preferredId?: string): string {
		preferredId = preferredId?.trim();
		if (!preferredId) {
			while (true) {
				const id = `bg_${this.#nextJobId++}`;
				if (!this.#jobs.has(id)) return id;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	#evictJob(jobId: string): boolean {
		clearTimeout(this.#evictionTimers.get(jobId));
		this.#evictionTimers.delete(jobId);
		this.#suppressedDeliveries.delete(jobId);
		this.#watchedJobs.delete(jobId);
		this.#eventSequences.delete(jobId);
		const retainedBytes = this.#retainedJobs.get(jobId);
		if (retainedBytes !== undefined) {
			this.#retainedJobBytes -= retainedBytes;
			this.#retainedJobs.delete(jobId);
		}
		const ownerId = this.#jobs.get(jobId)?.ownerId;
		const deleted = this.#jobs.delete(jobId);
		if (![...this.#jobs.values()].some(job => job.ownerId === ownerId)) this.#pollEscalation.delete(ownerId);
		return deleted;
	}

	#scheduleEviction(jobId: string): void {
		const job = this.#jobs.get(jobId);
		if (this.#disposed || !job || this.#unsettledJobs.has(jobId) || job.events?.length) return;
		if (!this.#retainedJobs.has(jobId)) {
			// Account UTF-16 storage as well as UTF-8 serialization, not only the result preview.
			let details = "";
			try {
				details = JSON.stringify(job.latestDetails ?? {}) ?? "";
			} catch {
				job.latestDetails = undefined;
			}
			const bytes = [
				job.id,
				job.ownerId ?? "",
				job.agentId ?? "",
				job.label,
				job.resultText ?? "",
				job.errorText ?? "",
				details,
				job.monitor?.command ?? "",
				job.monitor?.cwd ?? "",
				job.monitor?.match ?? "",
			].reduce((total, text) => total + Math.max(text.length * 2, Buffer.byteLength(text)), 0);
			if (bytes > this.#maxRetainedBytes) {
				this.#evictJob(jobId);
				return;
			}
			this.#retainedJobs.set(jobId, bytes);
			this.#retainedJobBytes += bytes;
			while (this.#retainedJobs.size > this.#maxRetainedJobs || this.#retainedJobBytes > this.#maxRetainedBytes) {
				const oldest = this.#retainedJobs.keys().next().value;
				if (oldest === undefined) break;
				this.#evictJob(oldest);
			}
			if (!this.#jobs.has(jobId)) return;
		}
		if (this.#retentionMs <= 0) {
			this.#evictJob(jobId);
			return;
		}
		const existing = this.#evictionTimers.get(jobId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.#evictJob(jobId);
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(jobId, timer);
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#deliveryMatches(delivery: AsyncJobDelivery, filter?: AsyncJobFilter): boolean {
		return (
			!delivery.expired &&
			(!filter?.ownerId || delivery.ownerId === filter.ownerId) &&
			(!filter?.excludeMonitors || !delivery.event) &&
			!this.#isDeliverySuppressed(delivery) &&
			!this.#isEventWatched(delivery)
		);
	}

	#filterDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		return this.#deliveries.filter(delivery => this.#deliveryMatches(delivery, filter));
	}

	#filterInFlightDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		return this.#inFlightDeliveries.filter(delivery => this.#deliveryMatches(delivery, filter));
	}

	#emitEvent(job: AsyncJob, kind: AsyncJobEvent["kind"], text: string): void {
		if (job.type !== "monitor" || job.status !== "running" || this.#disposed) return;
		const sequence = (this.#eventSequences.get(job.id) ?? 0) + 1;
		this.#eventSequences.set(job.id, sequence);
		const event: AsyncJobEvent = { jobId: job.id, label: job.label, sequence, kind, text, timestamp: Date.now() };
		const delivery = this.#createDelivery(job.id, text, event);
		if (!delivery) return;
		job.events?.push(event);
		this.#queueDelivery(delivery);
	}

	isEventAcknowledged(event: AsyncJobEvent): boolean {
		const job = this.#jobs.get(event.jobId);
		return !job || job.status === "cancelled" || !job.events?.includes(event);
	}

	acknowledgeEvents(events: readonly AsyncJobEvent[]): void {
		const acknowledged = new Set(events);
		for (const id of new Set(events.map(event => event.jobId))) {
			const job = this.#jobs.get(id);
			if (!job) continue;
			job.events = job.events?.filter(event => !acknowledged.has(event));
			if (job.status === "completed" || job.status === "failed") this.#scheduleEviction(id);
		}
		for (const delivery of this.#retainedDeliveries) {
			if (delivery.event && acknowledged.has(delivery.event)) this.#releaseDelivery(delivery);
		}
		this.#notifyDeliveryQueueChanged();
	}

	takeEvents(jobIds: string[], filter?: AsyncJobFilter): AsyncJobEvent[] {
		const ids = new Set(jobIds);
		const events = this.#filterJobs(this.#jobs.values(), filter)
			.filter(job => ids.has(job.id))
			.flatMap(job => job.events ?? [])
			.filter(event => !this.isEventAcknowledged(event));
		this.acknowledgeEvents(events);
		return events;
	}

	async waitForEvents(jobIds: string[], signal: AbortSignal): Promise<void> {
		const aborted = Promise.withResolvers<void>();
		const onAbort = () => aborted.resolve();
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			while (!signal.aborted) {
				if (jobIds.some(id => this.#jobs.get(id)?.events?.some(event => !this.isEventAcknowledged(event)))) return;
				await Promise.race([this.#deliveryQueueChanged.promise, aborted.promise]);
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#isDeliverySuppressed(delivery: AsyncJobDelivery): boolean {
		return delivery.event ? this.isEventAcknowledged(delivery.event) : this.isDeliverySuppressed(delivery.jobId);
	}

	#isEventWatched(delivery: AsyncJobDelivery): boolean {
		return (
			delivery.event !== undefined && this.#watchedJobs.has(delivery.jobId) && !this.#isDeliverySuppressed(delivery)
		);
	}

	isDeliverySuppressed(jobId: string): boolean {
		return this.#suppressedDeliveries.has(jobId) || this.#watchedJobs.has(jobId);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		if (this.isDeliverySuppressed(jobId) || this.#deliveryClosed) return;
		const delivery = this.#createDelivery(jobId, text);
		if (!delivery) return;
		this.#queueDelivery(delivery);
	}

	#createDelivery(jobId: string, text: string, event?: AsyncJobEvent): AsyncJobDelivery | undefined {
		if (this.#deliveryClosed) return undefined;
		const ownerId = this.#jobs.get(jobId)?.ownerId;
		const bytes = [text, jobId, ownerId ?? "", event?.label ?? ""].reduce(
			(total, value) => total + Math.max(value.length * 2, Buffer.byteLength(value)),
			0,
		);
		const delivery: AsyncJobDelivery = {
			jobId,
			text,
			event,
			ownerId,
			bytes,
			attempt: 0,
			nextAttemptAt: Date.now(),
			expiresAt: Date.now() + this.#deliveryRetentionMs,
		};
		if (bytes > this.#maxDeliveryBytes) {
			this.#dropDelivery(delivery, "payload exceeds delivery byte limit");
			return undefined;
		}
		for (const retained of this.#retainedDeliveries) {
			if (
				this.#deliveryBytes + bytes <= this.#maxDeliveryBytes &&
				this.#retainedDeliveries.size < this.#maxDeliveries
			)
				break;
			if (!this.#inFlightDeliveries.includes(retained)) this.#dropDelivery(retained, "delivery backlog limit");
		}
		if (
			this.#deliveryBytes + bytes > this.#maxDeliveryBytes ||
			this.#retainedDeliveries.size >= this.#maxDeliveries
		) {
			this.#dropDelivery(delivery, "unresolved delivery calls occupy delivery budget");
			return undefined;
		}
		this.#retainedDeliveries.add(delivery);
		this.#deliveryBytes += bytes;
		this.#scheduleDeliveryExpiry();
		return delivery;
	}

	#releaseDelivery(delivery: AsyncJobDelivery): void {
		const index = this.#deliveries.indexOf(delivery);
		if (index >= 0) this.#deliveries.splice(index, 1);
		if (!this.#inFlightDeliveries.includes(delivery) && this.#retainedDeliveries.delete(delivery)) {
			this.#deliveryBytes -= delivery.bytes;
		}
		this.#scheduleDeliveryExpiry();
		this.#notifyDeliveryQueueChanged();
	}

	#dropDelivery(delivery: AsyncJobDelivery, reason: string): void {
		if (delivery.expired) return;
		delivery.expired = true;
		this.#droppedDeliveries++;
		logger.warn("Async job delivery dead-lettered", { jobId: delivery.jobId, ownerId: delivery.ownerId, reason });
		if (delivery.event) this.acknowledgeEvents([delivery.event]);
		this.#releaseDelivery(delivery);
	}

	#scheduleDeliveryExpiry(): void {
		clearTimeout(this.#deliveryExpiryTimer);
		this.#deliveryExpiryTimer = undefined;
		if (this.#deliveryClosed) return;
		let next = Number.POSITIVE_INFINITY;
		for (const delivery of this.#retainedDeliveries) {
			if (!delivery.expired) next = Math.min(next, delivery.expiresAt);
		}
		if (!Number.isFinite(next)) return;
		this.#deliveryExpiryTimer = setTimeout(
			() => {
				this.#deliveryExpiryTimer = undefined;
				for (const delivery of this.#retainedDeliveries) {
					if (delivery.expiresAt <= Date.now()) this.#dropDelivery(delivery, "delivery retention expired");
				}
				this.#scheduleDeliveryExpiry();
			},
			Math.max(0, next - Date.now()),
		);
		this.#deliveryExpiryTimer.unref();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop || this.#deliveryClosed) return;
		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#filterDeliveries().length > 0) this.#ensureDeliveryLoop();
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (!this.#deliveryClosed) {
			for (const delivery of [...this.#deliveries]) {
				if (this.#isDeliverySuppressed(delivery)) this.#releaseDelivery(delivery);
			}
			const available = this.#filterDeliveries();
			if (available.length === 0) return;
			const now = Date.now();
			const delivery = available.find(
				candidate =>
					candidate.nextAttemptAt <= now &&
					this.#inFlightDeliveries.length < this.#maxDeliveryCalls &&
					!this.#inFlightDeliveries.some(active => active.ownerId === candidate.ownerId),
			);
			if (delivery) {
				this.#deliveries.splice(this.#deliveries.indexOf(delivery), 1);
				// The call owns capacity until actual settlement, even after its delivery deadline.
				this.#deliverDelivery(delivery);
				continue;
			}
			const wakeAt = Math.min(
				...available.map(candidate =>
					candidate.nextAttemptAt > now
						? Math.min(candidate.nextAttemptAt, candidate.expiresAt)
						: candidate.expiresAt,
				),
			);
			await this.#waitForDeliveryQueueChange(Math.max(1, wakeAt - now));
		}
	}

	#resolveDeliverySink(ownerId: string | undefined): AsyncJobDeliverySink | undefined {
		if (ownerId !== undefined) return this.#deliverySinks.get(ownerId);
		return this.#onJobComplete;
	}

	#deliverDelivery(delivery: AsyncJobDelivery): void {
		const sink = this.#resolveDeliverySink(delivery.ownerId);
		if (!sink) {
			this.#dropDelivery(delivery, "no delivery sink");
			return;
		}
		this.#inFlightDeliveries.push(delivery);
		const timeoutMs = Math.max(0, Math.min(this.#deliveryTimeoutMs, delivery.expiresAt - Date.now()));
		delivery.timer = setTimeout(() => {
			delivery.timer = undefined;
			this.#dropDelivery(delivery, "delivery sink timed out");
		}, timeoutMs);
		delivery.timer.unref();
		// Keep the call charged until real settlement; timing out must not create another call slot.
		// Per-call timers are removable: racing a manager-lifetime promise would retain one reaction per call.
		void Promise.resolve()
			.then(() => {
				if (this.#deliveryClosed || delivery.expired || this.#isDeliverySuppressed(delivery)) return;
				return sink(delivery.jobId, delivery.text, this.#jobs.get(delivery.jobId), delivery.event);
			})
			.catch(error => {
				if (this.#deliveryClosed || delivery.expired || this.#isDeliverySuppressed(delivery)) return;
				delivery.attempt++;
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				if (delivery.nextAttemptAt >= delivery.expiresAt)
					this.#dropDelivery(delivery, "retry exceeds delivery lifetime");
				else this.#queueDelivery(delivery);
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				clearTimeout(delivery.timer);
				delivery.timer = undefined;
				const index = this.#inFlightDeliveries.indexOf(delivery);
				if (index >= 0) this.#inFlightDeliveries.splice(index, 1);
				if (
					delivery.expired ||
					this.#isDeliverySuppressed(delivery) ||
					(!delivery.event && !this.#deliveries.includes(delivery))
				) {
					this.#releaseDelivery(delivery);
				}
				this.#notifyDeliveryQueueChanged();
			})
			.catch(error => {
				logger.error("Async job delivery cleanup failed", { jobId: delivery.jobId, error: String(error) });
			});
	}

	#queueDelivery(delivery: AsyncJobDelivery): void {
		if (this.#deliveryClosed || delivery.expired) return;
		const index = this.#deliveries.findIndex(candidate => candidate.nextAttemptAt > delivery.nextAttemptAt);
		if (index === -1) this.#deliveries.push(delivery);
		else this.#deliveries.splice(index, 0, delivery);
		this.#notifyDeliveryQueueChanged();
		this.#ensureDeliveryLoop();
	}

	async #waitForDeliveryQueueChange(delayMs: number): Promise<void> {
		const timerElapsed = Promise.withResolvers<void>();
		const timer = setTimeout(timerElapsed.resolve, delayMs);
		timer.unref();
		try {
			await Promise.race([timerElapsed.promise, this.#deliveryQueueChanged.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	#notifyDeliveryQueueChanged(): void {
		this.#deliveryQueueChanged.resolve();
		this.#deliveryQueueChanged = Promise.withResolvers<void>();
	}

	async #waitForDeliveryPromise(promise: Promise<void> | undefined, deadline: number): Promise<boolean> {
		if (!promise) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await promise;
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		const timeout = Promise.withResolvers<false>();
		const timer = setTimeout(() => timeout.resolve(false), remainingMs);
		timer.unref();
		try {
			return await Promise.race([promise.then(() => true), timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}
}
