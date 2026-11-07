import * as os from "node:os";

/**
 * Expands a leading `~` (`~`, `~/…`, `~\…`) to `home`, the user's home directory by default.
 * A `~name` path names another user's directory, so it stays as written.
 */
export function expandTilde(filePath: string, home?: string): string {
	const h = home ?? os.homedir();
	if (filePath === "~") return h;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return h + filePath.slice(1);
	}
	return filePath;
}
