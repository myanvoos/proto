import { ToolError } from "../tool-errors";

/** Rejects the common inverted call `tab.press(selector, key)` with the corrected spelling. */
export function assertTabPressArgs(key: unknown, options?: unknown): void {
	if (typeof options === "string") {
		throw new ToolError(
			`tab.press() takes (key, options) but was called as (selector, key). ` +
				`Did you mean tab.press(${JSON.stringify(options)}, { selector: ${JSON.stringify(key)} })?`,
		);
	}
}
