import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEexist, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { ToolError } from "../tools/tool-errors";
import type {
	CreateFile,
	CreateFileOptions,
	DeleteFile,
	DeleteFileOptions,
	Position,
	Range,
	RenameFile,
	RenameFileOptions,
	TextDocumentEdit,
	TextEdit,
	WorkspaceEdit,
} from "./types";
import { uriToFile } from "./utils";

export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
	const lines = content.split("\n");
	const sortedEdits = sortAndValidateTextEdits(edits);

	for (const edit of sortedEdits) {
		const { start, end } = edit.range;

		if (start.line === end.line) {
			const line = lines[start.line] || "";
			lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
		} else {
			const startLine = lines[start.line] || "";
			const endLine = lines[end.line] || "";
			const newContent = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
			lines.splice(start.line, end.line - start.line + 1, ...newContent.split("\n"));
		}
	}

	return lines.join("\n");
}

function comparePosition(a: Position, b: Position): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}
function positionsEqual(a: Position, b: Position): boolean {
	return a.line === b.line && a.character === b.character;
}

function rangesEqual(a: Range, b: Range): boolean {
	return positionsEqual(a.start, b.start) && positionsEqual(a.end, b.end);
}

function isEmptyRange(range: Range): boolean {
	return positionsEqual(range.start, range.end);
}

function formatRange(range: Range): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

export function rangesOverlap(a: Range, b: Range): boolean {
	return comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;
}

function rejectSnippetTextEdits(edits: TextEdit[]): void {
	for (const edit of edits) {
		if ("insertTextFormat" in edit && edit.insertTextFormat === 2) {
			throw new ToolError("snippet-formatted LSP edits are unsupported");
		}
	}
}

export function sortAndValidateTextEdits(edits: TextEdit[]): TextEdit[] {
	rejectSnippetTextEdits(edits);
	const sorted = edits
		.map((edit, index) => ({ edit, index }))
		.sort((a, b) => {
			if (a.edit.range.start.line !== b.edit.range.start.line) {
				return b.edit.range.start.line - a.edit.range.start.line;
			}
			if (a.edit.range.start.character !== b.edit.range.start.character) {
				return b.edit.range.start.character - a.edit.range.start.character;
			}
			return b.index - a.index;
		})
		.map(entry => entry.edit);
	const unique: TextEdit[] = [];
	for (const edit of sorted) {
		const prev = unique[unique.length - 1];
		if (prev && !isEmptyRange(edit.range) && rangesEqual(prev.range, edit.range) && prev.newText === edit.newText) {
			continue;
		}
		unique.push(edit);
	}

	for (let i = 0; i < unique.length - 1; i++) {
		const later = unique[i].range;
		const earlier = unique[i + 1].range;
		if (comparePosition(earlier.end, later.start) > 0) {
			throw new ToolError(
				`overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}; LSP produced inconsistent edits`,
			);
		}
	}

	return unique;
}

export function flattenWorkspaceTextEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
	const out = new Map<string, TextEdit[]>();
	const push = (uri: string, edits: TextEdit[]) => {
		if (edits.length === 0) return;
		const prev = out.get(uri);
		if (prev) prev.push(...edits);
		else out.set(uri, [...edits]);
	};
	if (edit.changes) {
		const changes = edit.changes;
		for (const uri in changes) push(uri, changes[uri]);
	}
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
				const tdc = change as TextDocumentEdit;
				const textEdits = tdc.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
				push(tdc.textDocument.uri, textEdits);
			}
		}
	}
	return out;
}

export async function applyTextEdits(filePath: string, edits: TextEdit[]): Promise<void> {
	const content = await Bun.file(filePath).text();
	const result = applyTextEditsToString(content, edits);
	await Bun.write(filePath, result);
}

export interface RenameReferenceEdit {
	filePath: string;
	edits: TextEdit[];
}

export async function applyEditsThenRename(
	references: RenameReferenceEdit[],
	source: string,
	dest: string,
): Promise<void> {
	const backups: Array<{ filePath: string; original: string }> = [];
	for (const { filePath, edits } of references) {
		backups.push({ filePath, original: await Bun.file(filePath).text() });
		await applyTextEdits(filePath, edits);
	}
	try {
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.rename(source, dest);
	} catch (err) {
		await Promise.all(backups.map(({ filePath, original }) => Bun.write(filePath, original)));
		throw err;
	}
}

type WorkspaceEditOp =
	| { kind: "text"; uri: string; edits: TextEdit[] }
	| { kind: "create"; uri: string; options?: CreateFileOptions }
	| { kind: "rename"; oldUri: string; newUri: string; options?: RenameFileOptions }
	| { kind: "delete"; uri: string; options?: DeleteFileOptions };

function planDocumentChanges(documentChanges: NonNullable<WorkspaceEdit["documentChanges"]>): WorkspaceEditOp[] {
	const ops: WorkspaceEditOp[] = [];
	const pending = new Map<string, TextEdit[]>();

	const flushUri = (uri: string) => {
		const edits = pending.get(uri);
		if (!edits) return;
		pending.delete(uri);
		ops.push({ kind: "text", uri, edits });
	};

	const flushSubtree = (uri: string) => {
		const prefix = uri.endsWith("/") ? uri : `${uri}/`;
		const matches: string[] = [];
		for (const candidate of pending.keys()) {
			if (candidate === uri || candidate.startsWith(prefix)) matches.push(candidate);
		}
		for (const target of matches) {
			flushUri(target);
		}
	};

	for (const change of documentChanges) {
		if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
			const tdc = change as TextDocumentEdit;
			const uri = tdc.textDocument.uri;
			const textEdits = tdc.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
			if (textEdits.length > 0) {
				const prev = pending.get(uri);
				if (prev) prev.push(...textEdits);
				else pending.set(uri, [...textEdits]);
			}
		} else if ("kind" in change && change.kind) {
			if (change.kind === "create") {
				const createOp = change as CreateFile;
				flushUri(createOp.uri);
				ops.push({ kind: "create", uri: createOp.uri, options: createOp.options });
			} else if (change.kind === "rename") {
				const renameOp = change as RenameFile;

				flushSubtree(renameOp.oldUri);
				flushSubtree(renameOp.newUri);
				ops.push({
					kind: "rename",
					oldUri: renameOp.oldUri,
					newUri: renameOp.newUri,
					options: renameOp.options,
				});
			} else if (change.kind === "delete") {
				const deleteOp = change as DeleteFile;
				flushSubtree(deleteOp.uri);
				ops.push({ kind: "delete", uri: deleteOp.uri, options: deleteOp.options });
			}
		}
	}

	for (const uri of [...pending.keys()]) {
		flushUri(uri);
	}

	return ops;
}

export type ExecutedWorkspaceChange =
	| { kind: "edit"; uri: string }
	| { kind: "create"; uri: string }
	| { kind: "rename"; oldUri: string; newUri: string }
	| { kind: "delete"; uri: string };

interface WorkspaceEditResult {
	applied: string[];

	executed: ExecutedWorkspaceChange[];
}

export async function applyWorkspaceEdit(
	edit: WorkspaceEdit,
	cwd: string,
	onExecuted?: (change: ExecutedWorkspaceChange) => void,
): Promise<WorkspaceEditResult> {
	const applied: string[] = [];
	const executed: ExecutedWorkspaceChange[] = [];
	const record = (change: ExecutedWorkspaceChange) => {
		executed.push(change);
		onExecuted?.(change);
	};

	if (edit.documentChanges) {
		const ops = planDocumentChanges(edit.documentChanges);
		for (const op of ops) {
			if (op.kind === "text") sortAndValidateTextEdits(op.edits);
		}
		for (const op of ops) {
			if (op.kind === "text") {
				const filePath = uriToFile(op.uri);
				await applyTextEdits(filePath, op.edits);
				applied.push(`Applied ${op.edits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
				record({ kind: "edit", uri: op.uri });
			} else if (op.kind === "create") {
				const filePath = uriToFile(op.uri);
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				try {
					if (op.options?.overwrite) {
						await Bun.write(filePath, "");
					} else {
						const handle = await fs.open(filePath, "wx");
						await handle.close();
					}
				} catch (error) {
					if (!(op.options?.ignoreIfExists && !op.options.overwrite && isEexist(error))) {
						throw error;
					}
					continue;
				}
				applied.push(`Created ${formatPathRelativeToCwd(filePath, cwd)}`);
				record({ kind: "create", uri: op.uri });
			} else if (op.kind === "rename") {
				const oldPath = uriToFile(op.oldUri);
				const newPath = uriToFile(op.newUri);
				await fs.mkdir(path.dirname(newPath), { recursive: true });
				if (oldPath !== newPath) {
					let displaced: { dir: string; file: string } | undefined;
					try {
						const targetStat = await fs.lstat(newPath);
						if (!op.options?.overwrite) {
							if (op.options?.ignoreIfExists) continue;
							throw new ToolError(`rename target already exists: ${formatPathRelativeToCwd(newPath, cwd)}`);
						}

						const sourceStat = await fs.lstat(oldPath);
						if (sourceStat.dev !== targetStat.dev || sourceStat.ino !== targetStat.ino) {
							const holdDir = await fs.mkdtemp(path.join(path.dirname(newPath), ".proto-displaced-"));
							const holdFile = path.join(holdDir, path.basename(newPath));
							try {
								await fs.rename(newPath, holdFile);
							} catch (error) {
								await fs.rm(holdDir, { recursive: true, force: true }).catch(() => {});
								throw error;
							}
							displaced = { dir: holdDir, file: holdFile };
						}
					} catch (error) {
						if (!isEnoent(error)) throw error;
					}
					try {
						await fs.rename(oldPath, newPath);
					} catch (error) {
						if (displaced) {
							try {
								await fs.rename(displaced.file, newPath);
							} catch {
								record({ kind: "delete", uri: op.newUri });
							}
							await fs.rm(displaced.dir, { recursive: true, force: true }).catch(() => {});
						}
						throw error;
					}
					if (displaced) {
						await fs.rm(displaced.dir, { recursive: true, force: true }).catch((error: unknown) => {
							logger.debug("LSP rename: failed to remove displaced overwrite target", {
								displaced: displaced?.dir,
								error: error instanceof Error ? error.message : String(error),
							});
						});
					}
				}
				applied.push(`Renamed ${formatPathRelativeToCwd(oldPath, cwd)} → ${formatPathRelativeToCwd(newPath, cwd)}`);
				record({ kind: "rename", oldUri: op.oldUri, newUri: op.newUri });
			} else {
				const filePath = uriToFile(op.uri);
				try {
					const stat = await fs.lstat(filePath);
					if (stat.isDirectory() && !stat.isSymbolicLink() && !op.options?.recursive) {
						await fs.rmdir(filePath);
					} else {
						await fs.rm(filePath, { recursive: op.options?.recursive ?? false });
					}
				} catch (error) {
					if (!(op.options?.ignoreIfNotExists && isEnoent(error))) throw error;
					continue;
				}
				applied.push(`Deleted ${formatPathRelativeToCwd(filePath, cwd)}`);
				record({ kind: "delete", uri: op.uri });
			}
		}
	} else if (edit.changes) {
		const changes = edit.changes;
		for (const uri in changes) {
			sortAndValidateTextEdits(changes[uri]);
		}
		for (const uri in changes) {
			const textEdits = changes[uri];
			if (textEdits.length === 0) continue;
			const filePath = uriToFile(uri);
			await applyTextEdits(filePath, textEdits);
			applied.push(`Applied ${textEdits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
			record({ kind: "edit", uri });
		}
	}

	return { applied, executed };
}
