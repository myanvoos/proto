import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TranscriptWindow } from "./session-context";

function groupStart(messages: readonly AgentMessage[], end: number): number {
	let start = end - 1;
	if (start <= 0 || messages[start]?.role !== "toolResult") return Math.max(0, start);
	while (start > 0 && messages[start - 1]?.role === "toolResult") start--;
	const assistant = messages[start - 1];
	if (assistant?.role !== "assistant") return start;
	const callIds = new Set(assistant.content.flatMap(block => (block.type === "toolCall" ? [block.id] : [])));
	for (let index = start; index < end; index++) {
		const result = messages[index];
		if (result?.role !== "toolResult" || !callIds.has(result.toolCallId)) return start;
	}
	return start - 1;
}

/** Select by indexed payload sizes, never by hydrating a candidate page. Oversized groups display as a notice. */
export function selectTranscriptWindow(
	messages: readonly AgentMessage[],
	messageBytes: readonly number[],
	pageFromLatest: number,
	maxMessages: number,
	maxBytes: number,
): TranscriptWindow {
	const requestedPage = Math.max(0, Math.floor(pageFromLatest));
	let end = messages.length;
	let actualPage = 0;
	while (actualPage <= requestedPage) {
		const pageEnd = end;
		let start = end;
		let count = 0;
		let bytes = 0;
		while (start > 0) {
			const nextStart = groupStart(messages, start);
			const groupCount = start - nextStart;
			let groupBytes = 0;
			for (let index = nextStart; index < start; index++) groupBytes += messageBytes[index] ?? 0;
			if (count > 0 && (count + groupCount > maxMessages || bytes + groupBytes > maxBytes)) break;
			start = nextStart;
			count += groupCount;
			bytes += groupBytes;
		}
		if (actualPage === requestedPage || start === 0)
			return { start, end: pageEnd, pageFromLatest: actualPage, totalMessages: messages.length };
		end = start;
		actualPage++;
	}
	return { start: 0, end: 0, pageFromLatest: 0, totalMessages: messages.length };
}
