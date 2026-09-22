import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { LoadExtensionsResult } from "./types";

/**
 * Loader failures arrive wrapped in host-module plumbing: the message repeats the "Failed to load
 * extension" prefix, carries the cache-busting `?mtime=` query the host adds, and names the
 * internal module that performed the import. None of that helps whoever wrote the extension.
 */
function cleanReason(reason: string): string {
	return reason
		.replace(/\?mtime=\d+/g, "")
		.replace(/ imported from \S+/g, "")
		.replace(/^Failed to load extension:?\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function formatExtensionLoadWarnings(
	warnings: LoadExtensionsResult["warnings"],
	options?: { truncate?: boolean },
): string[] {
	const truncate = options?.truncate ?? true;
	return warnings.map(({ path, warning }) => {
		const displayPath = truncate ? truncateToWidth(replaceTabs(shortenPath(path)), TRUNCATE_LENGTHS.CONTENT) : path;
		return `Extension ${displayPath} ${warning}`;
	});
}

export function formatExtensionLoadNotifications(
	errors: LoadExtensionsResult["errors"],
	options?: { truncate?: boolean },
): string[] {
	// The TUI clamps to its own widths; stderr has no width to respect and swallowing the tail of a
	// path or a stack-free reason there is what made these errors unactionable.
	const truncate = options?.truncate ?? true;
	const messages: string[] = [];
	for (const { path, error } of errors) {
		const reason = cleanReason(error);
		const displayPath = truncate ? truncateToWidth(replaceTabs(shortenPath(path)), TRUNCATE_LENGTHS.CONTENT) : path;
		const displayError = truncate ? truncateToWidth(replaceTabs(reason), TRUNCATE_LENGTHS.LONG) : reason;
		messages.push(`Failed to load extension ${displayPath}: ${displayError}`);
	}
	return messages;
}
