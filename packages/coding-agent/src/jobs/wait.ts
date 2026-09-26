import type { AsyncJobManager } from "../async/job-manager";
import type { WaitParticipant } from "./contracts";

/**
 * Suppress automatic delivery for the duration of an explicit wait. The callback
 * must consume/acknowledge its winning results before returning; losing sources
 * remain eligible for delivery when this lease ends. A worker scheduler may lend
 * its runnable permit while the callback is blocked.
 */
export async function withJobWait<T>(
	manager: AsyncJobManager,
	ids: string[],
	run: () => Promise<T>,
	participate?: WaitParticipant,
): Promise<T> {
	manager.watchJobs(ids);
	try {
		return await (participate ? participate(run) : run());
	} finally {
		manager.unwatchJobs(ids);
	}
}
