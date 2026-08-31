import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AgentEvent,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type {
	CursorMcpCall,
	CursorMcpResource,
	CursorMcpResourceContent,
	CursorShellStreamCallbacks,
	CursorTodoSnapshot,
	CursorExecHandlers as ICursorExecHandlers,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import {
	omitUndefinedArgs,
	piEscapeRegexLiteral,
	piGrepSkip,
	piJoinPath,
	piLsPath,
	piReadPath,
	piTimeout,
} from "@oh-my-pi/pi-ai/providers/cursor-pi-args";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { cursorMcpPrefersReplaceEdit, normalizeCursorReplaceArgs } from "./cursor-bridge-tools";
import type { MCPResourceReadResult } from "./mcp/types";
import { confineToWorkspace, resolveToCwd } from "./tools/path-utils";
import type { TodoPhase, TodoStatus } from "./tools/todo";

const CURSOR_TODO_PHASE = "Tasks";

type CursorBridgeTool = AgentTool<any, any, any>;

export interface CursorMcpResourceAdapter {
	serverNames(): string[];
	getServerResources(
		name: string,
	): Promise<{ resources: { uri: string; name?: string; description?: string; mimeType?: string }[] } | undefined>;
	readServerResource(name: string, uri: string): Promise<MCPResourceReadResult | undefined>;
}

interface CursorExecBridgeOptions {
	cwd: string;
	getCwd?: () => string;
	tools: Map<string, AgentTool>;

	getExecutableTool?: (name: string) => AgentTool | undefined;

	getEditReplaceTool?: () => CursorBridgeTool | undefined;
	getToolContext?: () => AgentToolContext | undefined;
	emitEvent?: (event: AgentEvent) => void;

	allowDirectFileMutation?: boolean;

	setTodoPhases?: (phases: TodoPhase[]) => void;
	getTodoPhases?: () => TodoPhase[];

	persistTodoPhases?: (phases: TodoPhase[]) => void;

	mcpResources?: CursorMcpResourceAdapter;
}

async function writeWithoutFollowingLinks(absolutePath: string, payload: string | Buffer): Promise<void> {
	await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
	const handle = await fs.promises
		.open(
			absolutePath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		)
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENXIO") {
				throw new Error(`Refusing to download onto a special file: ${absolutePath}`);
			}
			throw error;
		});
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new Error(`Refusing to download onto a non-regular file: ${absolutePath}`);
		}
		if (stat.nlink > 1) {
			throw new Error(
				`Refusing to download onto a file with ${stat.nlink} hard links, which would overwrite its other names: ${absolutePath}`,
			);
		}
		await handle.truncate(0);
		await handle.writeFile(payload);
	} finally {
		await handle.close();
	}
}

function createToolResultMessage(
	toolCallId: string,
	toolName: string,
	result: AgentToolResult<unknown>,
	isError: boolean,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};
}

function buildToolErrorResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function executeTool(
	options: CursorExecBridgeOptions,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
	overrideTool?: CursorBridgeTool,
): Promise<ToolResultMessage> {
	const tool = overrideTool ?? options.getExecutableTool?.(toolName) ?? options.tools.get(toolName);
	if (!tool) {
		const result = buildToolErrorResult(`Tool "${toolName}" not available`);
		return createToolResultMessage(toolCallId, toolName, result, true);
	}

	const toolArgs = omitUndefinedArgs(args);

	options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: toolArgs });

	let result: AgentToolResult<unknown>;
	let isError = false;

	const onUpdate: AgentToolUpdateCallback<unknown> | undefined = options.emitEvent
		? partialResult => {
				const sanitizedResult: AgentToolResult<unknown> = {
					content: partialResult.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
					details: partialResult.details,
				};
				options.emitEvent?.({
					type: "tool_execution_update",
					toolCallId,
					toolName,
					args: toolArgs,
					partialResult: sanitizedResult,
				});
			}
		: undefined;

	try {
		result = await tool.execute(
			toolCallId,
			toolArgs as Record<string, unknown>,
			undefined,
			onUpdate,
			options.getToolContext?.(),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = buildToolErrorResult(message);
		isError = true;
	}
	isError ||= result.isError === true;

	const sanitizedFinalResult: AgentToolResult<unknown> = {
		content: result.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
		details: result.details,
	};
	options.emitEvent?.({ type: "tool_execution_end", toolCallId, toolName, result: sanitizedFinalResult, isError });

	return createToolResultMessage(toolCallId, toolName, result, isError);
}

async function executeDelete(options: CursorExecBridgeOptions, pathArg: string, toolCallId: string) {
	const toolName = "delete";

	if (options.allowDirectFileMutation === false) {
		const result = buildToolErrorResult(`Tool "${toolName}" not available`);
		return createToolResultMessage(toolCallId, toolName, result, true);
	}

	options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: { path: pathArg } });

	const absolutePath = resolveToCwd(pathArg, options.getCwd?.() ?? options.cwd);
	let isError = false;
	let result: AgentToolResult<unknown>;

	try {
		let fileStat: fs.Stats | undefined;
		try {
			fileStat = fs.statSync(absolutePath);
		} catch {
			throw new Error(`File not found: ${pathArg}`);
		}
		if (!fileStat.isFile()) {
			throw new Error(`Path is not a file: ${pathArg}`);
		}

		fs.rmSync(absolutePath);

		const sizeText = fileStat.size ? ` (${fileStat.size} bytes)` : "";
		const message = `Deleted ${pathArg}${sizeText}`;
		result = { content: [{ type: "text", text: message }], details: {} };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = buildToolErrorResult(message);
		isError = true;
	}

	options.emitEvent?.({ type: "tool_execution_end", toolCallId, toolName, result, isError });
	return createToolResultMessage(toolCallId, toolName, result, isError);
}

function decodeToolCallId(toolCallId?: string): string {
	return toolCallId && toolCallId.length > 0 ? toolCallId : randomUUID();
}

function decodeMcpArgs(rawArgs: Record<string, Uint8Array>): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rawArgs)) {
		const text = new TextDecoder().decode(value);
		try {
			decoded[key] = JSON.parse(text);
		} catch {
			decoded[key] = text;
		}
	}
	return decoded;
}

function formatMcpToolErrorMessage(toolName: string, availableTools: string[]): string {
	const list = availableTools.length > 0 ? availableTools.join(", ") : "none";
	return `MCP tool "${toolName}" not found. Available tools: ${list}`;
}

function formatTodoSyncSummary(phases: TodoPhase[]): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return "No todos";
	const done = tasks.filter(task => task.status === "completed").length;
	return `${done}/${tasks.length} tasks completed`;
}

function buildTodoSyncResult(
	toolCallId: string,
	phases: TodoPhase[] | undefined,
	error: string | null,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "todo",
		content: [
			{ type: "text", text: error ?? (phases ? formatTodoSyncSummary(phases) : "Todo snapshot not mirrored") },
		],
		details: phases ? { phases, storage: "session" } : undefined,
		isError: error !== null,
		timestamp: Date.now(),
	};
}

export class CursorExecHandlers implements ICursorExecHandlers {
	constructor(private options: CursorExecBridgeOptions) {}

	async read(args: Parameters<NonNullable<ICursorExecHandlers["read"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const composed = piReadPath(args.path, args.offset, args.limit);

		if (composed === null) {
			return createToolResultMessage(toolCallId, "read", { content: [{ type: "text", text: "" }] }, false);
		}
		return await executeTool(this.options, "read", toolCallId, { path: composed });
	}

	async ls(args: Parameters<NonNullable<ICursorExecHandlers["ls"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);

		const toolResultMessage = await executeTool(this.options, "read", toolCallId, { path: args.path });
		return toolResultMessage;
	}

	async grep(args: Parameters<NonNullable<ICursorExecHandlers["grep"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const searchPath = args.glob ? `${args.path || "."}/${args.glob}` : args.path || ".";
		const toolResultMessage = await executeTool(this.options, "grep", toolCallId, {
			pattern: args.pattern,
			path: searchPath,
			case: args.caseInsensitive === true ? false : undefined,
			skip: piGrepSkip(args.offset),
		});
		return toolResultMessage;
	}

	async write(args: Parameters<NonNullable<ICursorExecHandlers["write"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
		const toolResultMessage = await executeTool(this.options, "write", toolCallId, {
			path: args.path,
			content,
		});
		return toolResultMessage;
	}

	async delete(args: Parameters<NonNullable<ICursorExecHandlers["delete"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeDelete(this.options, args.path, toolCallId);
		return toolResultMessage;
	}

	async shell(args: Parameters<NonNullable<ICursorExecHandlers["shell"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const timeoutSeconds = args.timeout && args.timeout > 0 ? args.timeout : undefined;
		const toolResultMessage = await executeTool(this.options, "bash", toolCallId, {
			command: args.command,
			cwd: args.workingDirectory || undefined,
			timeout: timeoutSeconds,
		});
		return toolResultMessage;
	}

	async shellStream(
		args: Parameters<NonNullable<ICursorExecHandlers["shellStream"]>>[0],
		callbacks: CursorShellStreamCallbacks,
	) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolName = "bash";
		const tool = this.options.tools.get(toolName);
		if (!tool) {
			const result = buildToolErrorResult(`Tool "${toolName}" not available`);
			return createToolResultMessage(toolCallId, toolName, result, true);
		}

		const timeoutSeconds = args.timeout && args.timeout > 0 ? args.timeout : undefined;
		const toolArgs = omitUndefinedArgs({
			command: args.command,
			cwd: args.workingDirectory || undefined,
			timeout: timeoutSeconds,
		});

		this.options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: toolArgs });

		let result: AgentToolResult<unknown>;
		let isError = false;

		let rawText = "";
		let sanitizedRawText = "";
		let streamedSanitizedText = "";
		let canStreamSanitizedDelta = true;
		const onUpdate: AgentToolUpdateCallback<unknown> = partialResult => {
			const newRawText = partialResult.content.map(c => (c.type === "text" ? c.text : "")).join("");
			if (newRawText === rawText) {
				return;
			}
			rawText = newRawText;
			sanitizedRawText = sanitizeText(newRawText);
			const sanitizedPartialResult: AgentToolResult<unknown> = {
				content: [{ type: "text" as const, text: sanitizedRawText }],
				details: partialResult.details,
			};
			this.options.emitEvent?.({
				type: "tool_execution_update",
				toolCallId,
				toolName,
				args: toolArgs,
				partialResult: sanitizedPartialResult,
			});
			if (!canStreamSanitizedDelta) {
				return;
			}
			if (sanitizedRawText.startsWith(streamedSanitizedText)) {
				const sanitizedDelta = sanitizedRawText.slice(streamedSanitizedText.length);
				streamedSanitizedText = sanitizedRawText;
				if (sanitizedDelta) {
					callbacks.onStdout(sanitizedDelta);
				}
				return;
			}

			canStreamSanitizedDelta = false;
		};

		try {
			result = await tool.execute(toolCallId, toolArgs, undefined, onUpdate, this.options.getToolContext?.());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result = buildToolErrorResult(message);
			isError = true;
		}
		isError ||= result.isError === true;

		const finalRawText = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
		if (finalRawText !== rawText) {
			rawText = finalRawText;
			sanitizedRawText = sanitizeText(finalRawText);
		}
		if (canStreamSanitizedDelta && sanitizedRawText.startsWith(streamedSanitizedText)) {
			const finalDelta = sanitizedRawText.slice(streamedSanitizedText.length);
			streamedSanitizedText = sanitizedRawText;
			if (finalDelta) {
				callbacks.onStdout(finalDelta);
			}
		}

		const sanitizedFinalResult: AgentToolResult<unknown> = {
			content: result.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
			details: result.details,
		};
		this.options.emitEvent?.({
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: sanitizedFinalResult,
			isError,
		});
		return createToolResultMessage(toolCallId, toolName, result, isError);
	}

	async diagnostics(args: Parameters<NonNullable<ICursorExecHandlers["diagnostics"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeTool(this.options, "lsp", toolCallId, {
			action: "diagnostics",
			file: args.path,
		});
		return toolResultMessage;
	}

	async piRead(call: Parameters<NonNullable<ICursorExecHandlers["piRead"]>>[0]) {
		const { path: readPath, offset, limit } = call.args;
		const composed = piReadPath(readPath, offset, limit);

		if (composed === null) {
			return createToolResultMessage(call.toolCallId, "read", { content: [{ type: "text", text: "" }] }, false);
		}
		return await executeTool(this.options, "read", call.toolCallId, { path: composed });
	}

	async piBash(call: Parameters<NonNullable<ICursorExecHandlers["piBash"]>>[0]) {
		return await executeTool(this.options, "bash", call.toolCallId, {
			command: call.args.command,
			timeout: piTimeout(call.args.timeout),
		});
	}

	async piEdit(call: Parameters<NonNullable<ICursorExecHandlers["piEdit"]>>[0]) {
		const edits = call.args.edits.map(edit => ({ old_string: edit.oldText, new_string: edit.newText }));
		const args = edits.length === 1 ? { path: call.args.path, ...edits[0] } : { path: call.args.path, edits };
		return await executeTool(this.options, "edit", call.toolCallId, args, this.options.getEditReplaceTool?.());
	}

	async piWrite(call: Parameters<NonNullable<ICursorExecHandlers["piWrite"]>>[0]) {
		return await executeTool(this.options, "write", call.toolCallId, {
			path: call.args.path,
			content: call.args.content,
		});
	}

	async piGrep(call: Parameters<NonNullable<ICursorExecHandlers["piGrep"]>>[0]) {
		const { pattern, path, glob, ignoreCase, literal } = call.args;

		return await executeTool(this.options, "grep", call.toolCallId, {
			pattern: literal === true ? piEscapeRegexLiteral(pattern) : pattern,
			path: glob ? piJoinPath(path, glob) : path || ".",
			case: ignoreCase === true ? false : undefined,
		});
	}

	async piLs(call: Parameters<NonNullable<ICursorExecHandlers["piLs"]>>[0]) {
		return await executeTool(this.options, "read", call.toolCallId, { path: piLsPath(call.args.path) });
	}

	async listMcpResources({ server }: { server?: string }): Promise<CursorMcpResource[]> {
		const mcp = this.options.mcpResources;
		if (!mcp) return [];
		const names = server ? [server] : mcp.serverNames();

		const catalogs = await Promise.all(names.map(async name => [name, await mcp.getServerResources(name)] as const));
		const listed: CursorMcpResource[] = [];
		for (const [name, catalog] of catalogs) {
			for (const resource of catalog?.resources ?? []) {
				listed.push({
					uri: resource.uri,
					name: resource.name,
					description: resource.description,
					mimeType: resource.mimeType,
					server: name,
				});
			}
		}
		return listed;
	}

	async readMcpResource({
		server,
		uri,
		downloadPath,
	}: {
		server: string;
		uri: string;
		downloadPath?: string;
	}): Promise<CursorMcpResourceContent | null> {
		if (downloadPath) {
			if (this.options.allowDirectFileMutation === false) {
				throw new Error('Tool "write" not available: this session cannot download resources to disk.');
			}
		}
		const mcp = this.options.mcpResources;
		if (!mcp) return null;
		const read = await mcp.readServerResource(server, uri);
		if (!read) return null;

		const textItems = read.contents.filter(item => item.text !== undefined);
		const texts = textItems.map(item => item.text as string);
		const blobItem = read.contents.find(item => item.blob !== undefined);
		const blob = blobItem?.blob;
		const textMimeType = textItems[0]?.mimeType;
		const blobMimeType = blobItem?.mimeType;

		if (downloadPath) {
			const payload =
				texts.length > 0 ? texts.join("\n") : blob !== undefined ? Buffer.from(blob, "base64") : undefined;
			if (payload === undefined) return null;

			const cwd = this.options.getCwd?.() ?? this.options.cwd;
			const absolutePath = confineToWorkspace(downloadPath, cwd);
			if (!absolutePath) throw new Error(`Refusing to download outside the workspace: ${downloadPath}`);
			await writeWithoutFollowingLinks(absolutePath, payload);

			return { uri, mimeType: texts.length > 0 ? textMimeType : blobMimeType, downloadPath };
		}

		if (texts.length > 0) return { uri, mimeType: textMimeType, text: texts.join("\n") };
		if (blob === undefined) return null;
		return { uri, mimeType: blobMimeType, blob: Buffer.from(blob, "base64") };
	}

	todoSync(snapshot: CursorTodoSnapshot | null, toolCallId: string, error: string | null = null): ToolResultMessage {
		const setPhases = this.options.setTodoPhases;
		const existing = this.options.getTodoPhases?.() ?? [];

		let phases: TodoPhase[] | undefined;
		if (snapshot && setPhases) {
			const phaseByContent = new Map<string, string>();
			for (const phase of existing) {
				for (const task of phase.tasks) phaseByContent.set(task.content, phase.name);
			}

			const grouped = new Map<string, TodoPhase["tasks"]>();
			for (const todo of snapshot.todos) {
				const name = phaseByContent.get(todo.content) ?? CURSOR_TODO_PHASE;
				let tasks = grouped.get(name);
				if (!tasks) {
					tasks = [];
					grouped.set(name, tasks);
				}
				tasks.push({ content: todo.content, status: todo.status as TodoStatus });
			}

			const next: TodoPhase[] = [];
			for (const phase of existing) {
				const tasks = grouped.get(phase.name);
				if (!tasks) continue;
				next.push({ name: phase.name, tasks });
				grouped.delete(phase.name);
			}
			for (const [name, tasks] of grouped) next.push({ name, tasks });
			setPhases(next);
			this.options.persistTodoPhases?.(next);
			phases = next;
		}

		const result = buildTodoSyncResult(toolCallId, phases, error);

		this.options.emitEvent?.({
			type: "tool_execution_end",
			toolCallId,
			toolName: "todo",
			result: { content: result.content, details: result.details },
			isError: error !== null,
		});
		return result;
	}

	async mcp(call: CursorMcpCall) {
		const toolName = call.toolName || call.name;
		const toolCallId = decodeToolCallId(call.toolCallId);
		const args = Object.keys(call.args ?? {}).length > 0 ? call.args : decodeMcpArgs(call.rawArgs ?? {});
		if (cursorMcpPrefersReplaceEdit(toolName, args)) {
			const replaceTool = this.options.getEditReplaceTool?.();
			if (!replaceTool) {
				const availableTools = Array.from(this.options.tools.keys()).filter(name => name.startsWith("mcp__"));
				const message = formatMcpToolErrorMessage(toolName, availableTools);
				return createToolResultMessage(toolCallId, toolName, buildToolErrorResult(message), true);
			}
			return await executeTool(this.options, "edit", toolCallId, normalizeCursorReplaceArgs(args), replaceTool);
		}
		const tool = this.options.getExecutableTool?.(toolName) ?? this.options.tools.get(toolName);
		if (!tool) {
			const availableTools = Array.from(this.options.tools.keys()).filter(name => name.startsWith("mcp__"));
			const message = formatMcpToolErrorMessage(toolName, availableTools);
			const result = buildToolErrorResult(message);
			return createToolResultMessage(toolCallId, toolName, result, true);
		}

		const toolResultMessage = await executeTool(this.options, toolName, toolCallId, args);
		return toolResultMessage;
	}
}
