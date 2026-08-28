import * as fs from "node:fs";
import { isEnoent, logger, once, untilAborted } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import { isPermissionDeniedError, writeFileWithFallback } from "../tools/file-write-fallback";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "./client";
import { getServersForFile } from "./config";
import {
	captureDiagnosticVersions,
	captureOpenFileVersions,
	DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	type FileDiagnosticsResult,
	FileFormatResult,
	formatContent,
	getDiagnosticsForFile,
	INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	limitDiagnosticMessages,
	type ServerVersionMap,
} from "./diagnostics";
import { getConfig, notifyFileSaved, splitServers, syncFileContent } from "./servers";
import type { ServerConfig } from "./types";
import { summarizeDiagnosticMessages } from "./utils";

export interface WritethroughOptions {
	enableFormat?: boolean;

	enableDiagnostics?: boolean;

	onDeferredDiagnostics?: (diagnostics: FileDiagnosticsResult) => void;

	deferredSignal?: AbortSignal;

	transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
}

type ResolvedWritethroughOptions = {
	enableFormat: boolean;
	enableDiagnostics: boolean;
	transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
};

export type WritethroughDeferredHandle = {
	onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
	signal: AbortSignal;
	finalize: (diagnostics: FileDiagnosticsResult | undefined) => void;
};

export type WritethroughCallback = (
	dst: string,
	content: string,
	signal?: AbortSignal,
	file?: BunFile,
	batch?: LspWritethroughBatchRequest,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<FileDiagnosticsResult | undefined>;

export async function writethroughNoop(
	dst: string,
	content: string,
	_signal?: AbortSignal,
	file?: BunFile,
	_batch?: LspWritethroughBatchRequest,
	_getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	await writeFileWithFallback(dst, content, file);
	return undefined;
}

interface PendingWritethrough {
	dst: string;
	file?: BunFile;
	changeType: FileChangeType;

	content: string;
}

interface RunLspWritethroughOptions {
	contentAlreadyWritten?: boolean;
}

interface LspWritethroughBatchRequest {
	id: string;
	flush: boolean;
}

interface LspWritethroughBatchState {
	entries: Map<string, PendingWritethrough>;
	options: ResolvedWritethroughOptions;
}

const writethroughBatches = new Map<string, LspWritethroughBatchState>();

function getOrCreateWritethroughBatch(id: string, options: ResolvedWritethroughOptions): LspWritethroughBatchState {
	const existing = writethroughBatches.get(id);
	if (existing) {
		existing.options.enableFormat ||= options.enableFormat;
		existing.options.enableDiagnostics ||= options.enableDiagnostics;
		existing.options.transformDiagnostics ??= options.transformDiagnostics;
		return existing;
	}
	const batch: LspWritethroughBatchState = {
		entries: new Map<string, PendingWritethrough>(),
		options: { ...options },
	};
	writethroughBatches.set(id, batch);
	return batch;
}

export async function flushLspWritethroughBatch(
	id: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<FileDiagnosticsResult | undefined> {
	const state = writethroughBatches.get(id);
	if (!state) {
		return undefined;
	}
	writethroughBatches.delete(id);
	return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal);
}

function mergeDiagnostics(
	results: Array<FileDiagnosticsResult | undefined>,
	options: ResolvedWritethroughOptions,
): FileDiagnosticsResult | undefined {
	const messages: string[] = [];
	const servers = new Set<string>();
	let hasResults = false;
	let hasFormatter = false;
	let formatted = false;
	let hasFailed = false;
	let hasUnsupported = false;

	for (const result of results) {
		if (!result) continue;
		hasResults = true;
		if (result.server) {
			for (const server of result.server.split(",")) {
				const trimmed = server.trim();
				if (trimmed) {
					servers.add(trimmed);
				}
			}
		}
		if (result.messages.length > 0) {
			messages.push(...result.messages);
		}
		if (result.formatter !== undefined) {
			hasFormatter = true;
			if (result.formatter === FileFormatResult.FORMATTED) {
				formatted = true;
			} else if (result.formatter === FileFormatResult.FAILED) {
				hasFailed = true;
			} else if (result.formatter === FileFormatResult.UNSUPPORTED) {
				hasUnsupported = true;
			}
		}
	}

	if (!hasResults && !hasFormatter) {
		return undefined;
	}

	let summary = options.enableDiagnostics ? "no issues" : "OK";
	let errored = false;
	let limitedMessages = messages;
	if (messages.length > 0) {
		const summaryInfo = summarizeDiagnosticMessages(messages);
		summary = summaryInfo.summary;
		errored = summaryInfo.errored;
		limitedMessages = limitDiagnosticMessages(messages);
	}

	const formatter = hasFormatter
		? hasFailed
			? FileFormatResult.FAILED
			: formatted
				? FileFormatResult.FORMATTED
				: hasUnsupported && !formatted
					? FileFormatResult.UNSUPPORTED
					: FileFormatResult.UNCHANGED
		: undefined;

	return {
		server: servers.size > 0 ? Array.from(servers).join(", ") : undefined,
		messages: limitedMessages,
		summary,
		errored,
		formatter,
	};
}

async function scheduleDeferredDiagnosticsFetch(args: {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	signal: AbortSignal;
	callback: (diagnostics: FileDiagnosticsResult) => void;
}): Promise<void> {
	try {
		const deferredTimeout = AbortSignal.timeout(25_000);
		const combined = AbortSignal.any([args.signal, deferredTimeout]);
		const diagnostics = await getDiagnosticsForFile(args.dst, args.cwd, args.servers, {
			signal: combined,
			minVersions: args.minVersions,
			expectedDocumentVersions: args.expectedDocumentVersions,
			timeoutMs: DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
		});
		if (args.signal.aborted || diagnostics === undefined) return;
		args.callback(diagnostics);
	} catch {}
}

async function fetchDiagnosticsWithDeferral(args: {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	transformDiagnostics?: ResolvedWritethroughOptions["transformDiagnostics"];
	deferred?: { onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void; signal: AbortSignal };
	signal?: AbortSignal;
}): Promise<FileDiagnosticsResult | undefined> {
	const { dst, cwd, servers, minVersions, expectedDocumentVersions, transformDiagnostics, deferred, signal } = args;
	const apply = (d: FileDiagnosticsResult | undefined) =>
		d && transformDiagnostics ? transformDiagnostics(dst, d) : d;

	if (!deferred) {
		return apply(
			await getDiagnosticsForFile(dst, cwd, servers, {
				signal,
				minVersions,
				expectedDocumentVersions,
			}),
		);
	}

	const fetchPromise = getDiagnosticsForFile(dst, cwd, servers, {
		signal: deferred.signal,
		minVersions,
		expectedDocumentVersions,
		timeoutMs: DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	});
	const INLINE_TIMEOUT = Symbol("inline-diagnostics-timeout");
	const raced = await Promise.race([
		fetchPromise,
		Bun.sleep(INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS).then(() => INLINE_TIMEOUT),
	]);
	if (raced !== INLINE_TIMEOUT) {
		return apply(raced as FileDiagnosticsResult | undefined);
	}

	void fetchPromise
		.then(diagnostics => {
			if (diagnostics && !deferred.signal.aborted) deferred.onDeferredDiagnostics(diagnostics);
		})
		.catch(() => {});
	return undefined;
}

async function runLspWritethrough(
	dst: string,
	content: string,
	cwd: string,
	options: ResolvedWritethroughOptions,
	changeType: FileChangeType,
	signal?: AbortSignal,
	file?: BunFile,
	deferred?: {
		onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
		signal: AbortSignal;
	},
	runOptions?: RunLspWritethroughOptions,
): Promise<FileDiagnosticsResult | undefined> {
	const { enableFormat, enableDiagnostics } = options;
	const contentAlreadyWritten = runOptions?.contentAlreadyWritten ?? false;

	let finalContent = content;
	const writeContent = async (value: string) => writeFileWithFallback(dst, value, file);
	const getWritePromise = once(() =>
		contentAlreadyWritten && finalContent === content ? Promise.resolve() : writeContent(finalContent),
	);
	let writeNotified = false;
	const notifyWriteCommitted = async (notifySignal: AbortSignal | undefined = signal) => {
		if (writeNotified) return;
		writeNotified = true;
		try {
			await notifyWorkspaceWatchedFiles(cwd, [{ filePath: dst, type: changeType }], notifySignal);
		} catch (error) {
			if (notifySignal?.aborted && !signal?.aborted) {
				writeNotified = false;
				return;
			}
			throw error;
		}
	};
	if (!enableFormat && !enableDiagnostics) {
		await getWritePromise();
		await notifyWriteCommitted();
		return undefined;
	}

	const config = getConfig(cwd);
	const servers = getServersForFile(config, dst);

	if (servers.length === 0) {
		await getWritePromise();
		await notifyWriteCommitted();
		return undefined;
	}
	const { lspServers, customLinterServers } = splitServers(servers);
	const useCustomFormatter = enableFormat && customLinterServers.length > 0;

	const minVersionsPromise = enableDiagnostics ? captureDiagnosticVersions(cwd, servers, 5_000, signal) : undefined;
	let minVersions = useCustomFormatter ? undefined : await minVersionsPromise;
	let expectedDocumentVersions: ServerVersionMap | undefined;

	let formatter: FileFormatResult | undefined;
	let diagnostics: FileDiagnosticsResult | undefined;
	let timedOut = false;
	let synced = false;
	let operationSignal: AbortSignal | undefined;
	try {
		const timeoutSignal = AbortSignal.timeout(5_000);
		timeoutSignal.addEventListener(
			"abort",
			() => {
				timedOut = true;
			},
			{ once: true },
		);
		operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		await untilAborted(operationSignal, async () => {
			if (useCustomFormatter) {
				if (!contentAlreadyWritten) await writeContent(content);
				const [formattedContent, capturedVersions] = await Promise.all([
					formatContent(dst, content, cwd, customLinterServers, operationSignal),
					minVersionsPromise,
				]);
				finalContent = formattedContent.content;
				minVersions = capturedVersions;
				if (formattedContent.failed) {
					formatter = FileFormatResult.FAILED;
				} else if (formattedContent.unsupported) {
					formatter = FileFormatResult.UNSUPPORTED;
				} else {
					formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				}
				if (!contentAlreadyWritten || finalContent !== content) await writeContent(finalContent);
				await notifyWriteCommitted(operationSignal);
				await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal, enableDiagnostics);
			} else {
				await syncFileContent(dst, content, cwd, lspServers, operationSignal);

				if (enableFormat) {
					const formatted = await formatContent(dst, content, cwd, lspServers, operationSignal);
					finalContent = formatted.content;
					if (formatted.failed) {
						formatter = FileFormatResult.FAILED;
					} else if (formatted.unsupported) {
						formatter = FileFormatResult.UNSUPPORTED;
					} else {
						formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
					}
				}

				if (finalContent !== content) {
					await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
				}

				await getWritePromise();
				await notifyWriteCommitted(operationSignal);
			}

			if (enableDiagnostics) {
				expectedDocumentVersions = await captureOpenFileVersions(dst, cwd, lspServers, operationSignal);
			}

			await notifyFileSaved(dst, cwd, lspServers, operationSignal, !useCustomFormatter || enableDiagnostics);
		});
		synced = true;
	} catch {
		if (timedOut) {
			formatter = undefined;
			diagnostics = undefined;

			if (deferred && !deferred.signal.aborted && enableDiagnostics) {
				void scheduleDeferredDiagnosticsFetch({
					dst,
					cwd,
					servers,
					minVersions,
					expectedDocumentVersions,
					signal: deferred.signal,
					callback: deferred.onDeferredDiagnostics,
				});
			}
		}
		await getWritePromise();

		await notifyWriteCommitted();
	}

	if (synced && enableDiagnostics) {
		diagnostics = await fetchDiagnosticsWithDeferral({
			dst,
			cwd,
			servers,
			minVersions,
			expectedDocumentVersions,
			transformDiagnostics: options.transformDiagnostics,
			deferred,
			signal,
		});
	}

	if (formatter !== undefined) {
		diagnostics ??= {
			server: servers.map(([name]) => name).join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
		diagnostics.formatter = formatter;
	}

	return diagnostics;
}

async function flushWritethroughBatch(
	batch: PendingWritethrough[],
	cwd: string,
	options: ResolvedWritethroughOptions,
	signal?: AbortSignal,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	if (batch.length === 0) {
		return undefined;
	}
	const results: Array<FileDiagnosticsResult | undefined> = [];
	for (const entry of batch) {
		const bundle = getDeferred?.(entry.dst);
		let content: string;
		try {
			content = await fs.promises.readFile(entry.dst, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				bundle?.finalize(undefined);
				continue;
			}

			if (!isPermissionDeniedError(error)) throw error;
			content = entry.content;
		}
		const deferredInner =
			bundle &&
			({
				onDeferredDiagnostics: bundle.onDeferredDiagnostics,
				signal: bundle.signal,
			} as const);
		const diag = await runLspWritethrough(
			entry.dst,
			content,
			cwd,
			options,
			entry.changeType,
			signal,
			entry.file,
			deferredInner,
			{ contentAlreadyWritten: true },
		);
		bundle?.finalize(diag);
		results.push(diag);
	}
	return mergeDiagnostics(results, options);
}

export function createLspWritethrough(cwd: string, options?: WritethroughOptions): WritethroughCallback {
	const resolvedOptions: ResolvedWritethroughOptions = {
		enableFormat: options?.enableFormat ?? false,
		enableDiagnostics: options?.enableDiagnostics ?? false,
		transformDiagnostics: options?.transformDiagnostics,
	};
	return async (
		dst: string,
		content: string,
		signal?: AbortSignal,
		file?: BunFile,
		batch?: LspWritethroughBatchRequest,
		getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
	) => {
		const changeType = (await Bun.file(dst).exists()) ? FileChangeType.Changed : FileChangeType.Created;
		if (!batch) {
			const bundle = getDeferred?.(dst);
			const deferredInner =
				bundle &&
				({
					onDeferredDiagnostics: bundle.onDeferredDiagnostics,
					signal: bundle.signal,
				} as const);
			const diagnostics = await runLspWritethrough(
				dst,
				content,
				cwd,
				resolvedOptions,
				changeType,
				signal,
				file,
				deferredInner,
			);
			bundle?.finalize(diagnostics);
			return diagnostics;
		}

		try {
			await writethroughNoop(dst, content, signal, file);
		} catch (error) {
			if (batch.flush) {
				const pending = writethroughBatches.get(batch.id);
				if (pending) {
					writethroughBatches.delete(batch.id);
					try {
						await flushWritethroughBatch(
							Array.from(pending.entries.values()),
							cwd,
							pending.options,
							signal,
							getDeferred,
						);
					} catch (flushError) {
						logger.warn("Failed to flush pending LSP batch after final write failure", {
							batchId: batch.id,
							error: flushError instanceof Error ? flushError.message : String(flushError),
						});
					}
				}
			}
			throw error;
		}

		const state = getOrCreateWritethroughBatch(batch.id, resolvedOptions);
		state.entries.set(dst, { dst, file, changeType, content });
		if (!batch.flush) return undefined;

		writethroughBatches.delete(batch.id);
		return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal, getDeferred);
	};
}
