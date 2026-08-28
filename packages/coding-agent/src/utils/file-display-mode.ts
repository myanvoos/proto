import { resolveEditMode } from "./edit-mode";

interface FileDisplayMode {
	lineNumbers: boolean;
	hashLines: boolean;
}

interface FileDisplayModeSession {
	hasEditTool?: boolean;
	settings: {
		get(key: "readLineNumbers" | "edit.mode"): unknown;
	};
}

export function resolveFileDisplayMode(
	session: FileDisplayModeSession,
	options?: { raw?: boolean; immutable?: boolean },
): FileDisplayMode {
	const { settings } = session;
	const hasEditTool = session.hasEditTool ?? true;
	const editMode = resolveEditMode(session);
	const usesHashLineAnchors = editMode === "hashline";
	const raw = options?.raw === true;
	const immutable = options?.immutable === true;
	const hashLines = !raw && !immutable && hasEditTool && usesHashLineAnchors;
	return {
		hashLines,
		lineNumbers: !raw && (hashLines || settings.get("readLineNumbers") === true),
	};
}
