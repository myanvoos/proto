# Anthropic through Claude Agent SDK

The `anthropic` provider uses the official TypeScript `@anthropic-ai/claude-agent-sdk` (`query()`), including its bundled Claude Code runtime. It no longer sends inference requests through Proto's custom Anthropic HTTP client or fingerprint emulation. Other provider IDs using `api: anthropic-messages`—including Copilot, Vertex, and custom gateways—retain the Messages transport. There is no automatic fallback from the SDK to that transport.

## Tools and conversation ownership

Proto still owns the agent loop, tool execution, permissions, extension hooks, concurrency, cancellation, and tool-result rendering. All tools supplied in the active context are advertised to the SDK through an in-process MCP server, with their JSON schemas and descriptions intact. Wire names use `mcp__proto__<name>`; Proto sees the original names and call IDs. Tool search is disabled so the full active tool catalog is available immediately.

SDK built-in tools are disabled. A `PreToolUse` hook stops SDK-side execution, and the MCP handler also refuses execution. Each provider call consumes one streamed assistant message, waits for the SDK result to flush its transcript mirror, then closes the query. The SDK's own follow-up turns—its output-limit continuation after a length stop and its nudges after thinking-only or malformed tool-use responses—are interrupted; the completed response is returned and Proto decides how to continue. Proto executes its requested tools exactly as with other providers. This avoids a second permission/execution loop or duplicate file/shell operations inside Claude Code.

The next call rebuilds the SDK transcript from Proto's authoritative context. This supports resumed Proto sessions, edited/compacted history, model changes, tool errors, multiple calls per turn, image inputs/results, and signed/redacted thinking. Completed tool-use/result pairs must be seeded together: Claude's resume loader removes unresolved calls before reading new input. A tool-result-only continuation therefore adds the synthetic instruction “Continue from the tool results above.” after the seeded results. This extra instruction is an SDK integration constraint, not a fabricated tool result.

Each call uses an isolated temporary `CLAUDE_CONFIG_DIR`; SDK transcript/config files are removed on completion or failure. The child does not read the user's Claude Code account profile from `~/.claude.json`, so it cannot inject that profile's email or account UUID. Proto still supplies the credential. Project/user settings, skill discovery, automatic memory, and SDK auto-compaction remain disabled. SDK subprocess diagnostics go to Proto's logger, never directly to TUI/stdout.

The SDK adds runtime context (such as environment, model identity, and date) that is not part of Proto's user messages. Proto retains these opaque transcript entries in the assistant response's `providerPayload`, along with SDK-generated tool-continuation entries. The next call restores them at their original history positions through the SDK session store. Without this replay, the runtime moves its reminders to the newest turn and invalidates the previous conversation-cache prefix on every call. The SDK session ID is also retained across calls; the redundant SDK token-count reminder is disabled.

Only entries preceding the actual model response are replayed: SDK-side denied tool results and end-of-turn bookkeeping are not host tool results. System-prompt snapshots are excluded so Proto's current instructions remain authoritative. Edited or compacted history and changes to the system prompt or tools can still legitimately invalidate cached prefixes. Existing histories without the replay metadata need a new cache baseline after upgrading.

## Authentication and configuration

Existing Proto `--api-key`, stored credentials, account rotation, and `/login anthropic` resolution remain in place. API keys are passed to the child as `ANTHROPIC_API_KEY`; OAuth credentials use `CLAUDE_CODE_OAUTH_TOKEN`. Conflicting inherited auth variables are cleared when Proto supplies a credential. `CLAUDE_CODE_OAUTH_TOKEN` is also an environment-key fallback after `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`.

Custom model `baseUrl` overrides and `ANTHROPIC_BASE_URL` are forwarded. Foundry mode keeps `FOUNDRY_BASE_URL` and bearer authentication. Model/request headers become SDK custom headers. Provider-specific proxy configuration (`PI_PROXY_ANTHROPIC`, then `PI_PROXY`) is forwarded to the subprocess; standard proxy and certificate environment variables are inherited. Certificate files must be readable by the SDK process.

Model selection, maximum output tokens, thinking budgets/adaptive thinking, effort, task budget, fallback model IDs, and priority/fast mode map to SDK options. `cacheRetention: none` disables caching; otherwise the SDK controls cache placement and retention. Cache read/write tokens, generated tokens, thinking signatures, partial tool JSON, and finish reasons map back to the normal Proto events and accounting.

Abort and stream deadlines terminate the query. Authentication/terminal client errors and rate limits observed in SDK retry events are surfaced promptly for Proto credential rotation instead of retrying the same rejected credential inside the child. Other retry behavior belongs to the SDK.

## Thinking and runtime controls

Thinking summaries stream through the existing `thinking_start`, `thinking_delta`, and `thinking_end` events; signatures are retained for replay. Enabled thinking requests `display: "summarized"` on display-capable adaptive models and on fixed-budget models. `thinkingDisplay: "omitted"` suppresses the summary without disabling reasoning. In the CLI, `omitThinking` controls upstream suppression, while `hideThinkingBlock` only controls local visibility. No full/private reasoning trace is exposed.

Controls already mapped by Proto include thinking mode and budget, effort, maximum output tokens, task budget, priority/fast mode, fallback models, cancellation/timeouts, and cache disabling. The SDK additionally exposes `maxBudgetUsd`, JSON-schema `outputFormat`, prompt suggestions, and subagent progress summaries, but Proto does not currently forward those options. Progress summaries describe SDK subagents, not Proto fleet workers. The SDK's one-line `highlights` display is restricted to Anthropic-hosted remote sessions and is not an alternative display mode for this local adapter.

## API differences

The SDK is an agent runtime, not a drop-in Messages HTTP client:

- `toolChoice: auto` and `none` work. Forced `any`/named-tool choices fail explicitly; the SDK has no equivalent option. This also applies to callers using a forced tool for structured completion.
- Injected `fetch`/Messages `client`, explicit Messages server-compaction requests, and zero-token cache-refresh requests fail explicitly. Use a base URL for gateways or transport-level testing.
- Background cache warming is removed. SDK auto-compaction is disabled so it cannot silently replace Proto's authoritative history. Use Proto's configured memory/compaction method or a separate remote compaction endpoint; the `anthropic` provider is not eligible for the Messages compaction beta.
- Low-level Messages beta flags, sampling parameters, stop sequences, custom metadata, mid-conversation wire controls, explicit cache TTLs, and per-fallback effort/speed are not forwarded. The SDK owns these wire details. Changing a Proto system prompt or tool catalog takes effect on the next provider call rather than emitting Messages control blocks.
- `onPayload` receives an adapter request with `model`, `systemPrompt` (string array), `messages` (Messages-style history), and `tools` (`name`, `description`, `inputSchema`). Middleware may mutate or replace it. It is not the final SDK-generated HTTP body and contains no credentials or executable callbacks.
- `onSseEvent` observes decoded SDK stream events, not raw network frames. The SDK does not expose HTTP response headers, so `onResponse` and header-based quota/debug hooks do not fire for these inference calls. Independent `/usage` polling remains available.
- Streaming text, thinking, redacted thinking, and tool calls are supported. Unknown SDK content block types fail visibly rather than being silently dropped. Tool arguments stream as the model writes them wherever the Messages transport would request eager tool input streaming (the official API, or a gateway whose compat declares `supportsEagerToolInputStreaming`); elsewhere the API buffers each argument until it is complete.

## Packaging and verification

The pinned SDK `0.3.283` bundles Claude Code `2.1.283`. Claude Opus 5.5 requires Claude Code `2.1.280` or newer; an older `PI_CLAUDE_EXECUTABLE` override will be rejected by the service.

Source installations use the SDK's optional native platform dependency; do not omit optional dependencies. Compiled Proto binaries embed the target platform's SDK executable and extract it with the SDK's `extractFromBunfs()` helper. Cross-compilation needs that platform package installed (`bun install --os='*' --cpu='*'`). `PI_CLAUDE_EXECUTABLE` overrides the executable path for diagnostics or installations that manage Claude separately.

`packages/ai/src/providers/claude-agent-sdk.test.ts` drives the real SDK/native subprocess against an isolated HTTP fixture. It covers streaming, tool schemas and handoff, tool errors, image and signed-thinking replay, middleware, usage, credential failures, cancellation, and non-Anthropic routing. The fixture also enforces the observed Opus 5.5 minimum-runtime requirement against the actual SDK request. No live Anthropic account is required by these tests.

For live verification, check every assistant response's `upstreamModel` and reject runs with `retry_fallback_applied`: a valid answer from another provider after automatic fallback does not prove the requested Claude model worked.

Official references: [TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript), [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop), [hooks](https://code.claude.com/docs/en/agent-sdk/hooks).
