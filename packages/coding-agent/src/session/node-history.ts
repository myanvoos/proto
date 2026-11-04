import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { RPC_MESSAGES_PAGE_STALE_ERROR, RpcMessagesPageError } from "../modes/rpc/rpc-messages";
import { TRANSCRIPT_PAGE_MAX_BYTES, TRANSCRIPT_WINDOW_MESSAGES } from "../modes/utils/transcript-window";
import type { NodeTarget } from "./node-backend";
import type { SessionManager } from "./session-manager";

export interface NodeHistoryPage {
	messages: AgentMessage[];
	entryIds: string[];
	nextCursor?: string;
	totalMessages: number;
	headId: string | null;
	generation: number;
}

interface NodeHistoryCursor {
	v: 1;
	nodeId: string;
	generation: number;
	headId: string | null;
	page: number;
	limit: number;
}

function decodeCursor(cursor: string): NodeHistoryCursor {
	if (cursor.length === 0 || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
		throw new Error("Invalid node history cursor");
	const value: unknown = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(cursor, "base64url")),
	);
	if (
		!isRecord(value) ||
		value.v !== 1 ||
		typeof value.nodeId !== "string" ||
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 0 ||
		!(value.headId === null || typeof value.headId === "string") ||
		typeof value.page !== "number" ||
		!Number.isSafeInteger(value.page) ||
		value.page < 0 ||
		value.page > 1_000_000 ||
		typeof value.limit !== "number" ||
		!Number.isSafeInteger(value.limit) ||
		value.limit < 1 ||
		value.limit > TRANSCRIPT_WINDOW_MESSAGES
	)
		throw new Error("Invalid node history cursor");
	return {
		v: 1,
		nodeId: value.nodeId,
		generation: value.generation,
		headId: value.headId,
		page: value.page,
		limit: value.limit,
	};
}

/** Semantic groups, fixed historical head, bounded hydration; append-only progress does not reset a page. */
export function pageNodeHistory(
	manager: SessionManager,
	target: NodeTarget,
	options: { cursor?: string; limit?: number },
): NodeHistoryPage {
	const cursor: NodeHistoryCursor = options.cursor
		? decodeCursor(options.cursor)
		: {
				v: 1,
				nodeId: target.nodeId,
				generation: target.generation,
				headId: manager.getLeafId(),
				page: 0,
				limit: options.limit ?? 64,
			};
	if (
		cursor.nodeId !== target.nodeId ||
		cursor.generation !== target.generation ||
		(cursor.headId !== null && !manager.getEntryMetadata(cursor.headId))
	)
		throw new RpcMessagesPageError(RPC_MESSAGES_PAGE_STALE_ERROR, "stale_cursor");
	if (
		!Number.isSafeInteger(cursor.limit) ||
		cursor.limit < 1 ||
		cursor.limit > TRANSCRIPT_WINDOW_MESSAGES ||
		(options.limit !== undefined && options.limit !== cursor.limit)
	)
		throw new Error(`History page size must be fixed between 1 and ${TRANSCRIPT_WINDOW_MESSAGES}`);
	const context = manager.buildSessionContextAt(cursor.headId, {
		transcript: true,
		includeEntryIds: true,
		window: { pageFromLatest: cursor.page, maxMessages: cursor.limit, maxBytes: TRANSCRIPT_PAGE_MAX_BYTES },
	});
	const window = context.window!;
	return {
		messages: context.messages,
		entryIds: context.entryIds ?? [],
		totalMessages: window.totalMessages,
		headId: cursor.headId,
		generation: cursor.generation,
		...(window.start > 0
			? {
					nextCursor: Buffer.from(JSON.stringify({ ...cursor, page: cursor.page + 1 }), "utf8").toString(
						"base64url",
					),
				}
			: {}),
	};
}
