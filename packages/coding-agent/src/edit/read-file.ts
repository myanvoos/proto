import { hasUtf8Bom } from "@oh-my-pi/hashline";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { isNotebookPath, readEditableNotebookText, serializeEditedNotebookText } from "./notebook";

export async function readEditFileText(absolutePath: string, path: string): Promise<string> {
	try {
		if (isNotebookPath(absolutePath)) return await readEditableNotebookText(absolutePath, path);
		return await Bun.file(absolutePath).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}

export async function readEditFileTextWithBom(
	absolutePath: string,
	path: string,
): Promise<{ bom: string; content: string }> {
	if (isNotebookPath(absolutePath)) {
		return { bom: "", content: await readEditFileText(absolutePath, path) };
	}
	try {
		const bytes = await Bun.file(absolutePath).bytes();

		return { bom: hasUtf8Bom(bytes) ? "﻿" : "", content: new TextDecoder("utf-8").decode(bytes) };
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}

export async function serializeEditFileText(absolutePath: string, path: string, content: string): Promise<string> {
	if (isNotebookPath(absolutePath)) return serializeEditedNotebookText(absolutePath, path, content);
	return content;
}
