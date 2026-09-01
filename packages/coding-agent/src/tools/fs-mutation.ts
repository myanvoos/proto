import { invalidateFsScanCache } from "@oh-my-pi/pi-natives";
import { type FsObservationSession, fsObservationLedgerFor } from "../eval/fs-observations";

export async function noteFileWritten(session: FsObservationSession, absolutePath: string): Promise<void> {
	invalidateFsScanCache(absolutePath);
	await fsObservationLedgerFor(session).recordWrite(absolutePath);
}

export async function noteFileDeleted(session: FsObservationSession, absolutePath: string): Promise<void> {
	invalidateFsScanCache(absolutePath);
	await fsObservationLedgerFor(session).recordWrite(absolutePath);
}

export async function noteFileRenamed(
	session: FsObservationSession,
	fromAbsolutePath: string,
	toAbsolutePath: string,
): Promise<void> {
	invalidateFsScanCache(fromAbsolutePath);
	const ledger = fsObservationLedgerFor(session);
	await ledger.recordWrite(fromAbsolutePath);
	if (toAbsolutePath !== fromAbsolutePath) {
		invalidateFsScanCache(toAbsolutePath);
		await ledger.recordWrite(toAbsolutePath);
	}
}
