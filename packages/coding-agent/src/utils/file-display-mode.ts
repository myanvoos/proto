interface FileDisplayMode {
	lineNumbers: boolean;
}

interface FileDisplayModeSession {
	settings: {
		get(key: "readLineNumbers"): unknown;
	};
}

export function resolveFileDisplayMode(session: FileDisplayModeSession, options?: { raw?: boolean }): FileDisplayMode {
	const raw = options?.raw === true;
	return {
		lineNumbers: !raw && session.settings.get("readLineNumbers") === true,
	};
}
