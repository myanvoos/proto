import type { ArchiveLimits } from "./limits";
import type { ByteSource } from "./source";

export type ArchiveFormat =
	| "zip"
	| "tar"
	| "tar.gz"
	| "tar.bz2"
	| "tar.xz"
	| "tar.zst"
	| "tar.Z"
	| "asar"
	| "rar"
	| "7z"
	| "iso"
	| "cab"
	| "cpio"
	| "rpm"
	| "ar"
	| "deb"
	| "lzh"
	| "arj"
	| "gz"
	| "bz2"
	| "xz"
	| "zst"
	| "Z"
	| "lzma";

export type WritableArchiveFormat = "zip" | "tar" | "tar.gz" | "tar.zst" | "asar";

export type ArchiveSource =
	| string
	| { bytes: Uint8Array; format: ArchiveFormat }
	| { path: string; format: ArchiveFormat }
	| { source: ByteSource; format: ArchiveFormat; path?: string };

export type ArchiveMemberContent = string | Uint8Array | Blob;

export interface ArchivePathCandidate {
	archivePath: string;
	subPath: string;
}

export interface ArchiveNode {
	path: string;
	isDirectory: boolean;
	size: number;
	mtimeMs?: number;

	mode?: number;
}

export interface ArchiveDirectoryEntry extends ArchiveNode {
	name: string;
}

export interface ExtractedArchiveFile extends ArchiveNode {
	bytes: Uint8Array;
}

export interface MemberSource {
	read(size: number, memberPath: string): Promise<Uint8Array>;
}

export type EntryStorage =
	| {
			type: "link";
			targetPath: string;

			resolveTarget: boolean;
	  }
	| { type: "member"; source: MemberSource };

export interface ArchiveIndexEntry extends ArchiveNode {
	storage?: EntryStorage;
}

export interface FormatReadOptions {
	limits: ArchiveLimits;

	archivePath?: string;
}

export type FormatReader = (source: ByteSource, options: FormatReadOptions) => Promise<ArchiveIndexEntry[]>;
