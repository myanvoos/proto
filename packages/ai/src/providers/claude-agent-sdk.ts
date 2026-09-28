import {
	type Options,
	type Query,
	query,
	type SDKUserMessage,
	type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import { logger, parseStreamingJsonThrottled, TempDir } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type { AssistantMessage, ClaudeSdkContextPayload, Context, Model, ToolCall } from "../types";
import { isRecord, normalizeSystemPrompts } from "../utils";
import { clearStreamingPartialJson, kStreamingLastParseLen, kStreamingPartialJson } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { isFoundryEnabled } from "../utils/foundry";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import { getProxyForProvider } from "../utils/proxy";
import { toolWireSchema } from "../utils/schema";
import { notifyRawSseEvent } from "../utils/sse-debug";
import {
	type AnthropicMessageParam,
	type AnthropicOptions,
	applyAnthropicUsageExtras,
	convertAnthropicMessages,
	mapAnthropicStopReason,
	normalizeAnthropicBaseUrl,
	resolveAnthropicCustomHeadersForBaseUrl,
	resolveEagerToolInputStreamingSupport,
} from "./anthropic";
import continuePrompt from "./claude-agent-continue.md" with { type: "text" };
import { claudeAgentExecutable } from "./claude-agent-executable";

const TOOL_PREFIX = "mcp__proto__";

/** The SDK generates calls; Proto's agent loop alone executes them. No native SDK tools run. */
export function streamClaudeAgentSdk(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	void runClaudeAgentSdk(model, context, options, stream);
	return stream;
}

async function runClaudeAgentSdk(
	model: Model<"anthropic-messages">,
	context: Context,
	options: AnthropicOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const started = performance.now();
	const output: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const controller = new AbortController();
	const abort = (): void => controller.abort(options?.signal?.reason);
	options?.signal?.addEventListener("abort", abort, { once: true });
	let activeQuery: Query | undefined;
	let mcp: McpServer | undefined;
	let transcript: TempDir | undefined;
	try {
		options?.signal?.throwIfAborted();
		if (options?.client || options?.fetch) {
			throw new AIError.ConfigurationError(
				"The Anthropic provider uses Claude Agent SDK; injected Messages clients/fetch are not supported. Configure a base URL instead.",
			);
		}
		if (options?.toolChoice && options.toolChoice !== "auto" && options.toolChoice !== "none") {
			throw new AIError.ConfigurationError(
				"Claude Agent SDK does not support forced tool choice; use auto or none.",
			);
		}
		if (options?.anthropicCompaction || options?.anthropicCacheRefreshRequest) {
			throw new AIError.ConfigurationError(
				"Claude Agent SDK does not expose Messages API compaction or zero-token cache refresh. Use host context compaction.",
			);
		}
		// Use the shared cross-provider history/media normalization, without Messages-only controls.
		const historyModel: Model<"anthropic-messages"> = {
			...model,
			compat: {
				...model.compat,
				escapeBuiltinToolNames: false,
				supportsMidConversationSystem: false,
				supportsMidConversationToolChanges: false,
				supportsPerMessageEffort: false,
			},
		};
		// Middleware receives the SDK adapter request, never credentials or executable callbacks.
		const replayContext = new Map<AnthropicMessageParam, SessionStoreEntry[]>();
		let request = {
			model: options?.requestModelId ?? model.id,
			systemPrompt: normalizeSystemPrompts(context.systemPrompt),
			messages: convertAnthropicMessages(context.messages, historyModel, false, {
				onAssistantMessage: (source, converted) => {
					if (source.provider === model.provider && source.providerPayload?.type === "claudeSdkContext") {
						replayContext.set(converted, source.providerPayload.entries);
					}
				},
			}),
			tools: (options?.toolChoice === "none" ? [] : (context.tools ?? [])).map(tool => ({
				name: tool.name,
				description: tool.description,
				inputSchema: toolWireSchema(tool),
			})),
		};
		const convertedMessages = request.messages.slice();
		const replacement = await options?.onPayload?.(request, model);
		if (replacement !== undefined) request = replacement as typeof request;
		const { messages, tools } = request;
		// Middleware may replace the payload with a JSON clone. Keep replay data
		// only where the corresponding assistant message still has the same content.
		for (const [index, message] of messages.entries()) {
			const original = convertedMessages[index];
			const entries = original && replayContext.get(original);
			if (entries && message.role === "assistant" && Bun.deepEquals(message.content, original.content)) {
				replayContext.set(message, entries);
			}
		}
		for (const message of messages) {
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "tool_use") block.name = TOOL_PREFIX + block.name;
				}
			}
		}
		let last = messages.pop();
		if (last?.role !== "user")
			throw new AIError.ConfigurationError("Claude Agent SDK requires a user message or tool result to continue.");
		// Claude repairs dangling tool uses while loading a transcript, before reading stdin.
		// Seed the completed tool round atomically so those calls/results survive resume.
		const continuingTools = Array.isArray(last.content) && last.content.some(block => block.type === "tool_result");
		if (continuingTools) {
			messages.push(last);
			last = { role: "user", content: continuePrompt.trim() };
		}
		transcript = await TempDir.create("@proto-claude-");
		const previous = context.messages.findLast(
			(message): message is AssistantMessage =>
				message.role === "assistant" &&
				message.provider === model.provider &&
				message.providerPayload?.type === "claudeSdkContext",
		)?.providerPayload;
		const sessionId = previous?.type === "claudeSdkContext" ? previous.sessionId : crypto.randomUUID();
		const sdkContext: ClaudeSdkContextPayload = { type: "claudeSdkContext", sessionId, entries: [] };
		output.providerPayload = sdkContext;
		const promptId = crypto.randomUUID();
		const mirroredEntries: SessionStoreEntry[] = [];
		const cwd = options?.cwd ?? process.cwd();
		let resume: string | undefined;
		let seededEntries: SessionStoreEntry[] | null = null;
		const seededIds = new Set<string>();
		if (messages.length) {
			resume = sessionId;
			let parentUuid: string | null = null;
			const entries: SessionStoreEntry[] = messages.flatMap(message => {
				const injected: SessionStoreEntry[] = (replayContext.get(message) ?? []).map(entry => {
					const uuid = crypto.randomUUID();
					const replayed = { ...entry, uuid, parentUuid, sessionId, cwd };
					parentUuid = uuid;
					seededIds.add(uuid);
					return replayed;
				});
				const uuid = crypto.randomUUID();
				seededIds.add(uuid);
				const entry: SessionStoreEntry = {
					type: message.role,
					uuid,
					parentUuid,
					sessionId,
					cwd,
					timestamp: new Date().toISOString(),
					message:
						message.role === "assistant"
							? {
									...message,
									id: `msg_${uuid}`,
									type: "message",
									model: model.id,
									stop_reason:
										Array.isArray(message.content) && message.content.some(b => b.type === "tool_use")
											? "tool_use"
											: "end_turn",
									stop_sequence: null,
									usage: { input_tokens: 0, output_tokens: 0 },
								}
							: message,
				};
				parentUuid = uuid;
				return [...injected, entry];
			});
			seededEntries = entries;
		}
		if (tools.length) {
			mcp = new McpServer({ name: "proto", version: "1.0.0" });
			mcp.server.registerCapabilities({ tools: {} });
			mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
				tools: tools.map(tool => ({
					name: tool.name,
					description: tool.description,
					inputSchema: { ...tool.inputSchema, type: "object" as const },
					_meta: { "anthropic/alwaysLoad": true },
				})),
			}));
			// Defense in depth: even if SDK hook semantics change, it cannot execute a host tool.
			mcp.server.setRequestHandler(CallToolRequestSchema, async () => {
				throw new Error("Tool execution belongs to the Proto agent loop, not the Claude SDK subprocess.");
			});
		}
		const apiKey = options?.apiKey ?? getEnvApiKey(model.provider);
		const oauth = options?.isOAuth ?? (apiKey !== undefined && isAnthropicOAuthToken(apiKey));
		const foundry = isFoundryEnabled();
		const configuredUrl = normalizeAnthropicBaseUrl(
			foundry ? (process.env.FOUNDRY_BASE_URL ?? model.baseUrl) : model.baseUrl,
		);
		const baseUrl =
			configuredUrl && !isOfficialAnthropicApiUrl(configuredUrl)
				? configuredUrl
				: (normalizeAnthropicBaseUrl(process.env.ANTHROPIC_BASE_URL) ?? configuredUrl);
		const headers = { ...resolveAnthropicCustomHeadersForBaseUrl(baseUrl), ...model.headers, ...options?.headers };
		const proxy = getProxyForProvider(model.provider);
		const certificates: Record<string, string> = {};
		for (const key of ["NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY"]) {
			const value = process.env[key];
			if (!value?.includes("-----BEGIN")) continue;
			transcript ??= await TempDir.create("@proto-claude-");
			const file = transcript.join(`${key}.pem`);
			await Bun.write(file, value.replace(/\\n/g, "\n"), { mode: 0o600 });
			certificates[key] = file;
		}
		const sdkOptions: Options = {
			model: request.model,
			cwd,
			resume,
			sessionId: resume ? undefined : sessionId,
			// Mirror only SDK-added context, not a second copy of Proto's history.
			// The isolated directory is removed in finally, including SDK disk writes.
			sessionStore: {
				async append(key, entries) {
					if (key.subpath) return;
					for (const entry of entries) {
						if (entry.uuid && seededIds.has(entry.uuid)) continue;
						mirroredEntries.push(entry);
						if (entry.uuid) seededIds.add(entry.uuid);
					}
				},
				async load() {
					return seededEntries;
				},
			},
			sessionStoreFlush: "eager",
			settings: { fastMode: options?.serviceTier === "priority", autoMemoryEnabled: false },
			settingSources: [],
			strictMcpConfig: true,
			skills: [],
			tools: [],
			includePartialMessages: true,
			maxTurns: 1,
			abortController: controller,
			pathToClaudeCodeExecutable: claudeAgentExecutable(),
			systemPrompt: request.systemPrompt,
			mcpServers: mcp ? { proto: { type: "sdk", name: "proto", instance: mcp } } : {},
			hooks: {
				PreToolUse: [{ hooks: [async () => ({ continue: false, stopReason: "Proto executes this tool call." })] }],
			},
			canUseTool: async () => ({ behavior: "deny", message: "Proto executes tools outside the SDK." }),
			thinking:
				options?.thinkingEnabled === false
					? { type: "disabled" }
					: options?.thinkingEnabled
						? model.thinking?.mode === "anthropic-adaptive"
							? {
									type: "adaptive",
									display: model.thinking.supportsDisplay
										? (options.thinkingDisplay ?? "summarized")
										: undefined,
								}
							: {
									type: "enabled",
									budgetTokens: options.thinkingBudgetTokens,
									display: options.thinkingDisplay ?? "summarized",
								}
						: undefined,
			effort: options?.effort === "adaptive" ? undefined : options?.effort,
			taskBudget: options?.taskBudget ? { total: options.taskBudget.total } : undefined,
			fallbackModel: options?.fallbacks?.map(fallback => fallback.model).join(","),
			env: {
				...process.env,
				...certificates,
				CLAUDE_CONFIG_DIR: transcript.path(),
				CLAUDECODE: undefined,
				CLAUDE_CODE_ENTRYPOINT: undefined,
				CLAUDE_CODE_USE_BEDROCK: undefined,
				CLAUDE_CODE_USE_VERTEX: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				CLAUDE_AGENT_SDK_CLIENT_APP: "proto",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
				DISABLE_AUTO_COMPACT: "1",
				ENABLE_TOOL_SEARCH: "false",
				// Claude Code gates first-party eager tool input streaming on a remote flag that nonessential-traffic
				// suppression leaves off, so the API would buffer each argument until complete.
				...(resolveEagerToolInputStreamingSupport(model, baseUrl)
					? { CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1" }
					: {}),
				ANTHROPIC_BASE_URL: baseUrl,
				...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: "" } : {}),
				...(apiKey
					? {
							ANTHROPIC_API_KEY: oauth || foundry ? undefined : apiKey,
							CLAUDE_CODE_OAUTH_TOKEN: oauth && !foundry ? apiKey : undefined,
							ANTHROPIC_AUTH_TOKEN: foundry ? apiKey : undefined,
						}
					: {}),
				ANTHROPIC_CUSTOM_HEADERS: Object.entries(headers)
					.map(([key, value]) => `${key}: ${value}`)
					.join("\n"),
				...(options?.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens) } : {}),
				...(options?.cacheRetention === "none" ? { DISABLE_PROMPT_CACHING: "1" } : {}),
			},
			stderr: data => logger.debug("Claude Agent SDK", { stderr: data }),
		};
		async function* prompt(): AsyncGenerator<SDKUserMessage> {
			yield {
				type: "user",
				uuid: promptId,
				session_id: sessionId,
				parent_tool_use_id: null,
				message: last as SDKUserMessage["message"],
			};
		}
		activeQuery = query({ prompt: prompt(), options: sdkOptions });
		const indices = new Map<number, number>();
		let complete = false;
		let sawStart = false;
		let interrupted = false;
		// Proto owns continuation. The SDK retries some completed responses itself (length stops, thinking-only
		// or malformed tool-use nudges); interrupting ends that turn, which still flushes the transcript mirror.
		const interruptFollowUp = (): void => {
			if (interrupted) return;
			interrupted = true;
			activeQuery?.interrupt().catch(error => logger.debug("Claude SDK interrupt failed", { error: String(error) }));
		};
		const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
		for await (const message of iterateWithIdleTimeout(activeQuery, {
			idleTimeoutMs,
			firstItemTimeoutMs: options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs),
			errorMessage: "Claude Agent SDK stream timed out",
			abortSignal: controller.signal,
			onIdle: () => controller.abort(),
			onFirstItemTimeout: () => controller.abort(),
			isProgressItem: item =>
				isRecord(item) && (item.type === "stream_event" || item.type === "assistant" || item.type === "result"),
		})) {
			if (message.type === "system" && message.subtype === "mirror_error") {
				throw new Error(`Claude Agent SDK context replay failed: ${message.error}`);
			}
			if (complete && message.type !== "result") {
				// Anything after the response except the result belongs to an SDK follow-up turn.
				if (message.type === "stream_event") interruptFollowUp();
				continue;
			}
			if (message.type === "system" && message.subtype === "api_retry" && message.error_status !== null) {
				// Let Proto rotate credentials rather than letting the SDK retry the same denied key.
				if (
					(message.error_status >= 400 &&
						message.error_status < 500 &&
						message.error_status !== 408 &&
						message.error_status !== 409) ||
					(options?.maxRetryDelayMs !== undefined &&
						options.maxRetryDelayMs > 0 &&
						message.retry_delay_ms > options.maxRetryDelayMs)
				) {
					throw new AIError.ProviderHttpError(
						`${message.error_status} Claude Agent SDK: ${message.error}`,
						message.error_status,
					);
				}
			}
			if (message.type === "assistant" && message.error) {
				const text = message.message.content
					.filter(b => b.type === "text")
					.map(b => b.text)
					.join("\n");
				const status =
					message.error === "authentication_failed"
						? 401
						: ["oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error"].includes(
									message.error,
								)
							? 403
							: message.error === "rate_limit"
								? 429
								: message.error === "overloaded"
									? 529
									: message.error === "invalid_request"
										? 400
										: message.error === "model_not_found"
											? 404
											: message.error === "server_error"
												? 500
												: undefined;
				throw status === undefined
					? new Error(text || message.error)
					: new AIError.ProviderHttpError(text || message.error, status);
			}
			if (message.type === "result") {
				if (complete) break;
				if (message.is_error)
					throw new Error(message.subtype === "success" ? message.result : message.errors.join("\n"));
				break;
			}
			if (message.type !== "stream_event" || message.parent_tool_use_id !== null) continue;
			const event = message.event;
			if (options?.onSseEvent) {
				const data = JSON.stringify(event);
				notifyRawSseEvent(e => options.onSseEvent?.(e, model), {
					event: event.type,
					data,
					raw: [`event: ${event.type}`, `data: ${data}`],
				});
			}
			if (event.type === "message_start") {
				if (sawStart) throw new Error("Claude Agent SDK started another model turn before completing the first.");
				sawStart = true;
				output.responseId = event.message.id;
				output.upstreamModel = event.message.model;
				output.usage.input = event.message.usage.input_tokens;
				output.usage.output = event.message.usage.output_tokens;
				output.usage.cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
				output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
				applyAnthropicUsageExtras(output.usage, event.message.usage);
				stream.push({ type: "start", partial: output });
			} else if (event.type === "content_block_start") {
				output.ttft ??= performance.now() - started;
				const block = event.content_block;
				const contentIndex = output.content.length;
				indices.set(event.index, contentIndex);
				if (block.type === "text") {
					output.content.push({ type: "text", text: block.text });
					stream.push({ type: "text_start", contentIndex, partial: output });
				} else if (block.type === "thinking") {
					output.content.push({ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature });
					stream.push({ type: "thinking_start", contentIndex, partial: output });
				} else if (block.type === "redacted_thinking") {
					output.content.push({ type: "redactedThinking", data: block.data });
				} else if (block.type === "tool_use") {
					const name = block.name.startsWith(TOOL_PREFIX) ? block.name.slice(TOOL_PREFIX.length) : block.name;
					output.content.push({
						type: "toolCall",
						id: block.id,
						name,
						arguments: isRecord(block.input) ? block.input : {},
						[kStreamingPartialJson]: "",
					});
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
				} else throw new Error(`Unsupported Claude Agent SDK content block: ${block.type}`);
			} else if (event.type === "content_block_delta") {
				const contentIndex = indices.get(event.index);
				if (contentIndex === undefined) throw new Error("Claude Agent SDK delta has no content block");
				const block = output.content[contentIndex];
				const delta = event.delta;
				if (delta.type === "text_delta" && block.type === "text") {
					block.text += delta.text;
					stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
				} else if (delta.type === "thinking_delta" && block.type === "thinking") {
					block.thinking += delta.thinking;
					stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: output });
				} else if (delta.type === "signature_delta" && block.type === "thinking") {
					block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
				} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
					block[kStreamingPartialJson] = (block[kStreamingPartialJson] ?? "") + delta.partial_json;
					const partial = block as ToolCall & { [kStreamingLastParseLen]?: number };
					const parsed = parseStreamingJsonThrottled(
						block[kStreamingPartialJson],
						partial[kStreamingLastParseLen] ?? 0,
					);
					if (parsed) {
						block.arguments = parsed.value;
						partial[kStreamingLastParseLen] = parsed.parsedLen;
					}
					stream.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: output });
				}
			} else if (event.type === "content_block_stop") {
				const contentIndex = indices.get(event.index);
				if (contentIndex === undefined) throw new Error("Claude Agent SDK closed an unknown content block");
				const block = output.content[contentIndex];
				if (block.type === "text")
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				else if (block.type === "thinking")
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				else if (block.type === "toolCall") {
					const json = block[kStreamingPartialJson];
					if (json) {
						const args: unknown = JSON.parse(json);
						if (!isRecord(args)) throw new Error("Claude Agent SDK tool arguments must be a JSON object");
						block.arguments = args;
					}
					clearStreamingPartialJson(block);
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
				}
				indices.delete(event.index);
			} else if (event.type === "message_delta") {
				output.usage.output = event.usage.output_tokens;
				if (event.usage.input_tokens != null) output.usage.input = event.usage.input_tokens;
				if (event.usage.cache_read_input_tokens != null)
					output.usage.cacheRead = event.usage.cache_read_input_tokens;
				if (event.usage.cache_creation_input_tokens != null)
					output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
				applyAnthropicUsageExtras(output.usage, event.usage);
				if (event.delta.stop_reason) {
					output.stopDetails = { type: event.delta.stop_reason };
					output.stopReason = mapAnthropicStopReason(event.delta.stop_reason);
					if (output.stopReason === "error")
						throw new Error(`Claude Agent SDK stopped with ${event.delta.stop_reason}`);
				}
			} else if (event.type === "message_stop") {
				if (!sawStart || indices.size) throw new Error("Claude Agent SDK ended an incomplete message");
				// The SDK flushes transcript mirrors at turn completion, after message_stop.
				complete = true;
				// A length stop always triggers an SDK continuation request; interrupt now so it rarely reaches the API.
				if (output.stopReason === "length") interruptFollowUp();
			}
		}
		options?.signal?.throwIfAborted();
		if (!complete) throw new Error("Claude Agent SDK stream ended before message_stop");
		for (const entry of mirroredEntries) {
			if (entry.type === "assistant" && isRecord(entry.message) && entry.message.id === output.responseId) break;
			// Keep only context that preceded inference, never SDK-side tool results.
			if (entry.type === "user" && !(continuingTools && entry.uuid === promptId)) continue;
			if (entry.type !== "attachment" && entry.type !== "user" && entry.type !== "assistant") continue;
			// Proto's current system prompt must remain authoritative on every call.
			if (isRecord(entry.attachment) && entry.attachment.type === "prompt_snapshot") continue;
			sdkContext.entries.push(entry);
		}
	} catch (error) {
		for (const block of output.content) if (block.type === "toolCall") clearStreamingPartialJson(block);
		const failure = await AIError.finalize(error, {
			api: model.api,
			provider: model.provider,
			signal: options?.signal,
		});
		output.stopReason = failure.stopReason;
		output.errorMessage = failure.message;
		output.errorStatus = failure.status;
		output.errorId = failure.id;
		output.duration = performance.now() - started;
	} finally {
		activeQuery?.close();
		controller.abort();
		options?.signal?.removeEventListener("abort", abort);
		await mcp?.close().catch(error => logger.debug("Claude SDK MCP cleanup failed", { error: String(error) }));
		await transcript
			?.remove()
			.catch(error => logger.debug("Claude SDK transcript cleanup failed", { error: String(error) }));
		output.usage.totalTokens =
			output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
		const usageModel =
			output.upstreamModel && output.upstreamModel !== model.id
				? (getBundledModel("anthropic", output.upstreamModel) ?? model)
				: model;
		calculateCost(usageModel, output.usage, output.timestamp);
		output.duration = performance.now() - started;
		if (output.stopReason === "error" || output.stopReason === "aborted") {
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} else {
			stream.push({ type: "done", reason: output.stopReason, message: output });
		}
		stream.end();
	}
}
