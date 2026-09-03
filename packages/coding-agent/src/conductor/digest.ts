import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { escapeXmlText } from "@oh-my-pi/pi-utils";

/** One primary session turn headline line in the digest activity section. */
export interface DigestActivityLine {
	kind: "user" | "assistant" | "advisor" | "custom";
	/** For "assistant": comma-joined tool call headlines like `bash(rg "foo")`, `read(src/x.ts)`; empty when the turn had none. */
	tools: string;
	/** First meaningful line of the turn's text content, elided; empty when none. */
	text: string;
}

export interface EpochDigestInput {
	/** Full primary transcript snapshot. */
	messages: readonly AgentMessage[];
	/** Messages before this index were already digested in earlier epochs. */
	cursor: number;
	/** Why the conductor woke, one per line item, already human-phrased by the caller. */
	wakeReasons: readonly string[];
	/** 1-based number of the epoch this digest is assembled for. */
	epochNumber: number;
	/** Pre-rendered goal/budget summary block (caller-owned wording). */
	goalSummary: string;
	/** Pre-rendered working-tree diff summary, or undefined when unavailable (caller runs git). */
	diffStat: string | undefined;
}

export interface EpochDigest {
	/** The full digest text, wrapped in an `<epoch-digest epoch="N">...</epoch-digest>` XML-ish envelope. */
	text: string;
	/** Cursor the caller must store for the next epoch: always `messages.length` after clamping. */
	cursor: number;
	/** Number of transcript messages summarized in the activity section. */
	turns: number;
	/** True when activity lines were elided by the cap. */
	truncated: boolean;
	/** The individual activity lines, in chronological order, after the cap was applied. */
	activity: readonly DigestActivityLine[];
}

const MAX_ACTIVITY_LINES = 80;
const TEXT_ELIDE_CHARS = 160;
const TOOL_PREVIEW_CHARS = 60;

/** Tool-call argument keys whose string value becomes the preview, in priority order. */
const TOOL_ARG_KEYS = ["command", "file_path", "path", "pattern", "query", "url"] as const;

/** Custom message types emitted by the run machinery — noise for the conductor, never surfaced. */
const MACHINERY_CUSTOM_TYPES = new Set([
	"goal-continuation",
	"goal-budget-limit",
	"session-stop-continuation",
	"conductor-verification",
	"conductor-epoch",
]);

const ADVISOR_CUSTOM_TYPE = "advisor";

/** First line of `source` carrying non-whitespace content, with internal whitespace runs collapsed. */
function firstMeaningfulLine(source: string): string {
	const line = source.split("\n").find(candidate => candidate.trim()) ?? "";
	return line.replace(/\s+/g, " ").trim();
}

function elide(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Headline for mixed content (string or text/image blocks): first meaningful text line, elided. */
function contentHeadline(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return elide(firstMeaningfulLine(content), TEXT_ELIDE_CHARS);
	const text = content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	return elide(firstMeaningfulLine(text), TEXT_ELIDE_CHARS);
}

/** `name(preview)` — preview is the first string argument under the priority keys, elided. */
function toolHeadline(call: ToolCall): string {
	for (const key of TOOL_ARG_KEYS) {
		const value = call.arguments[key];
		if (typeof value === "string") return `${call.name}(${elide(value, TOOL_PREVIEW_CHARS)})`;
	}
	return `${call.name}()`;
}

/** Summarizes one transcript message into an activity line, or undefined when it carries no headline. */
function summarizeMessage(message: AgentMessage): DigestActivityLine | undefined {
	if (message.role === "toolResult") return undefined;
	if (message.role === "custom") {
		const custom = message;
		if (custom.customType === ADVISOR_CUSTOM_TYPE) {
			return { kind: "advisor", tools: "", text: contentHeadline(custom.content) };
		}
		if (MACHINERY_CUSTOM_TYPES.has(custom.customType)) return undefined;
		return {
			kind: "custom",
			tools: "",
			text: elide(`${custom.customType}: ${firstMeaningfulLine(contentHeadline(custom.content))}`, TEXT_ELIDE_CHARS),
		};
	}
	if (message.role === "user" || message.role === "developer") {
		return { kind: "user", tools: "", text: contentHeadline(message.content) };
	}
	if (message.role === "assistant") {
		const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
		const text = message.content
			.filter((block): block is TextContent => block.type === "text")
			.map(block => block.text)
			.join("\n");
		const headline = elide(firstMeaningfulLine(text), TEXT_ELIDE_CHARS);
		if (toolCalls.length === 0 && !headline) return undefined;
		return { kind: "assistant", tools: toolCalls.map(toolHeadline).join(", "), text: headline };
	}
	return undefined;
}

function renderActivityLine(line: DigestActivityLine): string {
	const label = line.kind === "assistant" ? "agent" : line.kind;
	return `- [${label}] ${line.tools}${line.tools && line.text ? " | " : ""}${line.text}`;
}

function renderEnvelope(
	epochNumber: number,
	wakeReasons: readonly string[],
	goalSummary: string,
	activityLines: readonly DigestActivityLine[],
	sinceCursor: number,
	truncated: boolean,
	diffStat: string | undefined,
): string {
	const activityBody =
		activityLines.length === 0
			? "no primary activity since the last epoch"
			: activityLines.map(renderActivityLine).join("\n");
	return [
		`<epoch-digest epoch="${escapeXmlText(String(epochNumber))}">`,
		"<wake-reasons>",
		escapeXmlText(wakeReasons.map(reason => `- ${reason}`).join("\n")),
		"</wake-reasons>",
		"<goal>",
		goalSummary,
		"</goal>",
		`<activity turns="${activityLines.length}" truncated="${truncated}" since-cursor="${sinceCursor}">`,
		escapeXmlText(activityBody),
		"</activity>",
		"<working-tree>",
		diffStat ?? "unavailable",
		"</working-tree>",
		"</epoch-digest>",
	].join("\n");
}

/**
 * Assembles the conductor's mechanically derived epoch digest: a capped, elided headline view of the primary
 * transcript since `cursor`, wrapped in the epoch envelope. Pure — no I/O, no clocks.
 */
export function assembleEpochDigest(input: EpochDigestInput): EpochDigest {
	const { messages, wakeReasons, epochNumber, goalSummary, diffStat } = input;
	// A cursor beyond the transcript means it was rewritten or compacted — re-scan from zero.
	const cursor = input.cursor < 0 || input.cursor > messages.length ? 0 : input.cursor;
	const lines: DigestActivityLine[] = [];
	for (const message of messages.slice(cursor)) {
		const line = summarizeMessage(message);
		if (line) lines.push(line);
	}
	const turns = lines.length;
	const truncated = lines.length > MAX_ACTIVITY_LINES;
	const activity = truncated ? lines.slice(-MAX_ACTIVITY_LINES) : lines;
	return {
		text: renderEnvelope(epochNumber, wakeReasons, goalSummary, activity, cursor, truncated, diffStat),
		cursor: messages.length,
		turns,
		truncated,
		activity,
	};
}
