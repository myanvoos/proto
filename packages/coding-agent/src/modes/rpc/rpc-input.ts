import { isRecord, readLines } from "@oh-my-pi/pi-utils";

import { getSessionHostRpcInput } from "../../session-host/transport";

export function claimRpcInput(): ReadableStream<Uint8Array> {
	const sessionHostInput = getSessionHostRpcInput();
	if (sessionHostInput) return sessionHostInput;
	const reader = Bun.stdin.stream().getReader();
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			reader.releaseLock();
		} catch {}
	};
	return new ReadableStream({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					release();
					controller.close();
				} else {
					controller.enqueue(result.value);
				}
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		async cancel() {
			try {
				await reader.cancel();
			} finally {
				release();
			}
		},
	});
}

export async function readRpcInputFrames(
	input: ReadableStream<Uint8Array>,
	onFrame: (frame: unknown) => void,
	onParseError: (message: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	for await (const line of readLines(input)) {
		const text = decoder.decode(line).trim();
		if (!text) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			onParseError(`Failed to parse command: ${message}`);
			continue;
		}
		onFrame(parsed);
	}
}

/**
 * Field contract for every command in `RpcCommand`, mirroring the union in `rpc-types.ts`.
 * `?` marks an optional field; a field that is absent or of the wrong type is rejected with a
 * named error instead of crashing somewhere deep inside the handler.
 */
type RpcFieldKind = "string" | "number" | "boolean" | "array" | "object";
type RpcFieldSpec = RpcFieldKind | `${RpcFieldKind}?`;

const RPC_COMMAND_FIELDS: Readonly<Record<string, Readonly<Record<string, RpcFieldSpec>>>> = {
	negotiate_protocol: { protocolVersion: "number" },
	prompt: { message: "string", images: "array?", streamingBehavior: "string?" },
	steer: { message: "string", images: "array?" },
	follow_up: { message: "string", images: "array?" },
	abort_and_prompt: { message: "string", images: "array?" },
	new_session: { parentSession: "string?" },
	set_fast_mode: { enabled: "boolean" },
	set_checklist: { phases: "array" },
	set_host_tools: { tools: "array" },
	set_host_uri_schemes: { schemes: "array" },
	set_subagent_subscription: { level: "string" },
	get_subagent_messages: { subagentId: "string?", sessionFile: "string?", fromByte: "number?" },
	set_model: { provider: "string", modelId: "string" },
	set_thinking_level: { level: "string" },
	set_steering_mode: { mode: "string" },
	set_follow_up_mode: { mode: "string" },
	set_interrupt_mode: { mode: "string" },
	compact: { customInstructions: "string?" },
	set_auto_compaction: { enabled: "boolean" },
	set_auto_retry: { enabled: "boolean" },
	bash: { command: "string" },
	switch_session: { sessionPath: "string" },
	branch: { entryId: "string" },
	set_session_name: { name: "string" },
	get_messages_page: { cursor: "string?", limit: "number?" },
	login: { providerId: "string" },
};

function rpcValueKind(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function matchesRpcFieldKind(value: unknown, kind: RpcFieldKind): boolean {
	switch (kind) {
		case "array":
			return Array.isArray(value);
		case "object":
			return isRecord(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		default:
			return typeof value === kind;
	}
}

/** Returns a client-facing error message when `parsed` is not a usable command, else undefined. */
export function validateRpcCommand(parsed: unknown): string | undefined {
	if (!isRecord(parsed)) {
		return `Invalid RPC command: expected a JSON object, got ${rpcValueKind(parsed)}`;
	}
	const type = parsed.type;
	if (typeof type !== "string" || type.length === 0) {
		return 'Invalid RPC command: missing required field "type" (expected string)';
	}
	if (parsed.id !== undefined && typeof parsed.id !== "string") {
		return `Invalid "${type}" command: "id" must be a string, got ${rpcValueKind(parsed.id)}`;
	}
	// Unrecognised types are reported by the command dispatcher as `Unknown command: <type>`.
	const fields = RPC_COMMAND_FIELDS[type];
	if (!fields) return undefined;
	for (const [field, spec] of Object.entries(fields)) {
		const optional = spec.endsWith("?");
		const kind = (optional ? spec.slice(0, -1) : spec) as RpcFieldKind;
		const value = parsed[field];
		if (value === undefined || value === null) {
			if (optional) continue;
			return `Invalid "${type}" command: missing required field "${field}" (expected ${kind})`;
		}
		if (!matchesRpcFieldKind(value, kind)) {
			return `Invalid "${type}" command: "${field}" must be ${kind === "object" ? "an object" : kind === "array" ? "an array" : `a ${kind}`}, got ${rpcValueKind(value)}`;
		}
	}
	return undefined;
}
