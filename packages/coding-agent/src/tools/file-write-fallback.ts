import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isFsError, logger } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import type { ExtensionContext } from "../extensibility/extensions/types";
import { resolveSyscallTarget } from "./path-utils";

export interface FileWriteFallbackRequest {
	dst: string;

	sessionId: string | undefined;

	content: string;

	cause: unknown;
}

export type FileWriteFallbackHandler = (req: FileWriteFallbackRequest, ctx: ExtensionContext) => Promise<boolean>;

type BoundFileWriteFallbackHandler = (req: FileWriteFallbackRequest) => Promise<boolean>;

interface FileDeleteFallbackRequest {
	dst: string;

	cause: unknown;

	confirmedFile: boolean;

	sessionId: string | undefined;
}

export type FileDeleteFallbackHandler = (req: FileDeleteFallbackRequest, ctx: ExtensionContext) => Promise<boolean>;

type BoundFileDeleteFallbackHandler = (req: FileDeleteFallbackRequest) => Promise<boolean>;

const PERMISSION_DENIED_CODES: Record<string, true> = { EPERM: true, EACCES: true, EROFS: true };
const PERMISSION_DENIED_MESSAGE = /\b(EPERM|EACCES|EROFS)\b/;

export function isPermissionDeniedError(error: unknown): boolean {
	if (isFsError(error)) return PERMISSION_DENIED_CODES[error.code] === true;

	return error instanceof Error && PERMISSION_DENIED_MESSAGE.test(error.message);
}

const fallbackHandlers: BoundFileWriteFallbackHandler[] = [];

export function hasFileWriteFallback(): boolean {
	return fallbackHandlers.length > 0;
}

export function addFileWriteFallback(handler: BoundFileWriteFallbackHandler): () => void {
	fallbackHandlers.push(handler);
	return () => {
		const index = fallbackHandlers.indexOf(handler);
		if (index !== -1) fallbackHandlers.splice(index, 1);
	};
}

const deleteFallbackHandlers: BoundFileDeleteFallbackHandler[] = [];

export function hasFileDeleteFallback(): boolean {
	return deleteFallbackHandlers.length > 0;
}

export function addFileDeleteFallback(handler: BoundFileDeleteFallbackHandler): () => void {
	deleteFallbackHandlers.push(handler);
	return () => {
		const index = deleteFallbackHandlers.indexOf(handler);
		if (index !== -1) deleteFallbackHandlers.splice(index, 1);
	};
}

const mutationSessionStorage = new AsyncLocalStorage<string>();

export function withFileMutationSession<T>(sessionId: string | undefined, fn: () => T): T {
	if (sessionId === undefined || (fallbackHandlers.length === 0 && deleteFallbackHandlers.length === 0)) return fn();
	return mutationSessionStorage.run(sessionId, fn);
}

export async function deleteFileWithFallback(dst: string, file?: BunFile): Promise<void> {
	try {
		if (file) {
			await file.unlink();
		} else {
			await fs.unlink(dst);
		}
	} catch (error) {
		if (deleteFallbackHandlers.length === 0 || !isPermissionDeniedError(error)) throw error;

		const target = await resolveSyscallTarget(dst, false);
		if (target === null) throw error;

		const stat = await fs.lstat(target).catch((statError: unknown) => {
			if (isPermissionDeniedError(statError)) return null;
			throw error;
		});
		if (stat?.isDirectory()) throw error;

		const confirmedFile = stat?.isFile() ?? false;

		const sessionId = mutationSessionStorage.getStore();

		for (const handler of [...deleteFallbackHandlers]) {
			try {
				if (await handler({ dst: target, cause: error, confirmedFile, sessionId })) return;
			} catch (handlerError) {
				logger.warn("File delete fallback handler threw; trying next handler", {
					dst: target,
					error: handlerError instanceof Error ? handlerError.message : String(handlerError),
				});
			}
		}

		throw error;
	}
}

type WriteFailureKind = { kind: "denied"; cause: unknown } | { kind: "retry" } | { kind: "rethrow" };

async function classifyWriteFailure(dst: string, error: unknown): Promise<WriteFailureKind> {
	if (isPermissionDeniedError(error)) return { kind: "denied", cause: error };
	if (!isEnoent(error)) return { kind: "rethrow" };
	try {
		await fs.mkdir(path.dirname(dst), { recursive: true });
	} catch (mkdirError) {
		if (isPermissionDeniedError(mkdirError)) return { kind: "denied", cause: mkdirError };
		return { kind: "rethrow" };
	}

	return { kind: "retry" };
}

export async function writeFileWithFallback(dst: string, content: string, file?: BunFile): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			if (file) {
				await file.write(content);
			} else {
				await Bun.write(dst, content);
			}
			return;
		} catch (error) {
			if (fallbackHandlers.length === 0) throw error;

			const failure =
				attempt === 0
					? await classifyWriteFailure(dst, error)
					: isPermissionDeniedError(error)
						? ({ kind: "denied", cause: error } as const)
						: ({ kind: "rethrow" } as const);
			if (failure.kind === "retry") continue;
			if (failure.kind === "denied") {
				const target = await resolveSyscallTarget(dst, true);

				if (target !== null) {
					const sessionId = mutationSessionStorage.getStore();
					for (const handler of [...fallbackHandlers]) {
						try {
							if (await handler({ dst: target, content, cause: failure.cause, sessionId })) return;
						} catch (handlerError) {
							logger.warn("File write fallback handler threw; trying next handler", {
								dst: target,
								error: handlerError instanceof Error ? handlerError.message : String(handlerError),
							});
						}
					}
				}
			}

			if (failure.kind === "denied" && failure.cause !== error && error instanceof Error && error.cause == null) {
				error.cause = failure.cause;
			}
			throw error;
		}
	}
}
