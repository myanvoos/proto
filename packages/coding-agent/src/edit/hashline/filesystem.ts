import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	Filesystem,
	NotFoundError,
	type PreflightWriteOptions,
	sameExistingFile,
	type WriteResult,
} from "@oh-my-pi/hashline";
import { atomicWriteFilePreservingMode, isEnoent } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/acp-bridge";
import { assertEditableFileContent } from "../../tools/auto-generated-guard";
import { writeFileWithFallback } from "../../tools/file-write-fallback";
import { noteFileDeleted, noteFileRenamed, noteFileWritten } from "../../tools/fs-mutation";
import { isInternalUrlPath } from "../../tools/path-utils";
import { enforcePlanModeWrite, resolvePlanPath, targetsLocalSandbox } from "../../tools/plan-mode-guard";
import { canonicalSnapshotKey } from "../file-snapshot-store";
import { isNotebookPath } from "../notebook";
import { readEditFileText, serializeEditFileText } from "../read-file";

export interface HashlineFilesystemOptions {
	session: ToolSession;
	signal?: AbortSignal;
}

export class HashlineFilesystem extends Filesystem {
	readonly session: ToolSession;
	readonly #signal: AbortSignal | undefined;

	constructor(options: HashlineFilesystemOptions) {
		super();
		this.session = options.session;
		this.#signal = options.signal;
	}

	resolveAbsolute(relativePath: string): string {
		return resolvePlanPath(this.session, relativePath);
	}

	override canonicalPath(relativePath: string): string {
		return canonicalSnapshotKey(this.resolveAbsolute(relativePath));
	}

	override allowTagPathRecovery(authoredPath: string, resolvedPath: string): boolean {
		if (isInternalUrlPath(authoredPath)) return false;

		const root = canonicalSnapshotKey(this.session.cwd);
		if (resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`)) return true;
		return targetsLocalSandbox(this.session, resolvedPath);
	}

	async readText(relativePath: string): Promise<string> {
		const absolutePath = this.resolveAbsolute(relativePath);
		let content: string;
		try {
			content = await readEditFileText(absolutePath, relativePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			if (error instanceof Error && error.message === `File not found: ${relativePath}`) {
				throw new NotFoundError(relativePath, error);
			}
			throw error;
		}

		assertEditableFileContent(content, relativePath);
		return content;
	}

	override async readBinary(relativePath: string): Promise<Uint8Array | undefined> {
		const absolutePath = this.resolveAbsolute(relativePath);
		if (isNotebookPath(absolutePath)) return undefined;
		try {
			return await fs.readFile(absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
	}

	override async preflightWrite(relativePath: string, options?: PreflightWriteOptions): Promise<void> {
		const fileOp = options?.fileOp;
		if (fileOp?.kind === "rem") {
			enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
			return;
		}
		if (fileOp?.kind === "move") {
			enforcePlanModeWrite(this.session, relativePath, { op: "update", move: fileOp.dest });
			return;
		}
		enforcePlanModeWrite(this.session, relativePath, { op: "update" });
	}

	override async delete(relativePath: string): Promise<void> {
		enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
		const absolutePath = this.resolveAbsolute(relativePath);
		try {
			await fs.rm(absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
		await noteFileDeleted(this.session, absolutePath);
	}

	override async move(fromRelative: string, toRelative: string, content?: string): Promise<void> {
		enforcePlanModeWrite(this.session, fromRelative, { op: "update", move: toRelative });
		const fromAbsolute = this.resolveAbsolute(fromRelative);
		const toAbsolute = this.resolveAbsolute(toRelative);
		if (content !== undefined) {
			await atomicWriteFilePreservingMode(toAbsolute, content);
			if (!(await sameExistingFile(fromAbsolute, toAbsolute))) {
				await fs.rm(fromAbsolute);
			}
		} else {
			await fs.rename(fromAbsolute, toAbsolute);
		}
		await noteFileRenamed(this.session, fromAbsolute, toAbsolute);
	}

	async writeText(relativePath: string, content: string): Promise<WriteResult> {
		await this.preflightWrite(relativePath);
		const absolutePath = this.resolveAbsolute(relativePath);
		const finalContent = await serializeEditFileText(absolutePath, relativePath, content);

		if (await routeWriteThroughBridge(this.session, relativePath, absolutePath, finalContent, this.#signal)) {
			return { text: finalContent };
		}

		await writeFileWithFallback(absolutePath, finalContent, Bun.file(absolutePath));
		await noteFileWritten(this.session, absolutePath);
		return { text: finalContent };
	}

	override async exists(relativePath: string): Promise<boolean> {
		const absolutePath = this.resolveAbsolute(relativePath);
		return Bun.file(absolutePath).exists();
	}
}
