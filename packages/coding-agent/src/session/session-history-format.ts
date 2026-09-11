import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	AudioContent,
	ImageContent,
	TextContent,
	ToolResultMessage,
	VideoContent,
} from "@oh-my-pi/pi-ai";
import { INTENT_FIELD } from "@oh-my-pi/pi-utils";
import { countTextLines } from "../tools/read-format";
import type {
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
	FileMentionMessage,
	HookMessage,
	PythonExecutionMessage,
} from "./messages";

interface HistoryFormatOptions {
	title?: string;

	includeThinking?: boolean;

	includeToolIntent?: boolean;

	watchedRoles?: boolean;

	expandEditDiffs?: boolean;

	toolResultIndex?: ReadonlyMap<string, ToolResultMessage>;
	consumedToolCallIds?: Set<string>;

	watchedRoleState?: { lastLabel: string | undefined };
}

const PRIMARY_ARG_MAX = 120;

const PRIMARY_ARG_KEYS = [
	"path",
	"file_path",
	"filePath",
	"command",
	"cmd",
	"pattern",
	"url",
	"query",
	"prompt",
	"assignment",
	"note",
	"message",
	"op",
	"name",
	"id",
] as const;

function oneLine(text: string, max = PRIMARY_ARG_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatExecutionSourcePreview(source: string): string {
	return oneLine(source);
}

function contentToText(
	content: string | readonly (TextContent | ImageContent | AudioContent | VideoContent)[],
): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
		else parts.push(`[${block.type}]`);
	}
	return parts.join("\n");
}

function primaryArgValue(value: unknown): string {
	if (typeof value === "string" && value.length > 0) return value;
	if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === "string")) {
		return value.join(", ");
	}
	return "";
}

function formatToolCallPrimaryArg(name: string, args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "";

	if (name === "advise") {
		const note = typeof args.note === "string" ? args.note : "";
		const severity = typeof args.severity === "string" ? args.severity : "";
		if (note && severity) return oneLine(`${severity}: ${note}`);
		if (note) return oneLine(note);
		if (severity) return oneLine(severity);
	}
	for (const key of PRIMARY_ARG_KEYS) {
		const value = args[key];
		const summary = primaryArgValue(value);
		if (summary) return oneLine(summary);
	}

	const rest: Record<string, unknown> = {};
	let restCount = 0;
	for (const key in args) {
		if (key === INTENT_FIELD) continue;
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return oneLine(value);
		rest[key] = value;
		restCount++;
	}
	if (restCount === 0) return "{}";
	try {
		return oneLine(JSON.stringify(rest));
	} catch {
		return "";
	}
}

function formatToolCallIntentPreview(args: Record<string, unknown> | undefined): string | undefined {
	const intent = args?.[INTENT_FIELD];
	return typeof intent === "string" && intent.trim() ? oneLine(intent, 80) : undefined;
}

function formatToolResultErrorPreviewText(text: string): string {
	const newlineIndex = text.indexOf("\n");
	return oneLine(newlineIndex === -1 ? text : text.slice(0, newlineIndex));
}

export function formatToolResultErrorPreview(content: string | readonly (TextContent | ImageContent)[]): string {
	return formatToolResultErrorPreviewText(contentToText(content));
}

function fenceDiff(diff: string): string {
	const longest = diff.match(/`+/g)?.reduce((m, run) => Math.max(m, run.length), 0) ?? 0;
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}diff\n${diff}\n${fence}`;
}

function toolCallLine(
	name: string,
	args: Record<string, unknown> | undefined,
	result: ToolResultMessage | undefined,
	includeToolIntent?: boolean,
	expandEditDiffs?: boolean,
): string {
	const head = `→ ${name}(${formatToolCallPrimaryArg(name, args)})`;
	let base: string;
	if (!result) {
		base = `${head} ⇒ pending`;
	} else {
		const text = contentToText(result.content);
		const lines = countTextLines(text);
		const count = `${lines} ${lines === 1 ? "line" : "lines"}`;
		if (result.isError) {
			const firstLine = formatToolResultErrorPreviewText(text);
			base = firstLine ? `${head} ⇒ error · ${count} — ${firstLine}` : `${head} ⇒ error · ${count}`;
		} else {
			base = `${head} ⇒ ok · ${count}`;
		}
	}

	if (expandEditDiffs) {
		const diff = (result?.details as { diff?: unknown } | undefined)?.diff;
		if (typeof diff === "string" && diff.trim()) {
			base = `${base}\n${fenceDiff(diff)}`;
		}
	}

	const formattedIntent = includeToolIntent ? formatToolCallIntentPreview(args) : undefined;
	if (formattedIntent) return `// ${formattedIntent}\n${base}`;
	return base;
}

function executionLine(
	kind: "bash" | "python",
	source: string,
	msg: BashExecutionMessage | PythonExecutionMessage,
): string {
	const execution = msg.execution;
	const status = execution
		? execution.state === "running"
			? "running"
			: execution.state === "unknown"
				? "unknown"
				: execution.exitCode === 0
					? "ok"
					: execution.exitCode !== undefined
						? `error · exit ${execution.exitCode}`
						: "exited"
		: msg.cancelled
			? "cancelled"
			: msg.exitCode !== undefined && msg.exitCode !== 0
				? `error · exit ${msg.exitCode}`
				: "ok";
	const details: string[] = [];
	if (execution?.signal !== undefined) details.push(`signal ${execution.signal}`);
	if (execution?.elapsedMs !== undefined) details.push(`${Math.round(execution.elapsedMs)}ms`);
	if (execution?.timeout) details.push(`timeout ${execution.timeout.cause}/${execution.timeout.scope}`);
	if (execution?.collector.state === "failed") details.push("collector failed");
	if (execution?.renderer?.state === "failed") details.push("renderer failed");
	const lines = countTextLines(msg.output);
	const sourcePreview = formatExecutionSourcePreview(source);
	const suffix = details.length > 0 ? ` · ${details.join(", ")}` : "";
	return `→ user-${kind}! ${sourcePreview} ⇒ ${status}${suffix} · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

const CONTEXTUAL_NON_PRIMARY_HIDDEN_CUSTOM_TYPES: Record<string, true> = {
	"image-attachment-description": true,
};

function customOneLiner(msg: CustomMessage | HookMessage): string {
	const details = (msg.details ?? {}) as Record<string, unknown>;
	const str = (key: string): string => (typeof details[key] === "string" ? (details[key] as string) : "");
	switch (msg.customType) {
		case "irc:incoming":
			return `[irc] ${str("from") || "?"} → me: ${oneLine(str("message"))}`;
		case "irc:relay":
			return `[irc] ${str("from") || "?"} → ${str("to") || "?"}: ${oneLine(str("body"))}`;
		case "async-result": {
			const jobs = Array.isArray(details.jobs) && details.jobs.length > 0 ? details.jobs : [details];
			const labels = jobs
				.map(job => {
					const j = (job ?? {}) as Record<string, unknown>;
					return typeof j.label === "string" && j.label ? j.label : typeof j.jobId === "string" ? j.jobId : "job";
				})
				.join(", ");
			return `[async-result] ${oneLine(labels)}`;
		}
		default:
			return `[${msg.customType}] ${oneLine(contentToText(msg.content))}`;
	}
}

export function formatSessionHistoryMarkdown(messages: unknown[], opts?: HistoryFormatOptions): string {
	const typed = messages as AgentMessage[];
	const lines: string[] = [];
	if (opts?.title) {
		lines.push(`# ${opts.title}`, "");
	}

	let resultsByCallId = opts?.toolResultIndex;
	if (!resultsByCallId) {
		const local = new Map<string, ToolResultMessage>();
		for (const msg of typed) {
			if (msg.role === "toolResult") {
				local.set(msg.toolCallId, msg);
			}
		}
		resultsByCallId = local;
	}
	const consumed = opts?.consumedToolCallIds ?? new Set<string>();

	let lastWatchedLabel: string | undefined = opts?.watchedRoleState?.lastLabel;

	const pushWatchedRole = (label: string, body: string): void => {
		if (lastWatchedLabel === label) {
			lines.push(body, "");
		} else {
			lines.push(label, body, "");
			lastWatchedLabel = label;
		}
	};

	for (const msg of typed) {
		switch (msg.role) {
			case "user":
			case "developer": {
				const text = contentToText(msg.content);
				if (!text.trim()) break;
				if (opts?.watchedRoles) {
					const label = `**${msg.role}**:`;
					if (lastWatchedLabel === label) {
						lines.push(text, "");
					} else {
						lines.push(label, text, "");
						lastWatchedLabel = label;
					}
				} else {
					lines.push(`## ${msg.role}`, "", text, "");
				}
				break;
			}
			case "assistant": {
				const assistantMsg = msg as AssistantMessage;
				const body: string[] = [];
				for (const block of assistantMsg.content) {
					if (block.type === "text") {
						if (block.text.trim()) body.push(block.text);
					} else if (block.type === "toolCall") {
						const result = resultsByCallId.get(block.id);
						if (result) consumed.add(block.id);
						body.push(
							toolCallLine(block.name, block.arguments, result, opts?.includeToolIntent, opts?.expandEditDiffs),
						);
					} else if (opts?.includeThinking && block.type === "thinking" && block.thinking.trim()) {
						body.push(`_thinking:_ ${block.thinking}`);
					}
				}
				if (body.length === 0) break;
				if (opts?.watchedRoles) {
					const label = "**agent**:";
					if (lastWatchedLabel === label) {
						lines.push(...body, "");
					} else {
						lines.push(label, ...body, "");
						lastWatchedLabel = label;
					}
				} else {
					lines.push("## assistant", "", ...body, "");
				}
				break;
			}
			case "toolResult": {
				if (consumed.has(msg.toolCallId)) break;
				lines.push(toolCallLine(msg.toolName, undefined, msg, opts?.includeToolIntent, opts?.expandEditDiffs), "");
				lastWatchedLabel = undefined;
				break;
			}
			case "bashExecution": {
				const bashMsg = msg as BashExecutionMessage;
				if (bashMsg.excludeFromContext) break;
				const bashLine = executionLine("bash", bashMsg.command, bashMsg);
				if (opts?.watchedRoles) {
					pushWatchedRole("**user**:", bashLine);
				} else {
					lines.push(bashLine, "");
					lastWatchedLabel = undefined;
				}
				break;
			}
			case "pythonExecution": {
				const pythonMsg = msg as PythonExecutionMessage;
				if (pythonMsg.excludeFromContext) break;
				const pythonLine = executionLine("python", pythonMsg.code, pythonMsg);
				if (opts?.watchedRoles) {
					pushWatchedRole("**user**:", pythonLine);
				} else {
					lines.push(pythonLine, "");
					lastWatchedLabel = undefined;
				}
				break;
			}
			case "custom":
			case "hookMessage": {
				const custom = msg as CustomMessage | HookMessage;
				if (custom.display === false && CONTEXTUAL_NON_PRIMARY_HIDDEN_CUSTOM_TYPES[custom.customType] !== true) {
					break;
				}
				lines.push(customOneLiner(custom), "");
				lastWatchedLabel = undefined;
				break;
			}
			case "branchSummary": {
				const branchMsg = msg as BranchSummaryMessage;
				lines.push(`[branch] from ${branchMsg.fromId}: ${oneLine(branchMsg.summary)}`, "");
				lastWatchedLabel = undefined;
				break;
			}
			case "compactionSummary": {
				const compactMsg = msg as CompactionSummaryMessage;
				lines.push(`[compaction] ${oneLine(compactMsg.summary)}`, "");
				lastWatchedLabel = undefined;
				break;
			}
			case "fileMention": {
				const fileMsg = msg as FileMentionMessage;
				lines.push(`[file-mention] ${oneLine(fileMsg.files.map(f => f.path).join(", "))}`, "");
				lastWatchedLabel = undefined;
				break;
			}
		}
	}

	if (opts?.watchedRoleState) {
		opts.watchedRoleState.lastLabel = lastWatchedLabel;
	}

	return `${lines.join("\n").trim()}\n`;
}
