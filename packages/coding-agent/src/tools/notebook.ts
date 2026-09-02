import * as path from "node:path";

import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

export type NotebookCellType = "code" | "markdown" | "raw";

export interface NotebookCell {
	cell_type: NotebookCellType;
	source?: string | string[];
	metadata?: Record<string, unknown>;
	execution_count?: number | null;
	outputs?: unknown[];
	[key: string]: unknown;
}

export interface NotebookDocument {
	cells: NotebookCell[];
	metadata: Record<string, unknown>;
	nbformat: number;
	nbformat_minor: number;
	[key: string]: unknown;
}

const ESCAPABLE_MARKER_RE = /^# %%+ \[(?:code|markdown|raw)\](?: cell:\d+)?$/;

function escapeMarkerLikeSourceLines(source: string): string {
	if (!source.includes("# %%")) return source;
	return source
		.split("\n")
		.map(line => (ESCAPABLE_MARKER_RE.test(line) ? line.replace("# %", "# %%") : line))
		.join("\n");
}

export function isNotebookPath(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() === ".ipynb";
}

function isCellType(value: unknown): value is NotebookCellType {
	return value === "code" || value === "markdown" || value === "raw";
}

function sourceToText(source: string | string[] | undefined): string {
	if (source === undefined) return "";
	if (typeof source === "string") return source;
	return source.join("");
}

function validateNotebook(value: unknown, displayPath: string): NotebookDocument {
	if (!isRecord(value)) {
		throw new Error(`Invalid notebook structure (expected object): ${displayPath}`);
	}
	if (!Array.isArray(value.cells)) {
		throw new Error(`Invalid notebook structure (missing cells array): ${displayPath}`);
	}
	for (let index = 0; index < value.cells.length; index++) {
		const cell = value.cells[index];
		if (!isRecord(cell) || !isCellType(cell.cell_type)) {
			throw new Error(`Invalid notebook cell ${index} in ${displayPath}`);
		}
	}
	return value as unknown as NotebookDocument;
}

export async function readNotebookDocument(absolutePath: string, displayPath: string): Promise<NotebookDocument> {
	try {
		return validateNotebook(await Bun.file(absolutePath).json(), displayPath);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`File not found: ${displayPath}`);
		if (error instanceof SyntaxError) throw new Error(`Invalid JSON in notebook: ${displayPath}`);
		throw error;
	}
}

export function notebookToEditableText(notebook: NotebookDocument): string {
	return notebook.cells
		.map((cell, index) => {
			const source = escapeMarkerLikeSourceLines(sourceToText(cell.source));
			return source.length > 0
				? `# %% [${cell.cell_type}] cell:${index}\n${source}`
				: `# %% [${cell.cell_type}] cell:${index}`;
		})
		.join("\n");
}

export async function readEditableNotebookText(absolutePath: string, displayPath: string): Promise<string> {
	return notebookToEditableText(await readNotebookDocument(absolutePath, displayPath));
}
