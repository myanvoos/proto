/** Public references retain the identity assigned by the authoritative backend. */
export interface JobRef {
	kind: "job";
	id: string;
}

export interface ProcessRef {
	kind: "process";
	id: string;
	name: string;
}

export interface WatchRef {
	kind: "watch";
	id: string;
}

export type ExecutionRef = JobRef | ProcessRef | WatchRef;

export interface MailboxSelector {
	from?: string;
}

export interface JobsWaitRequest {
	targets?: ExecutionRef[];
	mailbox?: MailboxSelector;
	timeoutMs?: number;
}

/** A scheduler participates without exposing its semaphore or taking over delivery. */
export type WaitParticipant = <T>(run: () => Promise<T>) => Promise<T>;
