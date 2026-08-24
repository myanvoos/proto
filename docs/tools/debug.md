# debug

> Drive one DAP debug session. The session-level raw SSE capture buffer (`packages/coding-agent/src/debug/raw-sse-buffer.ts`) is part of the same debug subsystem.

## Source
- Entry: `packages/coding-agent/src/tools/debug.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/debug.md`
- Key collaborators:
  - `packages/coding-agent/src/dap/session.ts` — session lifecycle, breakpoint/state cache
  - `packages/coding-agent/src/dap/client.ts` — adapter process/socket transport, DAP message loop
  - `packages/coding-agent/src/dap/config.ts` — adapter resolution and auto-selection
  - `packages/coding-agent/src/dap/defaults.json` — built-in adapter definitions
  - `packages/coding-agent/src/dap/types.ts` — request/response/capability shapes
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — per-tool timeout clamp
  - `packages/coding-agent/src/debug/raw-sse-buffer.ts` — bounded SSE capture buffer

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"launch" \| "attach" \| "set_breakpoint" \| "remove_breakpoint" \| "set_instruction_breakpoint" \| "remove_instruction_breakpoint" \| "data_breakpoint_info" \| "set_data_breakpoint" \| "remove_data_breakpoint" \| "continue" \| "step_over" \| "step_in" \| "step_out" \| "pause" \| "evaluate" \| "stack_trace" \| "threads" \| "scopes" \| "variables" \| "disassemble" \| "read_memory" \| "write_memory" \| "modules" \| "loaded_sources" \| "custom_request" \| "output" \| "terminate" \| "sessions"` | Yes | Dispatch key for the tool switch in `packages/coding-agent/src/tools/debug.ts`. |
| `program` | `string` | No | Launch target path. Required for `launch`. Resolved relative to `cwd` if provided, otherwise session cwd. |
| `args` | `string[]` | No | Program argv for `launch`. |
| `adapter` | `string` | No | Explicit adapter name. Otherwise `selectLaunchAdapter()` / `selectAttachAdapter()` auto-pick from `packages/coding-agent/src/dap/config.ts`. |
| `cwd` | `string` | No | Launch/attach working directory. Defaults to session cwd. |
| `file` | `string` | No | Source file path for source breakpoints. |
| `line` | `number` | No | Source line for source breakpoints. |
| `function` | `string` | No | Function breakpoint name. When supplied, breakpoint actions take the function path and ignore `file`/`line`; the schema does not reject both forms together. |
| `name` | `string` | No | Data breakpoint info target name. Required for `data_breakpoint_info`. |
| `condition` | `string` | No | Conditional expression for source/function/instruction/data breakpoints. |
| `hit_condition` | `string` | No | Hit-count condition for instruction/data breakpoints. |
| `expression` | `string` | No | Expression or raw debugger command. Required for `evaluate`. |
| `context` | `string` | No | Evaluate context. Defaults to `"repl"`. Passed through as DAP evaluate context. |
| `frame_id` | `number` | No | Frame selector for `evaluate`, `scopes`, `data_breakpoint_info`. `scopes` and `evaluate` default to the current stopped frame when omitted. |
| `scope_id` | `number` | No | Variables reference from a scope. Accepted by `variables`; also used as a fallback variables reference for `data_breakpoint_info`. |
| `variable_ref` | `number` | No | Variables reference for `variables`; preferred over `scope_id` when both are present. |
| `pid` | `number` | No | Local process id for `attach`. Required with `port` only when no explicit adapter is selected. |
| `port` | `number` | No | Remote attach port. If no adapter is forced, attach prefers `debugpy` when `port` is present. |
| `host` | `string` | No | Remote attach host for `attach`. |
| `levels` | `number` | No | Max stack frames for `stack_trace`. |
| `memory_reference` | `string` | No | Memory reference/address for `disassemble`, `read_memory`, `write_memory`. `disassemble` uses this when provided; otherwise it falls back to the current stopped location's instruction-pointer reference if the adapter supplied one. |
| `instruction_reference` | `string` | No | Instruction breakpoint reference; required for instruction breakpoint actions. Not used by `disassemble`. |
| `instruction_count` | `number` | No | Required for `disassemble`. |
| `instruction_offset` | `number` | No | Instruction offset for `disassemble`. |
| `count` | `number` | No | Byte count for `read_memory`. Required there. |
| `data` | `string` | No | Base64 payload for `write_memory`. Required there. |
| `data_id` | `string` | No | Data breakpoint id. Required for `set_data_breakpoint` / `remove_data_breakpoint`. |
| `access_type` | `"read" \| "write" \| "readWrite"` | No | Access filter for `set_data_breakpoint`. |
| `command` | `string` | No | Custom DAP request command. Required for `custom_request`. |
| `arguments` | `Record<string, unknown>` | No | Custom DAP request body for `custom_request`. |
| `offset` | `number` | No | Offset for instruction breakpoints, disassembly, memory read, memory write. |
| `resolve_symbols` | `boolean` | No | `disassemble` symbol-resolution flag. |
| `allow_partial` | `boolean` | No | `write_memory` partial-write allowance. |
| `start_module` | `number` | No | Modules pagination start index for `modules`. |
| `module_count` | `number` | No | Modules pagination count for `modules`. |
| `timeout` | `number` | No | Per-request seconds, default `30`; `clampTimeout("debug", ...)` applies the positive `tools.maxTimeout` cap first, then the tool's `5..300` range (so the 5-second floor still wins over a lower global cap). |

### Action-specific requirements
- `launch`: `program`
- `attach`: `pid` or `port`, unless an explicit adapter supplies its attach arguments
- `set_breakpoint` / `remove_breakpoint`: `function`, or `file` + `line`
- `set_instruction_breakpoint` / `remove_instruction_breakpoint`: `instruction_reference`
- `data_breakpoint_info`: `name`
- `set_data_breakpoint` / `remove_data_breakpoint`: `data_id`
- `evaluate`: `expression`
- `variables`: `variable_ref` or `scope_id`
- `disassemble`: capability `supportsDisassembleRequest`, plus `instruction_count`, and either `memory_reference` or a current stopped location with `instructionPointerReference`
- `read_memory`: capability `supportsReadMemoryRequest`, plus `memory_reference` and `count`
- `write_memory`: capability `supportsWriteMemoryRequest`, plus `memory_reference` and `data`
- `modules`: capability `supportsModulesRequest`
- `loaded_sources`: capability `supportsLoadedSourcesRequest`
- `custom_request`: `command`

## Outputs
The agent tool returns a standard `toolResult()` payload from `packages/coding-agent/src/tools/debug.ts`:
- `content`: one text block. Every action renders human-readable text; there is no structured JSON block in `content`.
- `details.action`: echoed action.
- `details.success`: always initialized `true`; failures surface by throwing before a result is returned.
- `details.snapshot`: present for actions that operate on or create a session, using `DapSessionSummary` from `packages/coding-agent/src/dap/types.ts`.
- Action-specific `details` fields:
  - `launch` / `attach`: `adapter`
  - breakpoint actions: `breakpoints`, `functionBreakpoints`, `instructionBreakpoints`, `dataBreakpoints`
  - `data_breakpoint_info`: `dataBreakpointInfo`
  - `continue` / `step_*`: `state`, `timedOut`
  - `threads`: `threads`
  - `stack_trace`: `stackFrames`
  - `scopes`: `scopes`
  - `variables`: `variables`
  - `evaluate`: `evaluation`
  - `disassemble`: `disassembly`
  - `read_memory`: `memoryAddress`, `memoryData`, `unreadableBytes`
  - `write_memory`: `bytesWritten`
  - `modules`: `modules`
  - `loaded_sources`: `sources`
  - `custom_request`: `customBody`
  - `output`: `output`
  - `sessions`: `sessions`

Streaming/UI behavior:
- The discoverable tool's renderer merges call and result (`mergeCallAndResult: true`), renders inline, and enables animated partial-result presentation while arguments/results are still being assembled.
- `debug.ts` itself does not emit progress updates through `_onUpdate`; execution result delivery is single-shot.

## Flow

1. Tool registration is conditional: `DebugTool.createIf()` in `packages/coding-agent/src/tools/debug.ts` returns `null` unless `session.settings.get("debug.enabled")` is true (default `true`). `packages/coding-agent/src/tools/index.ts` wires the factory and rechecks the same setting in tool filtering.
2. `DebugTool.execute()` clamps `params.timeout` through `clampTimeout("debug", params.timeout)`, applying the optional positive `tools.maxTimeout` cap before the tool's 5-second floor and 300-second ceiling, and composes the caller `AbortSignal` with `AbortSignal.timeout(...)`.
3. `launch` resolves cwd/program paths, classifies the target as file/directory/missing, rejects directories unless the chosen adapter sets `acceptsDirectoryProgram`, and delegates to `dapSessionManager.launch()`. `attach` resolves cwd and selects an adapter; it requires `pid` or `port` only without an explicit adapter.
4. `DapSessionManager.launch()` / `.attach()` enforce one root session, spawn the adapter through `DapClient.spawn()`, register listeners, send `initialize`, cache capabilities, subscribe for tree-wide stop events, send `launch`/`attach`, then complete the `initialized` → `configurationDone` handshake.
5. `DapClient.spawn()` starts adapters detached with `NON_INTERACTIVE_ENV`. `stdio` uses the adapter pipes; `socket` uses a Unix socket on Linux or an adapter callback to a local TCP listener elsewhere; `tcp` substitutes `${port}` in adapter args, starts its local server, then connects. Child sessions reuse a root `tcp` server through `DapClient.connect()`.
6. `#registerSession()` in `packages/coding-agent/src/dap/session.ts` installs reverse-request handlers:
   - `runInTerminal`: spawns the requested debuggee command detached via `ptree.spawn()` and returns `{ processId }`
   - `startDebugging`: connects a child DAP client to the root TCP server, forwards the requested `launch`/`attach` configuration, binds root breakpoints before `configurationDone`, and recursively installs the same handlers
   - events: `output`, `initialized`, `stopped`, `continued`, `exited`, and `terminated` update cached session state; stopped children become the active target
7. Operational actions (`set_breakpoint`, `evaluate`, `threads`, `read_memory`, `custom_request`, and similar) call `dapSessionManager` methods. Most flow through `#sendRequestWithConfig()`, which first sends `configurationDone` when required, then sends the DAP request and refreshes the active session plus its ancestors.
8. Breakpoint actions synchronize desired breakpoint sets across the live root/child tree. New children receive those sets before their `configurationDone` request.
9. `continue` and the three step actions clear cached stop state, subscribe for a stop/termination event anywhere in the session tree before sending the DAP request, then `#awaitStopOutcome()` returns the active child’s stopped location or reports that the target remains running after timeout.
10. `pause` sends DAP `pause`, waits for a stopped event if needed, and reuses cached stop state if the program was already stopped.
11. `stack_trace`, `scopes`, `variables`, and `evaluate` default to the current stopped child/thread/frame when the caller omits ids and cached state is available.
12. `output` reads the in-memory output ring from the active `DapSession`. `terminate` walks from the root through every child, sends best-effort `terminate`/`disconnect`, and disposes the complete tree even when an adapter times out.
13. `sessions` reads the manager’s current map and formats root and child summaries. Only one root tree can exist; recursive adapter-requested children are tracked with `parentSessionId` / `childSessionIds`.

## Modes / Variants
- **Availability gate**
  - Tool hidden when `debug.enabled` is false; the setting defaults to `true`. The tool uses discoverable loading and exclusive concurrency.
- **Adapter selection**
  - Built-in adapter ids are `gdb`, `lldb-dap`, `codelldb`, `debugpy`, `dlv`, `js-debug-adapter`, `netcoredbg`, `kotlin-debug-adapter`, `rdbg`, `php-debug-adapter`, `bash-debug-adapter`, `dart-debug-adapter`, `flutter-debug-adapter`, and `elixir-ls-debugger`. Auto-selection only considers adapters whose configured command resolves; an explicitly selected configured-but-unavailable adapter produces an adapter-specific installation/configuration error.
  - `launch`: explicit `adapter` wins; otherwise `selectLaunchAdapter()` ranks available adapters by extension match, root-marker match, then native-debugger preference (`gdb`, `lldb-dap`) for extensionless binaries.
  - `attach`: explicit `adapter` wins; otherwise remote `port` prefers `debugpy`, then native debuggers, then first available adapter.
- **Custom adapter config**
  - Debug adapters can be added or overridden with `dap.json`, `.dap.json`, `dap.yaml`, `.dap.yaml`, `dap.yml`, or `.dap.yml`.
  - Search order mirrors LSP config: project root, project config dirs (`.proto/`, `.claude/`, `.codex/`, `.gemini/`), user config dirs (`~/.proto/agent/`, `~/.claude/`, `~/.codex/`, `~/.gemini/`), plugin roots, then home-root fallback. Files are merged from lowest to highest priority.
  - Config shape may be either `{ "adapters": { ... } }` or a top-level adapter map.
  - Adapter fields:
    - `command`: executable name or path. Required.
    - `args`: adapter argv.
    - `languages`: display/filter metadata.
    - `fileTypes`: lowercase file extensions used for launch auto-selection.
    - `rootMarkers`: files/directories used to rank adapters for a project.
    - `launchDefaults`: default DAP launch arguments merged before the selected program/cwd/args.
    - `attachDefaults`: default DAP attach arguments. An explicit adapter may attach without a PID or port; its adapter validates these arguments.
    - `connectMode`: `"stdio"` (default), `"socket"` (Delve-style platform-dependent socket/callback), or `"tcp"` (spawn a local DAP server with `${port}` substituted into `args`).
    - `acceptsDirectoryProgram`: set `true` for adapters such as `dlv` that can launch a package/project directory.

Example `.proto/dap.json`:

```json
{
  "adapters": {
    "custom-jvm": {
      "command": "kotlin-debug-adapter",
      "args": ["--stdio"],
      "languages": ["java", "kotlin"],
      "fileTypes": [".java", ".kt", ".kts"],
      "rootMarkers": ["pom.xml", "build.gradle", "build.gradle.kts"],
      "launchDefaults": {
        "request": "launch",
        "projectRoot": "."
      },
      "attachDefaults": {
        "request": "attach",
        "host": "127.0.0.1"
      }
    }
  }
}
```

GDB example for an OpenOCD remote target:

```json
{
  "adapters": {
    "pico-openocd": {
      "command": "gdb",
      "args": [
        "-q",
        "-ex",
        "file zig-out/firmware/gc9a01-test.elf",
        "-i",
        "dap"
      ],
      "attachDefaults": {
        "target": ":3334"
      }
    }
  }
}
```
- **Transport**
  - `stdio`: direct adapter `stdin`/`stdout` framing.
  - `socket`: Unix domain socket on Linux; adapter callback to a local TCP listener on macOS/other.
  - `tcp`: reserve a loopback port, substitute it for `${port}` in adapter args, wait for the adapter to listen, then connect. This is used by the resolved JavaScript/TypeScript adapter and is required for recursive `startDebugging` child sessions.
- **DAP agent-tool actions**
  - `launch` — spawn adapter, initialize session, maybe stop on entry; returns formatted session snapshot and `details.adapter`.
  - `attach` — connect to a live process or remote port; same output shape as `launch`.
  - `set_breakpoint` — source or function breakpoint add/update; returns the current breakpoint list for that target.
  - `remove_breakpoint` — source or function breakpoint removal; returns the remaining breakpoint list.
  - `set_instruction_breakpoint` / `remove_instruction_breakpoint` — require `supportsInstructionBreakpoints`; return current instruction breakpoint list.
  - `data_breakpoint_info` — require `supportsDataBreakpoints`; asks the adapter for a `dataId`, access types, and description for `name`.
  - `set_data_breakpoint` / `remove_data_breakpoint` — require `supportsDataBreakpoints`; return the cached data-breakpoint list.
  - `continue` / `step_over` / `step_in` / `step_out` — return text describing whether execution stopped, terminated, or kept running, plus `details.state` and `details.timedOut`.
  - `pause` — interrupts a running target and returns a stopped snapshot.
  - `evaluate` — adapter expression evaluation; defaults context to `repl`.
  - `stack_trace` — fetches frames for the resolved thread.
  - `threads` — fetches current threads.
  - `scopes` — frame scopes for an explicit `frame_id` or the current stopped frame.
  - `variables` — variables for `variable_ref` or `scope_id`.
  - `disassemble` — require `supportsDisassembleRequest`; disassembles around `memory_reference`, or around the current stopped instruction pointer when no memory reference is supplied.
  - `read_memory` — require `supportsReadMemoryRequest`; returns address, base64 data, unreadable-byte count.
  - `write_memory` — require `supportsWriteMemoryRequest`; writes base64 data and reports bytes written.
  - `modules` — require `supportsModulesRequest`; optional pagination via `start_module` / `module_count`.
  - `loaded_sources` — require `supportsLoadedSourcesRequest`; returns loaded source descriptors.
  - `custom_request` — sends any DAP request name with arbitrary arguments.
  - `output` — dumps captured stdout/stderr/console text from the session cache.
  - `terminate` — disconnects and disposes the active session; returns `No debug session to terminate.` when none exists.
  - `sessions` — lists all cached session summaries.

## Side Effects
- Filesystem
  - Resolves program/file/cwd paths against the session cwd.
- Network
  - Socket/TCP-mode adapters bind or connect local sockets; remote attach may connect through the adapter to a remote debug port.
- Subprocesses / native bindings
  - Spawns debugger adapters (`gdb`, `lldb-dap`, `python -m debugpy.adapter`, `dlv`, and others from `defaults.json`) detached.
  - Reverse DAP `runInTerminal` requests spawn the debuggee detached via `ptree.spawn()`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - `DapSessionManager` keeps session summaries, breakpoints, threads, stack frames, stop location, output capture, capabilities, and last-used timestamps in memory.
  - Active-session id is global to the singleton `dapSessionManager`.
  - `RawSseDebugBuffer` stores recent SSE events per owner/session.
  - The tool is `exclusive`; concurrent debug tool calls are blocked by the scheduler.
- Background work / cancellation
  - Every DAP request accepts an `AbortSignal`; timeouts and caller cancellation abort the active request, not the whole session lifetime.
  - `DapSessionManager` runs a background cleanup loop every 30 seconds.
  - Raw SSE capture subscribes to buffer updates while the session runs.

## Limits & Caps
- Tool timeout clamp: `default=30`, `min=5`, `max=300` in `packages/coding-agent/src/tools/tool-timeouts.ts`.
- Per-request DAP default timeout: `DEFAULT_REQUEST_TIMEOUT_MS = 30_000` in `packages/coding-agent/src/dap/client.ts`.
- Single active session: enforced by `#ensureLaunchSlot()` in `packages/coding-agent/src/dap/session.ts`.
- Idle session cleanup: `IDLE_TIMEOUT_MS = 10 * 60 * 1000`, checked every `CLEANUP_INTERVAL_MS = 30 * 1000`.
- Adapter liveness heartbeat: `HEARTBEAT_INTERVAL_MS = 5 * 1000`.
- Output capture cap: `MAX_OUTPUT_BYTES = 128 * 1024`; whole chunks are dropped from the front (then the front chunk is byte-sliced so exactly the cap remains) and `outputTruncated` is recorded.
- Initial stop capture timeout after launch/attach: `STOP_CAPTURE_TIMEOUT_MS = 5_000`.
- Socket-mode adapter readiness timeout: `10_000` ms in `waitForCondition()` and TCP connect timeout logic in `packages/coding-agent/src/dap/client.ts`.
- Raw SSE buffer caps in `packages/coding-agent/src/debug/raw-sse-buffer.ts`:
  - `MAX_RAW_SSE_EVENTS = 1_000`
  - `MAX_RAW_SSE_CHARS = 512_000`
  - `MAX_RAW_SSE_EVENT_CHARS = 64_000` per event; over-budget events first get `tools` schemas compacted (name kept, schema/description elided), then a head+tail trim that keeps the first and last portions with a `: proto-debug-elided chars=...` comment in the middle and a final `: proto-debug-truncated originalChars=...` marker

## Errors
- Parameter validation in `packages/coding-agent/src/tools/debug.ts` throws `ToolError` with explicit messages such as:
  - `program is required for launch`
  - `attach requires pid or port` when no explicit adapter is selected
  - `set_breakpoint requires file+line or function`
  - `variables requires variable_ref or scope_id`
  - `instruction_count is required for disassemble`
  - `disassemble requires memory_reference unless the current stop location has an instruction pointer reference`
  - `memory_reference is required for read_memory`
  - `count is required for read_memory`
  - `data is required for write_memory`
  - `launch program resolves to a directory: <path>...` when the selected adapter does not set `acceptsDirectoryProgram`
  - `command is required for custom_request`
- Adapter selection failure throws `No debugger adapter available. Installed adapters: ...`.
- Capability-gated actions throw from `requireCapability(...)`, e.g. `Current adapter does not support memory reads`.
- No-session and state errors come from `DapSessionManager`, e.g. `No active debug session. Launch or attach first.`, `No active stack frame. Run stack_trace first or supply frame_id.`, `Debugger reported no threads.`
- Launching a second live session throws `Debug session <id> is still active. Terminate it before launching another.`
- DAP transport/request failures surface as thrown errors from `DapClient`:
  - `DAP request <command> timed out after <ms>ms`
  - `DAP event <event> timed out after <ms>ms`
  - `DAP adapter <name> is not running`
  - `DAP adapter exited (code N): <stderr>` or `DAP adapter exited unexpectedly (code N)`
  - adapter response `message` when a DAP request fails
- `continue` / `step_*` are intentionally non-fatal when the target stays running past the timeout: they return `details.timedOut = true` and `state: "running"` instead of throwing.
- `terminate` suppresses adapter errors while sending `terminate`/`disconnect`; it still disposes the client and returns the last summary when possible.

## Notes
- `packages/coding-agent/src/prompts/tools/debug.md` tells the model only one active root session is supported. Adapter-requested child sessions belong to that root tree.
- The default JavaScript/TypeScript adapter runs vscode-js-debug's `dapDebugServer.js` over TCP. Install it one of these ways; the first and last are auto-discovered by `resolveJsDebugServerPath()` in `packages/coding-agent/src/dap/config.ts`. (Don't try `npm i -g js-debug-adapter` — it 404s; `js-debug-adapter` is the proto adapter id, not an npm package.)
  - Release tarball, extracted so `dapDebugServer.js` lands at `~/.local/opt/js-debug/src/dapDebugServer.js`:
    ```sh
    curl -sL -o js-debug-dap.tar.gz \
      https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/js-debug-dap-v1.117.0.tar.gz
    mkdir -p ~/.local/opt && tar -xzf js-debug-dap.tar.gz -C ~/.local/opt
    ```
    Replace `v1.117.0` with the latest tag from the [releases page](https://github.com/microsoft/vscode-js-debug/releases).
  - Any other location via `JS_DEBUG_DAP_SERVER=<path-to-dapDebugServer.js>`.
  - Neovim users with Mason: `:MasonInstall js-debug-adapter` → discovered at `~/.local/share/nvim/mason/packages/js-debug-adapter/js-debug/src/dapDebugServer.js`.
- The adapter runs under `node` if on `PATH`, otherwise under the proto host (Bun); `resolveDefaultJsDebugAdapter()` falls back to `process.execPath`, so a Bun-only setup is supported.
- `configurationDone` is sent automatically during root and child launch/attach handshakes and lazily before later requests if the initial handshake did not complete.
- `startDebugging` reverse requests create recursive child sessions on the same TCP server; a stopped child becomes the target for thread-level actions.
- `output` exposes the active session’s merged `output` event stream only; the tool does not distinguish stdout, stderr, and console categories.
- Session summaries expose `needsConfigurationDone`, `parentSessionId`, and `childSessionIds`.
- Source breakpoint file paths are normalized with `path.resolve()` before caching and synchronizing across the tree.
- `evaluate` defaults to `repl`, so the tool can forward raw debugger commands when the adapter supports them.
- `disassemble` resolves its target from `memory_reference` first, then the current stopped session's `instructionPointerReference`; it throws if neither is present.
- `RawSseDebugBuffer.recordEvent()` increments `totalEvents` before bounded retention. A snapshot can therefore show fewer retained records than total observed events.
- Raw SSE buffer listener failures are swallowed so consumer bugs do not break capture.
- The tool renderer truncates displayed output for the TUI preview, but the underlying text result still contains the full returned string.
