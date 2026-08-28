import { formatBytes } from "../format";
import { ArchiveError } from "./error";
import { formatArchivePathForError } from "./paths";

export interface ArchiveLimits {
	maxEntries: number;

	maxInMemorySize: number;

	maxIndexSize: number;

	maxMemberSize: number;

	maxPathBytes: number;

	maxLinkDepth: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
	maxEntries: 1_000_000,
	maxInMemorySize: 256 * 1024 * 1024,
	maxIndexSize: 64 * 1024 * 1024,
	maxMemberSize: 64 * 1024 * 1024,
	maxPathBytes: 4096,
	maxLinkDepth: 40,
};

export function assertInMemorySize(size: number, limits: ArchiveLimits): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ArchiveError("Archive is too large to read safely");
	}
	if (size > limits.maxInMemorySize) {
		throw new ArchiveError(
			`Archive is too large to read in memory (${formatBytes(size)} > ${formatBytes(limits.maxInMemorySize)} limit)`,
		);
	}
}

export function assertIndexSize(size: number, limits: ArchiveLimits, what: string): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ArchiveError(`Invalid archive: ${what} has an invalid size`);
	}
	if (size > limits.maxIndexSize) {
		throw new ArchiveError(
			`Archive ${what} is too large (${formatBytes(size)} > ${formatBytes(limits.maxIndexSize)} limit)`,
		);
	}
}

export function assertArchiveMemberSize(size: number, memberPath: string, limits: ArchiveLimits): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ArchiveError(`Archive member '${formatArchivePathForError(memberPath)}' has an invalid size`);
	}
	if (size > limits.maxMemberSize) {
		throw new ArchiveError(
			`Archive member '${formatArchivePathForError(memberPath)}' is too large to extract in memory (${formatBytes(size)} > ${formatBytes(limits.maxMemberSize)} limit)`,
		);
	}
}

export function assertEntryCount(count: number, limits: ArchiveLimits): void {
	if (count > limits.maxEntries) {
		throw new ArchiveError(`Archive has too many entries (> ${limits.maxEntries} limit)`);
	}
}
