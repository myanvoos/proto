import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { localDay } from "../dirs";

interface AuditEntry {
	readonly date: number;
	readonly name: string;
	readonly hash: string;
}

interface AuditState {
	readonly keep: { readonly days: false; readonly amount: number };
	readonly auditLog: string;
	readonly files: AuditEntry[];
	readonly hashType: "sha256";
}

export interface RotatingFileOptions {
	readonly directory: string;
	readonly filenamePrefix: string;
	readonly filenameSuffix: string;
	readonly auditFile: string;
	readonly maxBytes: number;
	readonly maxFiles: number;
	/** Called with the new active file path whenever the sink switches files (construction, day or size rotation). */
	readonly onRotate?: (filePath: string) => void;
}

function isAuditEntry(value: unknown): value is AuditEntry {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return typeof entry.date === "number" && typeof entry.name === "string" && typeof entry.hash === "string";
}

export class RotatingFileSink {
	readonly #directory: string;
	readonly #filenamePrefix: string;
	readonly #filenameSuffix: string;
	readonly #auditFile: string;
	readonly #maxBytes: number;
	readonly #maxFiles: number;
	readonly #onRotate: ((filePath: string) => void) | undefined;
	#files: AuditEntry[];
	#activeDay: string | undefined;
	#activeIndex = 0;
	#activePath: string | undefined;
	#activeBytes = 0;
	#closed = false;

	constructor(options: RotatingFileOptions) {
		this.#directory = options.directory;
		this.#filenamePrefix = options.filenamePrefix;
		this.#filenameSuffix = options.filenameSuffix;
		this.#auditFile = options.auditFile;
		this.#maxBytes = options.maxBytes;
		this.#maxFiles = options.maxFiles;
		this.#onRotate = options.onRotate;
		this.#files = this.#readAudit();
		const now = new Date();
		this.#selectFile(localDay(now));
		const activePath = this.#activePath;
		if (activePath) {
			this.#registerFile(activePath, now.getTime());
			fs.closeSync(fs.openSync(activePath, "a"));
		}
	}

	write(line: string): void {
		if (this.#closed) return;
		const now = new Date();
		const record = `${line}${os.EOL}`;
		const recordBytes = Buffer.byteLength(record);
		this.#selectFile(localDay(now), recordBytes);
		const activePath = this.#activePath;
		if (!activePath) return;
		this.#registerFile(activePath, now.getTime());
		fs.appendFileSync(activePath, record, "utf8");
		this.#activeBytes += recordBytes;
	}

	close(): void {
		this.#closed = true;
	}

	#selectFile(day: string, recordBytes = 0): void {
		if (day !== this.#activeDay) {
			this.#activeDay = day;
			this.#activeIndex = 0;
			this.#setActivePath(day, 0);
		}
		// Records are never split or dropped. A record larger than the limit is
		// written intact to an empty file, then the following record rotates.
		while (this.#activeBytes > 0 && this.#activeBytes + recordBytes > this.#maxBytes) {
			this.#activeIndex++;
			this.#setActivePath(day, this.#activeIndex);
		}
	}

	#setActivePath(day: string, index: number): void {
		const suffix = index === 0 ? "" : `.${index}`;
		const nextPath = path.join(
			this.#directory,
			`${this.#filenamePrefix}.${day}.${this.#filenameSuffix}.log${suffix}`,
		);
		const changed = nextPath !== this.#activePath;
		this.#activePath = nextPath;
		try {
			this.#activeBytes = fs.statSync(this.#activePath).size;
		} catch {
			this.#activeBytes = 0;
		}
		if (changed) {
			try {
				this.#onRotate?.(this.#activePath);
			} catch {
				// A rotation observer must never break logging.
			}
		}
	}

	#registerFile(filePath: string, date: number): void {
		if (this.#files.some(file => file.name === filePath)) return;
		const hash = crypto.createHash("sha256").update(`${filePath}LOG_FILE${date}`).digest("hex");
		this.#files.push({ date, name: filePath, hash });
		while (this.#files.length > this.#maxFiles) {
			const removed = this.#files.shift();
			if (!removed) break;
			try {
				fs.rmSync(removed.name, { force: true });
			} catch {}
		}
		this.#writeAudit();
	}

	#readAudit(): AuditEntry[] {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.#auditFile, "utf8")) as { files?: unknown };
			return Array.isArray(parsed.files) ? parsed.files.filter(isAuditEntry) : [];
		} catch {
			return [];
		}
	}

	#writeAudit(): void {
		const state: AuditState = {
			keep: { days: false, amount: this.#maxFiles },
			auditLog: this.#auditFile,
			files: this.#files,
			hashType: "sha256",
		};
		fs.writeFileSync(this.#auditFile, JSON.stringify(state, undefined, 4), "utf8");
	}
}
