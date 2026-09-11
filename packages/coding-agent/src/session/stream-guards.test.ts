import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { type SettingPath, Settings } from "../config/settings";
import type { StreamedKernelFailure } from "../eval/speculation";
import type { ToolSession } from "../tools";
import { BashTool } from "../tools/bash";
import { SessionManager } from "./session-manager";
import { LoopGuards, type StreamGuardsHost } from "./stream-guards";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, resolve };
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	model: Model,
	timestamp: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason,
		timestamp,
	};
}

function toolCall(id: string, rawPartialJson: string, command = ""): ToolCall {
	const call: ToolCall = {
		type: "toolCall",
		id,
		name: "bash",
		arguments: command ? { command } : {},
	};
	setStreamingPartialJson(call, rawPartialJson);
	return call;
}

function textResponse(stream: AssistantMessageEventStream, model: Model, text: string): void {
	const timestamp = Date.now();
	const empty = assistantMessage(model, timestamp, [], "stop");
	stream.push({ type: "start", partial: empty });
	stream.push({
		type: "text_start",
		contentIndex: 0,
		partial: assistantMessage(model, timestamp, [{ type: "text", text: "" }], "stop"),
	});
	stream.push({
		type: "text_delta",
		contentIndex: 0,
		delta: text,
		partial: assistantMessage(model, timestamp, [{ type: "text", text }], "stop"),
	});
	const final = assistantMessage(model, timestamp, [{ type: "text", text }], "stop");
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
	stream.push({ type: "done", reason: "stop", message: final });
}

function waitForAbort(signal: AbortSignal | undefined): Promise<boolean> {
	if (!signal) return Promise.resolve(false);
	if (signal.aborted) return Promise.resolve(true);
	return new Promise(resolve => signal.addEventListener("abort", () => resolve(true), { once: true }));
}

interface StreamObserverTool extends AgentTool {
	observeStreamedInput(toolCallId: string, rawPartialJson: string): Promise<StreamedKernelFailure | undefined>;
	flushStreamedInput?(toolCallId: string, rawPartialJson?: string): Promise<void>;
	cancelStreamedInput(toolCallId?: string): void;
}

interface Harness {
	agent: Agent;
	guards: LoopGuards;
	sessionManager: SessionManager;
	notices: Array<{ level: "info" | "warning" | "error"; message: string; source?: string }>;
	scheduledTasks: Promise<void>[];
	markDisposed(): void;
	dispose(): Promise<void>;
}

function makeBashTool(
	execute: (toolCallId: string, args: Record<string, unknown>) => Promise<void> | void,
	observe: (toolCallId: string, rawPartialJson: string) => Promise<StreamedKernelFailure | undefined>,
	flush?: (toolCallId: string, rawPartialJson?: string) => Promise<void>,
): StreamObserverTool {
	return {
		name: "bash",
		label: "Bash",
		description: "test bash",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
			additionalProperties: false,
		},
		execute: async (toolCallId: string, args: unknown) => {
			await execute(toolCallId, args as Record<string, unknown>);
			return { content: [{ type: "text", text: "executed" }] };
		},
		observeStreamedInput: observe,
		flushStreamedInput: flush,
		cancelStreamedInput: () => {},
	} as unknown as StreamObserverTool;
}

function makeHarness(
	streamFn: StreamFn,
	bash: StreamObserverTool,
	overrides: Partial<Record<SettingPath, unknown>> = { "kernel.assertPreflight.enabled": true },
): Harness {
	const settings = Settings.isolated(overrides);
	const sessionManager = SessionManager.inMemory(process.cwd());
	const notices: Harness["notices"] = [];
	const scheduledTasks: Promise<void>[] = [];
	let disposed = false;
	const agent = new Agent({ streamFn });
	agent.setTools([bash]);
	const host: StreamGuardsHost = {
		agent,
		settings,
		sessionManager,
		model: () => undefined,
		getToolByName: name => (name === "bash" ? bash : undefined),
		canObserveStreamedKernelInput: () => !disposed,
		isDisposed: () => disposed,
		promptGeneration: () => 0,
		emitNotice: (level, message, source) => notices.push({ level, message, source }),
		schedulePostPromptTask: task => scheduledTasks.push(task(new AbortController().signal)),
		discardAssistantTurn: message => {
			const index = agent.state.messages.findLastIndex(
				candidate => candidate.role === "assistant" && candidate.timestamp === message.timestamp,
			);
			if (index >= 0) agent.state.messages.splice(index, 1);
		},
	};
	const guards = new LoopGuards(host);
	agent.setAssistantMessageEventInterceptor((message, event) => guards.onAssistantEvent(message, event));
	const unsubscribe = agent.subscribe(event => {
		if (event.type === "message_end" && event.message.role === "assistant")
			guards.onAssistantMessageEnd(event.message);
		if (event.type === "turn_end" || event.type === "agent_end") guards.cancelStreamedInput();
	});
	return {
		agent,
		guards,
		sessionManager,
		notices,
		scheduledTasks,
		markDisposed(): void {
			disposed = true;
		},
		async dispose(): Promise<void> {
			disposed = true;
			guards.cancelStreamedInput();
			if (agent.state.isStreaming) agent.abort("test cleanup");
			await agent.waitForIdle();
			await Promise.allSettled(scheduledTasks);
			unsubscribe();
		},
	};
}

function pushSingleToolPrefix(
	stream: AssistantMessageEventStream,
	model: Model,
	timestamp: number,
	toolCallId: string,
	rawPartialJson: string,
): void {
	stream.push({ type: "start", partial: assistantMessage(model, timestamp, [], "toolUse") });
	stream.push({
		type: "toolcall_start",
		contentIndex: 0,
		partial: assistantMessage(model, timestamp, [toolCall(toolCallId, "")], "toolUse"),
	});
	const partial = toolCall(toolCallId, rawPartialJson);
	stream.push({
		type: "toolcall_delta",
		contentIndex: 0,
		delta: rawPartialJson,
		partial: assistantMessage(model, timestamp, [partial], "toolUse"),
	});
}

describe("streamed kernel loop guard", () => {
	test("aborts before a huge streamed suffix, executes no partial call, and resumes with the assertion diagnostic", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-stream-guards-"));
		const anchorPath = path.join(cwd, "anchor.txt");
		const mutationPath = path.join(cwd, "must-not-be-written.txt");
		fs.writeFileSync(anchorPath, "old\nold\n", "utf8");
		const settings = Settings.isolated({ "kernel.assertPreflight.enabled": true });
		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const bash = new BashTool(toolSession) as unknown as StreamObserverTool;
		const toolCallId = "streamed-assertion";
		const suffixMarker = "literal-that-must-not-be-streamed-";
		const trailingLiteral = [
			"payload = '''",
			...Array.from({ length: 60 }, (_, index) => `${suffixMarker}${index}-${"x".repeat(2_000)}`),
		].join("\n");
		const commandPrefix = `${[
			"python - <<'PY'",
			"from pathlib import Path",
			'text = Path("anchor.txt").read_text()',
			'assert text.count("old") == 1',
			trailingLiteral,
		].join("\n")}\n`;
		const prefix = `{"command":${JSON.stringify(commandPrefix).slice(0, -1)}`;
		const abortObserved = deferred<void>();
		let suffixEmitted = false;
		let streamCalls = 0;
		let firstTimestamp: number | undefined;
		const streamFn: StreamFn = (model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			if (streamCalls++ > 0) {
				textResponse(stream, model, "resumed after assertion diagnostic");
				return stream;
			}
			const timestamp = Date.now();
			firstTimestamp = timestamp;
			void (async () => {
				pushSingleToolPrefix(stream, model, timestamp, toolCallId, prefix);
				const signal = options?.signal;
				if (!signal) {
					stream.fail(new Error("test stream did not receive an abort signal"));
					return;
				}
				await waitForAbort(signal);
				abortObserved.resolve();
				if (signal.aborted) return;
				suffixEmitted = true;
				const suffixSource = `'''\nPath(${JSON.stringify(mutationPath)}).write_text(${JSON.stringify(suffixMarker + "x".repeat(100_000))})\nPY\n`;
				const completeCommand = commandPrefix + suffixSource;
				const complete = toolCall(toolCallId, `{"command":${JSON.stringify(completeCommand)}}`, completeCommand);
				stream.push({
					type: "toolcall_delta",
					contentIndex: 0,
					delta: suffixSource,
					partial: assistantMessage(model, timestamp, [complete], "toolUse"),
				});
				stream.push({
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: complete,
					partial: assistantMessage(model, timestamp, [complete], "toolUse"),
				});
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(model, timestamp, [complete], "toolUse"),
				});
			})();
			return stream;
		};
		const harness = makeHarness(streamFn, bash, { "kernel.assertPreflight.enabled": true });
		try {
			const prompt = harness.agent.prompt("run the kernel assertion");
			await prompt;
			await abortObserved.promise;
			await Promise.all(harness.scheduledTasks);

			expect(suffixEmitted).toBe(false);
			expect(fs.existsSync(mutationPath)).toBe(false);
			expect(fs.readFileSync(anchorPath, "utf8")).toBe("old\nold\n");
			expect(harness.notices).toEqual([
				{
					level: "warning",
					message: "Stopped generation early: a streamed kernel assertion failed.",
					source: "kernel-preflight",
				},
			]);
			expect(
				harness.agent.state.messages.some(
					message => message.role === "assistant" && message.timestamp === firstTimestamp,
				),
			).toBe(false);
			expect(
				harness.agent.state.messages.some(
					message =>
						message.role === "custom" &&
						message.customType === "kernel-assert-preflight" &&
						typeof message.content === "string" &&
						message.content.includes("count=2"),
				),
			).toBe(true);
			expect(
				harness.agent.state.messages.some(
					message =>
						message.role === "assistant" &&
						message.content.some(
							block => block.type === "text" && block.text === "resumed after assertion diagnostic",
						),
				),
			).toBe(true);
		} finally {
			bash.cancelStreamedInput();
			await harness.dispose();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
	test("observes streamed input by default without delaying normal execution", async () => {
		const observed: string[] = [];
		const executed: string[] = [];
		let streamCalls = 0;
		const bash = makeBashTool(
			(id, args) => {
				executed.push(`${id}:${String(args.command)}`);
			},
			async (_id, raw) => {
				observed.push(raw);
				return undefined;
			},
		);
		const streamFn: StreamFn = (model, _context, _options) => {
			const stream = createAssistantMessageEventStream();
			if (streamCalls++ > 0) {
				textResponse(stream, model, "completed normally");
				return stream;
			}
			const timestamp = Date.now();
			const id = "default-settings-call";
			const raw = '{"command":"printf normal"}';
			const complete = toolCall(id, raw, "printf normal");
			stream.push({ type: "start", partial: assistantMessage(model, timestamp, [], "toolUse") });
			stream.push({
				type: "toolcall_start",
				contentIndex: 0,
				partial: assistantMessage(model, timestamp, [toolCall(id, "")], "toolUse"),
			});
			stream.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: raw,
				partial: assistantMessage(model, timestamp, [complete], "toolUse"),
			});
			stream.push({
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: complete,
				partial: assistantMessage(model, timestamp, [complete], "toolUse"),
			});
			stream.push({
				type: "done",
				reason: "toolUse",
				message: assistantMessage(model, timestamp, [complete], "toolUse"),
			});
			return stream;
		};
		const harness = makeHarness(streamFn, bash, {});
		try {
			await harness.agent.prompt("normal command");
			expect(observed).toContain('{"command":"printf normal"}');
			expect(executed).toEqual(["default-settings-call:printf normal"]);
			expect(harness.notices).toEqual([]);
			expect(
				harness.agent.state.messages.some(
					message => message.role === "custom" && message.customType === "kernel-assert-preflight",
				),
			).toBe(false);
		} finally {
			await harness.dispose();
		}
	});

	test("flushes the final streamed prefix at toolcall_end", async () => {
		const toolCallId = "final-prefix-flush";
		const raw = '{"command":"printf final"}';
		const flushed: string[] = [];
		const executed: string[] = [];
		let streamCalls = 0;
		const bash = makeBashTool(
			(id, args) => {
				executed.push(`${id}:${String(args.command)}`);
			},
			async () => undefined,
			async (id, observedRaw) => {
				flushed.push(`${id}:${observedRaw}`);
			},
		);
		const streamFn: StreamFn = (model, _context, _options) => {
			const stream = createAssistantMessageEventStream();
			if (streamCalls++ > 0) {
				textResponse(stream, model, "final prefix flushed");
				return stream;
			}
			const timestamp = Date.now();
			const complete = toolCall(toolCallId, raw, "printf final");
			stream.push({ type: "start", partial: assistantMessage(model, timestamp, [], "toolUse") });
			stream.push({
				type: "toolcall_start",
				contentIndex: 0,
				partial: assistantMessage(model, timestamp, [toolCall(toolCallId, "")], "toolUse"),
			});
			stream.push({
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: complete,
				partial: assistantMessage(model, timestamp, [complete], "toolUse"),
			});
			stream.push({
				type: "done",
				reason: "toolUse",
				message: assistantMessage(model, timestamp, [complete], "toolUse"),
			});
			return stream;
		};
		const harness = makeHarness(streamFn, bash);
		try {
			await harness.agent.prompt("flush final prefix");
			expect(flushed).toEqual([`${toolCallId}:${raw}`]);
			expect(executed).toEqual([`${toolCallId}:printf final`]);
		} finally {
			await harness.dispose();
		}
	});

	test("ignores an assertion failure once a preceding sibling bash call is present", async () => {
		const firstId = "sibling-before-assertion";
		const secondId = "assertion-after-sibling";
		const prefix = '{"command":"python - <<\'PY\'\\nassert False\\n';
		const suffix = "-suffix";
		const prefixSeen = deferred<string>();
		const failure = deferred<StreamedKernelFailure>();
		const releaseSuffix = deferred<void>();
		const executed: string[] = [];
		let armed = false;
		let streamCalls = 0;
		let currentSignalAborted = false;
		const bash = makeBashTool(
			(id, args) => {
				executed.push(`${id}:${String(args.command)}`);
			},
			async (id, raw) => {
				if (id === secondId && !armed && raw.includes("assert False")) {
					armed = true;
					prefixSeen.resolve(raw);
					return failure.promise;
				}
				return undefined;
			},
		);
		const streamFn: StreamFn = (model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			if (streamCalls++ > 0) {
				textResponse(stream, model, "sibling calls completed");
				return stream;
			}
			const timestamp = Date.now();
			void (async () => {
				const first = toolCall(firstId, '{"command":"prepare file"}', "prepare file");
				const secondPrefix = toolCall(secondId, prefix);
				stream.push({ type: "start", partial: assistantMessage(model, timestamp, [], "toolUse") });
				stream.push({
					type: "toolcall_start",
					contentIndex: 0,
					partial: assistantMessage(model, timestamp, [toolCall(firstId, "")], "toolUse"),
				});
				stream.push({
					type: "toolcall_delta",
					contentIndex: 0,
					delta: '{"command":"prepare file"}',
					partial: assistantMessage(model, timestamp, [first], "toolUse"),
				});
				stream.push({
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: first,
					partial: assistantMessage(model, timestamp, [first], "toolUse"),
				});
				stream.push({
					type: "toolcall_start",
					contentIndex: 1,
					partial: assistantMessage(model, timestamp, [first, toolCall(secondId, "")], "toolUse"),
				});
				stream.push({
					type: "toolcall_delta",
					contentIndex: 1,
					delta: prefix,
					partial: assistantMessage(model, timestamp, [first, secondPrefix], "toolUse"),
				});
				await releaseSuffix.promise;
				currentSignalAborted = options?.signal?.aborted === true;
				if (currentSignalAborted) return;
				const second = toolCall(secondId, prefix + suffix, "assertion command");
				stream.push({
					type: "toolcall_delta",
					contentIndex: 1,
					delta: suffix,
					partial: assistantMessage(model, timestamp, [first, second], "toolUse"),
				});
				stream.push({
					type: "toolcall_end",
					contentIndex: 1,
					toolCall: second,
					partial: assistantMessage(model, timestamp, [first, second], "toolUse"),
				});
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(model, timestamp, [first, second], "toolUse"),
				});
			})();
			return stream;
		};
		const harness = makeHarness(streamFn, bash);
		try {
			const prompt = harness.agent.prompt("prepare before asserting");
			expect(await prefixSeen.promise).toContain("assert False");
			failure.resolve({ toolCallId: secondId, message: "AssertionError: stale before sibling completion" });
			await Promise.resolve();
			await Promise.resolve();
			releaseSuffix.resolve();
			await prompt;
			expect(currentSignalAborted).toBe(false);
			expect(executed).toEqual([
				"sibling-before-assertion:prepare file",
				"assertion-after-sibling:assertion command",
			]);
			expect(harness.notices).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	test("ignores a late failure after toolcall_end while the tool turn is still running", async () => {
		const toolCallId = "completed-before-late-failure";
		const raw = '{"command":"assert False"}';
		const prefixSeen = deferred<string>();
		const failure = deferred<StreamedKernelFailure>();
		const releaseExecution = deferred<void>();
		const executionStarted = deferred<void>();
		const executed: string[] = [];
		let streamCalls = 0;
		const bash = makeBashTool(
			async (id, args) => {
				executionStarted.resolve();
				await releaseExecution.promise;
				executed.push(`${id}:${String(args.command)}`);
			},
			async (id, observedRaw) => {
				if (id === toolCallId && observedRaw === raw) {
					prefixSeen.resolve(observedRaw);
					return failure.promise;
				}
				return undefined;
			},
		);
		const streamFn: StreamFn = (model, _context, _options) => {
			const stream = createAssistantMessageEventStream();
			if (streamCalls++ > 0) {
				textResponse(stream, model, "late failure was ignored");
				return stream;
			}
			const timestamp = Date.now();
			const complete = toolCall(toolCallId, raw, "assert False");
			stream.push({ type: "start", partial: assistantMessage(model, timestamp, [], "toolUse") });
			stream.push({
				type: "toolcall_start",
				contentIndex: 0,
				partial: assistantMessage(model, timestamp, [toolCall(toolCallId, "")], "toolUse"),
			});
			stream.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: raw,
				partial: assistantMessage(model, timestamp, [complete], "toolUse"),
			});
			stream.push({
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: complete,
				partial: assistantMessage(model, timestamp, [complete], "toolUse"),
			});
			stream.push({
				type: "done",
				reason: "toolUse",
				message: assistantMessage(model, timestamp, [complete], "toolUse"),
			});
			return stream;
		};
		const harness = makeHarness(streamFn, bash);
		try {
			const prompt = harness.agent.prompt("run complete call");
			expect(await prefixSeen.promise).toBe(raw);
			await executionStarted.promise;
			failure.resolve({ toolCallId, message: "AssertionError arrived too late" });
			releaseExecution.resolve();
			await prompt;
			expect(executed).toEqual(["completed-before-late-failure:assert False"]);
			expect(harness.notices).toEqual([]);
			expect(
				harness.agent.state.messages.some(
					message =>
						message.role === "assistant" &&
						message.content.some(block => block.type === "text" && block.text === "late failure was ignored"),
				),
			).toBe(true);
		} finally {
			releaseExecution.resolve();
			await harness.dispose();
		}
	});

	for (const scenario of ["new assistant prompt", "turn cancellation", "disposal"] as const) {
		test(`ignores a late failure after ${scenario}`, async () => {
			const toolCallId = `stale-${scenario.replaceAll(" ", "-")}`;
			const raw = '{"command":"assert False"}';
			const prefixSeen = deferred<string>();
			const failure = deferred<StreamedKernelFailure>();
			const release = deferred<void>();
			let streamCalls = 0;
			let signalAborted = false;
			const bash = makeBashTool(
				() => {},
				async (id, observedRaw) => {
					if (id === toolCallId && observedRaw === raw) {
						prefixSeen.resolve(observedRaw);
						return failure.promise;
					}
					return undefined;
				},
			);
			const streamFn: StreamFn = (model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				if (streamCalls++ > 0) {
					textResponse(stream, model, "current stream remained active");
					return stream;
				}
				const timestamp = Date.now();
				void (async () => {
					pushSingleToolPrefix(stream, model, timestamp, toolCallId, raw);
					const raced = await Promise.race([release.promise.then(() => false), waitForAbort(options?.signal)]);
					signalAborted = raced;
					if (raced) return;
					const complete = toolCall(toolCallId, raw, "assert False");
					stream.push({
						type: "toolcall_end",
						contentIndex: 0,
						toolCall: complete,
						partial: assistantMessage(model, timestamp, [complete], "toolUse"),
					});
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(model, timestamp, [complete], "toolUse"),
					});
				})();
				return stream;
			};
			const harness = makeHarness(streamFn, bash);
			try {
				const prompt = harness.agent.prompt("start stale stream");
				expect(await prefixSeen.promise).toBe(raw);
				if (scenario === "new assistant prompt") {
					const newerTimestamp = Date.now() + 1;
					const newerCall = toolCall("newer-call", "");
					const newerMessage = assistantMessage(harness.agent.state.model, newerTimestamp, [newerCall], "toolUse");
					harness.guards.onAssistantEvent(newerMessage, {
						type: "toolcall_start",
						contentIndex: 0,
						partial: newerMessage,
					});
				} else if (scenario === "turn cancellation") {
					harness.guards.cancelStreamedInput();
				} else {
					harness.markDisposed();
				}
				failure.resolve({ toolCallId, message: "AssertionError from stale stream" });
				await Promise.resolve();
				await Promise.resolve();
				expect(signalAborted).toBe(false);
				expect(harness.notices).toEqual([]);
				release.resolve();
				await prompt;
			} finally {
				await harness.dispose();
			}
		});
	}
});
