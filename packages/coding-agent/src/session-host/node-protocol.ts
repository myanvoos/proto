import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { TRANSCRIPT_WINDOW_MESSAGES } from "../modes/utils/transcript-window";
import type { NodeOperation, NodeReply, NodeSnapshot, NodeTarget } from "../session/node-backend";

/** Version 3 removes implicit-root commands from the interactive host wire contract. */
export const NODE_PROTOCOL_VERSION = 3;
export const MAX_NODE_REQUESTS = 64;
export const MAX_NODE_SUBSCRIPTIONS = 32;

export type NodeRequest =
	| { id: string; type: "negotiate_protocol"; protocolVersion: number }
	| { id: string; type: "node_snapshot"; nodeId: string }
	| { id: string; type: "node_operation"; target: NodeTarget; operation: NodeOperation; controllerLease: string }
	| { id: string; type: "node_subscribe"; nodeIds: string[]; controllerLease: string };

export type NodeResponse =
	| {
			id: string;
			type: "response";
			command: "negotiate_protocol";
			success: true;
			data: { protocolVersion: 3; controllerLease: string; attachmentPolicy: "latest-wins"; root: NodeSnapshot };
	  }
	| { id: string; type: "response"; command: "node_snapshot"; success: true; data: NodeSnapshot }
	| { id: string; type: "response"; command: "node_operation"; success: true; data: NodeReply }
	| { id: string; type: "response"; command: "node_subscribe"; success: true; data: { nodeIds: string[] } }
	| { id: string; type: "response"; command: string; success: false; error: string; code: string };

export interface NodeChangedFrame {
	type: "node_changed";
	nodeId: string;
	generation: number;
}

export function isNodeTarget(value: unknown): value is NodeTarget {
	return (
		isRecord(value) &&
		typeof value.nodeId === "string" &&
		value.nodeId.length > 0 &&
		value.nodeId.length <= 256 &&
		Number.isSafeInteger(value.generation) &&
		typeof value.generation === "number" &&
		value.generation >= 0 &&
		typeof value.revision === "string" &&
		value.revision.length <= 1024
	);
}

const THINKING_LEVELS = new Set<string>(Object.values(ThinkingLevel));

export function isNodeOperation(value: unknown): value is NodeOperation {
	if (!isRecord(value)) return false;
	const string = (key: string) => typeof value[key] === "string";
	const optionalString = (key: string) => value[key] === undefined || string(key);
	const optionalBoolean = (key: string) => value[key] === undefined || typeof value[key] === "boolean";
	const thinking = (key: string) => typeof value[key] === "string" && THINKING_LEVELS.has(value[key]);
	switch (value.type) {
		case "context":
		case "jobs":
		case "fork":
		case "abort":
		case "abort_compaction":
		case "abort_retry":
			return true;
		case "tree":
			return (
				(value.offset === undefined ||
					(typeof value.offset === "number" && Number.isSafeInteger(value.offset) && value.offset >= 0)) &&
				(value.limit === undefined ||
					(typeof value.limit === "number" &&
						Number.isSafeInteger(value.limit) &&
						value.limit >= 1 &&
						value.limit <= 256))
			);
		case "history":
			return (
				optionalString("cursor") &&
				(value.limit === undefined ||
					(typeof value.limit === "number" &&
						Number.isSafeInteger(value.limit) &&
						value.limit >= 1 &&
						value.limit <= TRANSCRIPT_WINDOW_MESSAGES))
			);
		case "prompt":
			return (
				string("message") &&
				(value.images === undefined ||
					(Array.isArray(value.images) &&
						value.images.every(
							image =>
								isRecord(image) &&
								image.type === "image" &&
								typeof image.data === "string" &&
								typeof image.mimeType === "string",
						))) &&
				(value.streamingBehavior === undefined ||
					value.streamingBehavior === "steer" ||
					value.streamingBehavior === "followUp")
			);
		case "compact":
			return optionalString("instructions");
		case "model":
			return (
				string("provider") && string("modelId") && (value.thinkingLevel === undefined || thinking("thinkingLevel"))
			);
		case "thinking":
			return thinking("level");
		case "rename":
			return typeof value.name === "string" && value.name.trim().length > 0;
		case "label":
			return string("entryId") && optionalString("label");
		case "navigate":
			return string("entryId") && optionalBoolean("summarize") && optionalString("instructions");
		case "branch":
			return string("entryId");
		case "cancel_job":
			return string("jobId");
		case "extension":
			return string("name") && typeof value.name === "string" && /^[^\s/]+$/.test(value.name) && string("args");
		default:
			return false;
	}
}

export function isNodeRequest(value: unknown): value is NodeRequest {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 256) return false;
	switch (value.type) {
		case "negotiate_protocol":
			return typeof value.protocolVersion === "number" && Number.isSafeInteger(value.protocolVersion);
		case "node_snapshot":
			return typeof value.nodeId === "string" && value.nodeId.length > 0 && value.nodeId.length <= 256;
		case "node_operation":
			return (
				isNodeTarget(value.target) && isNodeOperation(value.operation) && typeof value.controllerLease === "string"
			);
		case "node_subscribe":
			return (
				Array.isArray(value.nodeIds) &&
				value.nodeIds.length <= MAX_NODE_SUBSCRIPTIONS &&
				value.nodeIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 256) &&
				typeof value.controllerLease === "string"
			);
		default:
			return false;
	}
}
