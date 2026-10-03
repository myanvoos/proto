import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type * as http2 from "node:http2";
import * as os from "node:os";
import * as path from "node:path";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	ExecServerMessageSchema,
	type InteractionUpdate,
	McpArgsSchema,
	ReadArgsSchema,
	type ReadResult,
	ShellArgsSchema,
	type ShellResult,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, encodeJsonValue, fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { AssistantMessage, CursorExecHandlers, ToolResultMessage } from "../types";
import { kCursorExecResolved } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type BlockState,
	handleServerMessage,
	processInteractionUpdate,
	type ToolCallState,
	type UsageState,
} from "./cursor";

// Live `turn_ended` frame: input 12336, output 36, cache read/write 0, reasoning 31; its tokenDelta frames summed to 22.
const CAPTURED_TURN_ENDED = Buffer.from("0a0d720b08b060102418002000281f", "hex");

interface Harness {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	state: BlockState;
	usageState: UsageState;
}

function createHarness(): Harness {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	const state: BlockState = {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		openToolCalls: new Map(),
		resolvedMcpToolCallIds: new Set(),
		firstTokenTime: undefined,
		setTextBlock: block => {
			textBlock = block;
		},
		setThinkingBlock: block => {
			thinkingBlock = block;
		},
		setToolCall: block => {
			toolCall = block;
		},
		setFirstTokenTime: () => {},
	};
	return { output, stream: new AssistantMessageEventStream(), state, usageState: { sawTokenDelta: false } };
}

function apply(harness: Harness, update: InteractionUpdate | { message: { case: string; value: unknown } }): void {
	processInteractionUpdate(update, harness.output, harness.stream, harness.state, harness.usageState);
}

function capturedTurnEndedUpdate(): InteractionUpdate {
	const msg = fromBinary(AgentServerMessageSchema, CAPTURED_TURN_ENDED);
	if (msg.message.case !== "interactionUpdate") throw new Error("expected an interaction update");
	return msg.message.value;
}

describe("Cursor turn usage", () => {
	it("adopts the final per-turn counters over the streamed tokenDelta estimate", () => {
		const harness = createHarness();
		apply(harness, { message: { case: "tokenDelta", value: { tokens: 22 } } });
		apply(harness, capturedTurnEndedUpdate());

		expect(harness.output.usage).toMatchObject({
			input: 12336,
			output: 36,
			cacheRead: 0,
			cacheWrite: 0,
			reasoningTokens: 31,
			totalTokens: 12372,
		});
	});

	it("excludes cache hits and writes from fresh input", () => {
		const harness = createHarness();
		apply(harness, {
			message: {
				case: "turnEnded",
				value: {
					inputTokens: 100n,
					outputTokens: 7n,
					cacheReadTokens: 60n,
					cacheWriteTokens: 15n,
					reasoningTokens: 2n,
				},
			},
		});

		expect(harness.output.usage).toMatchObject({
			input: 25,
			output: 7,
			cacheRead: 60,
			cacheWrite: 15,
			reasoningTokens: 2,
			totalTokens: 107,
		});
	});

	it("keeps the streamed output when the final frame reports no counters", () => {
		const harness = createHarness();
		apply(harness, { message: { case: "tokenDelta", value: { tokens: 22 } } });
		apply(harness, { message: { case: "turnEnded", value: {} } });

		expect(harness.output.usage).toMatchObject({ input: 0, output: 22, totalTokens: 22 });
		expect(harness.output.usage.reasoningTokens).toBeUndefined();
	});

	it("records checkpoint context occupancy after the turn started streaming output", async () => {
		const harness = createHarness();
		apply(harness, { message: { case: "tokenDelta", value: { tokens: 24_000 } } });
		const h2Request = { write: () => true } as unknown as http2.ClientHttp2Stream;
		await handleServerMessage(
			create(AgentServerMessageSchema, {
				message: {
					case: "conversationCheckpointUpdate",
					value: create(ConversationStateStructureSchema, {
						tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 89_000 }),
					}),
				},
			}),
			harness.output,
			harness.stream,
			harness.state,
			new Map(),
			h2Request,
			undefined,
			undefined,
			harness.usageState,
			[],
		);

		expect(harness.output.usage.contextTokens).toBe(89_000);
		expect(harness.output.usage.output).toBe(24_000);
	});
});

describe("Cursor external tool handoff", () => {
	function mcpArgsFrame(toolCallId: string) {
		return create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: `exec-${toolCallId}`,
					message: {
						case: "mcpArgs",
						value: create(McpArgsSchema, {
							name: "get_weather",
							toolName: "get_weather",
							toolCallId,
							providerIdentifier: "pi-agent",
							args: { city: encodeJsonValue('"Paris"') },
						}),
					},
				}),
			},
		});
	}

	async function handOff(harness: Harness, toolCallId: string, written: unknown[], collected: ToolResultMessage[]) {
		const h2Request = {
			write: (chunk: unknown) => {
				written.push(chunk);
				return true;
			},
		} as unknown as http2.ClientHttp2Stream;
		await handleServerMessage(
			mcpArgsFrame(toolCallId),
			harness.output,
			harness.stream,
			harness.state,
			new Map(),
			h2Request,
			undefined,
			result => {
				collected.push(result);
				return result;
			},
			harness.usageState,
			[],
			[],
			undefined,
			true,
		);
	}

	it("emits an unresolved call for the external executor and still answers Cursor", async () => {
		const harness = createHarness();
		const written: unknown[] = [];
		const collected: ToolResultMessage[] = [];
		await handOff(harness, "call-handoff-1", written, collected);

		const blocks = harness.output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ id: "call-handoff-1", name: "get_weather", arguments: { city: "Paris" } });
		expect(blocks[0][kCursorExecResolved]).toBeUndefined();
		expect(collected).toHaveLength(0);
		expect(written).toHaveLength(1);
	});

	it("does not duplicate a handed-off call when its interaction frame follows", async () => {
		const harness = createHarness();
		await handOff(harness, "call-handoff-2", [], []);
		apply(harness, {
			message: {
				case: "toolCallStarted",
				value: {
					callId: "envelope-handoff-2",
					toolCall: {
						mcpToolCall: {
							args: { name: "get_weather", toolName: "get_weather", toolCallId: "call-handoff-2" },
						},
					},
				},
			},
		});

		const blocks = harness.output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		expect(blocks[0][kCursorExecResolved]).toBeUndefined();
	});
});

describe("Cursor shell exec display blocks", () => {
	it.each(["shellArgs", "shellStreamArgs", "miniSweAgentBashArgs"] as const)(
		"records a %s millisecond timeout in bash-tool seconds",
		async frameCase => {
			const harness = createHarness();
			const h2Request = { write: () => true } as unknown as http2.ClientHttp2Stream;
			await handleServerMessage(
				create(AgentServerMessageSchema, {
					message: {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							execId: `exec-${frameCase}`,
							message: {
								case: frameCase,
								value: create(ShellArgsSchema, {
									command: "sleep 1",
									workingDirectory: "/tmp",
									timeout: 15000,
									toolCallId: `call-${frameCase}`,
								}),
							},
						}),
					},
				}),
				harness.output,
				harness.stream,
				harness.state,
				new Map(),
				h2Request,
				undefined,
				undefined,
				harness.usageState,
				[],
			);

			const blocks = harness.output.content.filter((block): block is ToolCallState => block.type === "toolCall");
			expect(blocks).toHaveLength(1);
			expect(blocks[0]).toMatchObject({ id: `call-${frameCase}`, name: "bash" });
			expect(blocks[0].arguments.timeout).toBe(15);
		},
	);
});

describe("Cursor native exec results from local tools", () => {
	function toolResult(text: string, isError: boolean, details?: unknown): ToolResultMessage {
		return {
			role: "toolResult",
			toolCallId: "call",
			toolName: "tool",
			content: [{ type: "text", text }],
			details,
			isError,
			timestamp: 1,
		};
	}

	async function dispatch(
		harness: Harness,
		message: { case: "readArgs" | "shellArgs"; value: unknown },
		execHandlers: CursorExecHandlers,
	) {
		const written: Buffer[] = [];
		const h2Request = {
			write: (chunk: Buffer) => {
				written.push(chunk);
				return true;
			},
		} as unknown as http2.ClientHttp2Stream;
		await handleServerMessage(
			create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, { id: 1, execId: "exec", message } as never),
				},
			}),
			harness.output,
			harness.stream,
			harness.state,
			new Map(),
			h2Request,
			execHandlers,
			undefined,
			harness.usageState,
			[],
		);
		const frame = written[0];
		if (!frame) throw new Error("expected an exec response");
		const answer = fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + frame.readUInt32BE(1)));
		if (answer.message.case !== "execClientMessage") throw new Error("expected an exec client message");
		return answer.message.value.message;
	}

	it("answers a missing path with fileNotFound", async () => {
		const answer = await dispatch(
			createHarness(),
			{ case: "readArgs", value: create(ReadArgsSchema, { path: "missing.ts", toolCallId: "read-missing" }) },
			{ read: async () => toolResult("Path 'missing.ts' not found", true) },
		);
		expect(answer.case).toBe("readResult");
		expect((answer.value as ReadResult).result.case).toBe("fileNotFound");
	});

	it("reports the shell's real exit code on failure", async () => {
		const answer = await dispatch(
			createHarness(),
			{ case: "shellArgs", value: create(ShellArgsSchema, { command: "exit 3", toolCallId: "shell-exit" }) },
			{ shell: async () => toolResult("Command exited with code 3", true, { exitCode: 3 }) },
		);
		const result = (answer.value as ShellResult).result;
		if (result.case !== "failure") throw new Error("expected shell failure");
		expect(result.value.exitCode).toBe(3);
	});

	it("provides the whole file to StrReplace when the local raw read was truncated", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-edit-full-"));
		try {
			const target = path.join(dir, "big.txt");
			const fullText = `${Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
			await Bun.write(target, fullText);
			const harness = createHarness();
			harness.state.editOwnedToolCallIds = new Set(["edit-1"]);
			const readPaths: string[] = [];
			const answer = await dispatch(
				harness,
				{ case: "readArgs", value: create(ReadArgsSchema, { path: target, toolCallId: "edit-1" }) },
				{
					read: async args => {
						readPaths.push(args.path);
						return toolResult(fullText.split("\n").slice(0, 300).join("\n"), false, {
							truncation: { truncated: true },
							meta: { source: { type: "path", value: target } },
						});
					},
				},
			);
			expect(readPaths).toEqual([`${target}:raw`]);
			const result = (answer.value as ReadResult).result;
			if (result.case !== "success" || result.value.output.case !== "content") throw new Error("expected content");
			expect(result.value.truncated).toBe(false);
			expect(result.value.output.value).toBe(fullText);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
