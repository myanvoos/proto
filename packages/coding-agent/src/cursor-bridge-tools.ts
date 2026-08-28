import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { EditTool } from "./edit";
import type { ExtensionRunner } from "./extensibility/extensions";
import { ExtensionToolWrapper } from "./extensibility/extensions";
import type { Tool, ToolSession } from "./tools";

export function createBridgeEditTool(session: ToolSession, extensionRunner: ExtensionRunner): AgentTool {
	const editTool: Tool = new EditTool(session);
	return new ExtensionToolWrapper(editTool, extensionRunner);
}

export function bridgeToolMap(
	granted: ReadonlyMap<string, AgentTool>,
	createEditTool: (() => AgentTool | undefined) | undefined,
): Map<string, AgentTool> {
	const bridged = new Map(granted);
	if (!granted.has("edit") || !createEditTool) return bridged;
	const bridgeEdit = createEditTool();
	if (bridgeEdit) bridged.set("edit", bridgeEdit);
	return bridged;
}

const CURSOR_STRREPLACE_MCP_NAMES = new Set([
	"StrReplace",
	"str_replace",
	"strReplace",
	"SearchReplace",
	"search_replace",
	"Edit",
]);

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

function isCursorStrReplaceMcpName(name: string): boolean {
	return CURSOR_STRREPLACE_MCP_NAMES.has(name);
}

export function normalizeCursorReplaceArgs(args: Record<string, unknown>): Record<string, unknown> {
	const path = stringArg(args, "path");
	const old_string =
		stringArg(args, "old_string") ??
		stringArg(args, "old_str") ??
		stringArg(args, "old_text") ??
		stringArg(args, "oldString") ??
		stringArg(args, "oldText");
	const new_string =
		stringArg(args, "new_string") ??
		stringArg(args, "new_str") ??
		stringArg(args, "new_text") ??
		stringArg(args, "newString") ??
		stringArg(args, "newText");
	const replaceAll = args.replace_all ?? args.replaceAll;
	if (path === undefined || old_string === undefined || new_string === undefined) return args;
	return {
		path,
		old_string,
		new_string,
		...(typeof replaceAll === "boolean" ? { replace_all: replaceAll } : {}),
	};
}

export function cursorMcpPrefersReplaceEdit(name: string, args: Record<string, unknown>): boolean {
	if (isCursorStrReplaceMcpName(name)) return true;
	if (name !== "edit") return false;
	if (typeof args.input === "string" || typeof args._input === "string") return false;
	const old_string =
		stringArg(args, "old_string") ??
		stringArg(args, "old_str") ??
		stringArg(args, "old_text") ??
		stringArg(args, "oldString") ??
		stringArg(args, "oldText");
	const new_string =
		stringArg(args, "new_string") ??
		stringArg(args, "new_str") ??
		stringArg(args, "new_text") ??
		stringArg(args, "newString") ??
		stringArg(args, "newText");
	return old_string !== undefined && new_string !== undefined;
}
