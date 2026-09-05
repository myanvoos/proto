# Bash tool runtime

This document describes the **`bash` tool** runtime path used by agent tool calls, from command normalization to execution, truncation/artifacts, and rendering.

It also calls out where behavior diverges in interactive TUI, print mode, RPC mode, and user-initiated bang (`!`) shell execution.

## Scope and runtime surfaces

There are two different bash execution surfaces in coding-agent:

1. **Tool-call surface** (`toolName: "bash"`): used when the model calls the bash tool.
   - Entry point: `BashTool.execute()`.
   - Parameters include `command`, optional `env`, `timeout`, `cwd`, `pty`, and, when `async.enabled` is true, `async`.
2. **User bang-command surface** (`!cmd` from interactive input or RPC `bash` command): session-level helper path.
   - Entry point: `AgentSession.executeBash()`.

Both eventually use `executeBash()` in `src/exec/bash-executor.ts` for non-PTY execution, but only the tool-call path runs normalization/interception, optional managed background-job handling, and tool renderer logic.

Set `bash.enabled: false` in settings to remove the model-facing `bash` tool from the active tool registry. This does not disable user-initiated bang commands or RPC `bash` requests.

## `xd` as a Brush builtin

When xdev is enabled, model-facing Bash runs use the Brush shell parser and register `xd` as a builtin. `xd <tool> '<json>'` therefore composes with the same shell language as native commands: pipelines, `|&`, redirects, command substitutions, subshells/groups, loops, conditionals, `&&`/`||`, background jobs, and `pipefail` are parsed and executed by one runtime. The builtin receives the invocation-local working directory from each shell branch, so `(cd sub; xd read '{"path":"file"}')` does not mutate the shared tool session; concurrent branches remain isolated.

The bridge maps successful text content to stdout and tool-error text to stderr; tool-error status is `1`, while bridge/serialization failure is `125`. Non-text content and `xdev` details travel in `xdDispatches`, a structured side channel consumed by Bash rendering, never through stdout/stderr pipes. Native shell cancellation and deadlines cancel the bridge await; downstream pipe closure returns the shell's broken-pipe status. Bridge input is bounded to 1 MiB of UTF-8 stdin.

`xd` exists only inside the agent's Brush shell. `fleet` processes, client terminal/PTY execution, user bang commands without the agent Bash dispatcher, and standalone external `bash` do not inherit it; they must not assume an `xd` binary exists on `PATH`.

## Streamed kernel preflight and speculation

Two independent, default-on settings can overlap work with model generation:

```yaml
kernel:
  speculation:
    enabled: true
  assertPreflight:
    enabled: true
```

These settings apply to model-generated `bash` calls containing a standalone, quoted Python/JavaScript heredoc. They do not execute partial shell commands or partial cells in the live kernel, and do not apply to user bang commands. Normal finalized calls still pass through validation, extension approval, bash interception, and the normal execution path. Streaming observation is disabled while secret obfuscation has active secrets.

**Both options permit preflight effects before final tool approval by default; set either to `false` to opt out.** Completion requests may already have been sent and billed when a call is blocked, changed, or cancelled. Assertion preflight may already have read local files. Cancellation cannot undo those effects.

### Completion speculation

`kernel.speculation.enabled` prelaunches eligible top-level `completion()` calls with literal arguments as their source becomes complete. Python keyword options and JavaScript literal options objects are supported. For example:

```bash
python <<'PY'
summary = completion("Summarize the purpose of speculative execution.", model="smol")
title = completion("Give a short title for a document about speculative execution.")
print(summary, title)
PY
```

The completed cell runs normally. A matching real completion invocation can claim its already-running result rather than make another request. Identical calls remain separate stochastic samples, not one memoized answer. Claiming is scoped to the originating call and runtime invocation, with model/options and finalized input matching; it is not a session-wide arguments-only cache.

At most two speculative requests launch per outer bash call, including invalidated attempts; normal execution can make additional requests for calls without a reusable result. Changes to relevant input fields or candidates invalidate pending work; changing `cwd`, `env`, `pty`, or `async` does not silently reuse an incompatible result. Unclaimed work is cancelled when the call/turn is retired or the session is aborted/disposed; work already claimed by normal execution follows its runtime lifetime.

This is deliberately not general shell speculation or a shadow REPL. Dynamic completion arguments, control-flow calls, and arbitrary `agent()`/tool calls are excluded. Unquoted heredocs, shell chains, and ambiguous invocations are not speculative execution surfaces. Unsupported code follows normal finalized execution.

### Assertion preflight

`kernel.assertPreflight.enabled` checks a restricted source-local subset against bounded, read-only file snapshots. It can detect the first failing anchor assertion while a later replacement literal is still being generated:

```bash
python <<'PY'
from pathlib import Path
p = Path("/absolute/path/to/source.py")
text = p.read_text()
old = "expected original text"
assert text.count(old) == 1
new = "replacement text"
text = text.replace(old, new)
p.write_text(text)
PY
```

If the count assertion fails, generation is interrupted before the rest of the cell is needed. The partial assistant turn is discarded from active context, a diagnostic identifies the failing line and observed/expected count, and the agent continues to correct the assumption. Neither `str.replace()` nor `write_text()` is executed by preflight. A successful check does not commit anything or bypass the assertion during normal execution.

Supported Python inputs include source-local `from pathlib import Path` / `import pathlib`, literal path construction, `read_text()` with UTF-8, explicit `builtins.open` imports for read-only `.read()`, string/integer assignments, and `assert text.count(old) == expected`. JavaScript supports explicit `node:fs` reads with UTF-8 and the corresponding `text.split(old).length - 1` check through `console.assert` or an explicitly imported `node:assert` function. These are source-local checks, not inspection of arbitrary retained kernel objects.

Safety boundaries:

- Prior-cell variables, inherited bare `Path`/`open` bindings, dynamic paths, unknown calls/imports, control flow, and mutations are not evaluated. Unsupported dependencies stop downstream checking rather than guess their values.
- Relative literal paths require an explicit absolute tool/session working directory; preflight never guesses from the host process working directory. Cached observations are isolated by session, call, source, and working directory.
- Only regular, bounded UTF-8 files are read. Symlink file targets, devices/FIFOs, binary content, and changed snapshots are skipped; failed observations are revalidated before being reported.
- Limits: 1 MiB source, 8 MiB file, 64 KiB literal, 4,096 statements, and 16 MiB cumulative count work. Partial JSON scanning is capped at 4 MiB.
- An incomplete string/assertion cannot itself be evaluated. An unfinished later literal does not hide an earlier complete failing assertion.
- Late results cannot interrupt a completed call, a new prompt generation, or a disposed session. A preceding sibling tool call prevents assertion interruption because it could change the file before the checked cell would run.

Preflight reports a check against the current file snapshot and supported language subset; it is not a proof of the eventual cell's behavior under arbitrary imports, monkeypatches, or concurrent filesystem changes. Keep normal assertions and stale-write protection in place.

## End-to-end tool-call pipeline

## 1) Input handling and parameter merge

`BashTool.execute()` currently handles input as follows:

- validates optional `env` names against shell-variable syntax,
- extracts a leading single-line `cd <path> && ...` into `cwd` when `cwd` was not supplied, unless the path needs shell expansion,
- rejects `async: true` when `async.enabled` is false,
- defaults `timeout` to 300 seconds; `0` explicitly disables the command deadline.

There are no structured `head` or `tail` parameters. Before execution, internal URLs in the command and environment values are expanded to backing filesystem paths; an internal URL used as `cwd` is also resolved. Expansion can create parent directories for writable `local://` paths. The configured direnv/devenv preflight can then merge project environment changes, with explicit `env` values taking precedence.

## 2) Optional interception (blocked-command path)

If `bashInterceptor.enabled` is true, `BashTool` loads rules from settings (`getBashInterceptorRules()`) and runs `checkBashInterception()` against the command — checking both the original and the cwd-normalized form (after a leading `cd … &&` is extracted) when they differ. Rule syntax is unchanged: each rule checks the complete input first, then raw flat command fragments separated by unquoted/unescaped `&&`, `||`, `;`, `|`, `|&`, `&`, or newlines, then those fragments with leading `NAME=value` assignments removed. Fragments that receive piped stdin from `|` or `|&` are excluded from the fragment candidates, including across blank/comment continuation lines, because a stdin-consuming stage cannot be replaced by a path-based dedicated tool.

Interception behavior:

- command is blocked **only** when:
  - regex rule matches, and
  - the suggested tool is present in `ctx.toolNames`.
- invalid regex rules are silently skipped.
- on block, `BashTool` throws `ToolError` with message:
  - `Blocked: ...`
  - original command included.
- heredocs, parameter expansion, command substitutions, backticks, grouping, and malformed quoting do not produce extra fragments; they retain only the complete-input check. Interception is best-effort routing to dedicated tools, not a shell-security policy.

Default rule patterns (defined in code) target common misuses:

- file readers (`cat`, `head`, `tail`, ...)
- search tools (`grep`, `rg`, ...)
- file finders (`find`, `fd`, ...)
- in-place editors (`sed -i`, `perl -i`, `awk -i inplace`)
- shell redirection writes (`echo ... > file`, heredoc redirection)

### Caveat

`InterceptionResult` includes `suggestedTool`, but `BashTool` currently surfaces only the message text (no structured suggested-tool field in `details`).

## 3) CWD validation and timeout resolution

`cwd` is resolved relative to session cwd (`resolveToCwd`), then validated via `stat`:

- missing path -> `ToolError("Working directory does not exist: ...")`
- non-directory -> `ToolError("Working directory is not a directory: ...")`

The default timeout is 300 seconds. `timeout: 0` disables the deadline. Other values are clamped to `[1, 3600]` seconds and by a positive `tools.maxTimeout` ceiling; a clamp notice and both requested/resolved values are recorded when they differ.

## 4) Artifact allocation

Before execution, the tool allocates an artifact path/id (best-effort) for truncated output storage.

- artifact allocation failure is non-fatal (execution continues without artifact spill file),
- artifact id/path are passed into execution path for full-output persistence on truncation.

## 5) PTY vs non-PTY execution selection

PTY eligibility is decided by `canUseInteractiveBashPty(pty, ctx)` (`src/tools/bash-pty-selection.ts`); the local PTY overlay runs only when all are true:

- tool input `pty === true`
- `PI_NO_PTY !== "1"`
- tool context has UI (`ctx.hasUI === true` and `ctx.ui` set)

If `pty` is requested but unavailable, the call falls back to non-PTY and appends a `pty requested but unavailable …` notice.

Before the local PTY/non-PTY choice, a foreground (`async: false`) call can route to a managed background job (auto-backgrounding; see below) or — when the session's client advertises a terminal capability (`clientBridge.capabilities.terminal` + `createTerminal`, with `pty` false) — to a **client-bridge editor terminal** that runs the command remotely (streaming `terminalId` updates, killing on timeout, mapping a signal kill to exit code `137`). Otherwise it uses non-interactive `executeBash()`.

That means print mode and non-UI RPC/tool contexts always use non-PTY.

## Non-interactive execution engine (`executeBash`)

## Shell session reuse model

`executeBash()` caches native `Shell` instances in a process-global map keyed by:

- shell path,
- configured command prefix,
- snapshot path,
- serialized shell env,
- optional agent session key,
- minimizer configuration.

Session-level bang-command executions pass `sessionKey: this.sessionId`.

Tool-call executions pass `sessionKey: this.session.getSessionId?.()`, when available. In both surfaces, a session key isolates shell reuse per session; without one, reuse falls back to shell config/snapshot/env.
Concurrent calls never share one `Shell`: the native session runs one command at a time and `Shell.abort()` kills every in-flight run on it. `executeBash()` tracks in-flight keys in `shellSessionsInUse`; while a key is busy, overlapping calls skip the cache and run through one-shot `executeShell()` (same isolation as quarantined sessions). Only the owning call releases the in-use flag or deletes the cached session in its `finally`.

## Bundled `jq` compatibility

Unless `PI_DISABLE_UUTILS_BUILTINS` is truthy, the non-PTY native shell registers a bundled `jq` command backed by vendored [jaq](https://github.com/01mf02/jaq), not the system `jq`. Setting that flag disables the in-process uutils command set and falls back to system binaries. The bundled jaq errors when chained access indexes through a null or missing intermediate: `.a.b` over `{}` exits 5, whereas jq returns `null`.

Guard the access with `[.a.b?][0]` when the parent may be null or absent. The `?` suppresses jaq's traversal error (jq never raises it), and `[…][0]` maps the suppressed empty output to `null` while preserving a legitimate `false` or `null` value:

```jq
{"c": [.a.b?][0]}
```

Avoid the naive `.a.b? // null`: `//` treats a legitimate `false` (and `null`) as absent, so it silently rewrites boolean data to the fallback. It also diverges on parse — `{"c": .a.b? // null}` is accepted by jaq but is a syntax error in jq (the value needs parentheses: `{"c": (.a.b? // null)}`).

## Shell config, direnv, and snapshot behavior

At each call, the executor loads settings shell config (`shell`, `env`, optional `prefix`) and runs `applyDirenvPreflight()`.

Unless `bash.direnv` is `"off"`, preflight attempts to load the cwd's direnv/devenv changes within `bash.direnvLoadTimeoutMs`, additionally bounded by a positive command timeout. Direnv-provided variables are merged below explicit caller `env`; safe variables removed by direnv are prepended as `unset -v ...`. ACP-terminal and PTY routes run the same preflight before their backend; the non-PTY executor runs it internally.

If the selected shell includes `bash`, it attempts `getOrCreateSnapshot()`:

- snapshot captures aliases/functions/options from user rc,
- snapshot creation is best-effort,
- failure falls back to no snapshot.

If `prefix` is configured, it wraps the command after any direnv unset prefix.

The per-command child environment is then built by `buildNonInteractiveEnv()` (`src/exec/non-interactive-env.ts`), which layers non-interactive hardening defaults **under** the caller and direnv overrides:

- pagers disabled (`PAGER=cat`, `GIT_PAGER=cat`, … and `LESS=FRX`),
- editor prompts disabled (`GIT_EDITOR=true`, `EDITOR=true`, `VISUAL=true`),
- terminal/credential prompts reduced (`TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS=/usr/bin/false`, `NO_COLOR=1`, `CI=true` unless `PI_BASH_NO_CI`/`CLAUDE_BASH_NO_CI` is set),
- package-manager/tooling automation flags for non-interactive behavior (npm/pnpm/yarn/pip/cargo/terraform/gh, …),
- on Windows, UTF-8 locale/codepage defaults are added when absent.

## Streaming and cancellation

`Shell.run()` streams chunks to `OutputSink` and optional `onChunk` callback.

Cancellation:

- aborted signal triggers `shellSession.abort(...)`,
- timeout from native result is mapped to `cancelled: true` + annotation text,
- explicit cancellation similarly returns `cancelled: true` + annotation.

No exception is thrown inside executor for timeout/cancel; it returns structured `BashResult` and lets caller map error semantics.

## Interactive PTY path (`runInteractiveBashPty`)

When PTY is enabled, tool runs `runInteractiveBashPty()` which opens an overlay console component and drives a native `PtySession`.

Behavior highlights:

- xterm-headless virtual terminal renders viewport in overlay,
- keyboard input is normalized (including Kitty sequences and application cursor mode handling),
- `esc` while running kills the PTY session,
- terminal resize propagates to PTY (`session.resize(cols, rows)`).

Unlike the non-PTY engine, the interactive PTY path does **not** apply the non-interactive hardening. It inherits the user's environment and sets a real `TERM=xterm-256color` (applied as an override on the Rust side) so editors, pagers, and TUIs behave like a normal terminal.

PTY output is normalized (`CRLF`/`CR` to `LF`, `sanitizeText`) and written into `OutputSink`, including artifact spill support.

On PTY startup/runtime error, sink receives `PTY error: ...` line and command finalizes with undefined exit code.

## Output handling: streaming, truncation, artifact spill

Both PTY and non-PTY paths use `OutputSink`.

## OutputSink semantics

The bash executor builds the sink with `headBytes` and `maxColumns` from settings (`resolveOutputSinkHeadBytes` / `resolveOutputMaxColumns`).

- keeps a UTF-8-safe rolling **tail** window (`spillThreshold`, `DEFAULT_MAX_BYTES`, currently 50KB); on overflow it trims to the tail (UTF-8 boundary safe) and marks `truncated`,
- when `headBytes > 0` (`tools.artifactHeadBytes`, default 20KB) it also retains a **head** window and elides the middle, splicing an elision marker between head and tail in `dump()`,
- per-line column cap: when `maxColumns > 0` (`tools.outputMaxColumns`, default 768 bytes) over-wide lines are ellipsis-truncated at write time and the rest of the line is dropped,
- tracks total bytes/lines seen,
- mirrors the **raw, uncapped** stream to the artifact file when output overflows, a column cap dropped bytes, or the file is already active,
- marks `truncated` on tail overflow, middle elision, column-cap drops, or file spill.

`dump()` returns:

- `output` (possibly annotated prefix),
- `truncated`,
- `totalLines/totalBytes`,
- `outputLines/outputBytes`,
- `elidedBytes/elidedLines` when the middle was elided,
- `columnDroppedBytes/columnTruncatedLines` when the per-line cap fired,
- `artifactId` if artifact file was active.

### Long-output caveat

Runtime truncation is byte-threshold based in `OutputSink` (50KB tail window by default, plus an optional head window for middle elision). It does not enforce a hard line-count cap in this code path.

### Shell output minimizer

Non-PTY execution also passes shell-minimizer settings into the native `Shell` session. When the minimizer rewrites verbose output, the executor replaces the sink's visible text with the minimized text and, when possible, saves the raw original capture as a separate `bash-original` artifact referenced by a `[raw output: artifact://<id>]` footer.

## Live tool updates and async jobs

For non-PTY foreground execution, `BashTool` uses a separate `TailBuffer` for partial updates and emits `onUpdate` snapshots while command is running.

For PTY execution, live rendering is handled by custom UI overlay, not by `onUpdate` text chunks.

When `async.enabled` is true and the call passes `async: true`, `BashTool` starts a managed bash job immediately, returns a running result with a job id, and stores completion through the session job manager. Auto-backgrounding can also use this path after `bash.autoBackground.thresholdMs`; it is skipped for PTY and client-bridge terminal routes and falls back to foreground execution when the job manager is at capacity. A queued steering message can background a still-running auto-background candidate early.

## Result shaping, metadata, and error mapping

After execution:

1. A cancellation or missing exit status throws a tool error. The client-bridge
   terminal route also throws `ToolError` for timeout before structured result
   shaping.
2. Local non-PTY and interactive-PTY timeouts return an error result with
   `details.timedOut = true` so the renderer can distinguish them from an
   ordinary failure.
3. Empty output becomes `(no output)`.
4. A final inline byte cap protects routes that bypass `OutputSink`; it reuses the sink artifact when available or saves a `bash-original` artifact.
5. Truncation metadata is attached from the sink summary.
6. A nonzero exit returns an error result with `details.exitCode`; zero returns success.

Result details can also include resolved/requested timeout, `timeoutDisabled`, client `terminalId`, wall time, async job state, and truncation metadata. Truncation includes direction/reason, total and shown line/byte counts, shown range, and `artifactId` when persistence succeeded.

Built-in tool wrapping appends the model-facing recovery notice automatically, for example `Read artifact://<id> for full output`.


### Structured execution metadata

`details.execution` is authoritative and is rendered before command output. It is independent of output wording:

- `state` is `running`, `exited`, or `unknown`.
- `exitCode`, `signal`, and `elapsedMs` are included only when observed; timeout/cancellation never fabricates an exit code or signal.
- `timeout` records `cause`, `scope`, and requested/effective milliseconds when known. Bash deadlines use `cause: "deadline"`, `scope: "command"`.
- `collector` records output collection separately (`running`, `complete`, `failed`, or `unavailable`), including a collector error without changing process state.
- `output` distinguishes `complete`, `truncated`, `summarized`, and `unavailable`; truncation carries counts and an artifact id when persistence succeeded.

A line such as `timeout: 60` or `all checks passed` is data, not lifecycle evidence. Consumers MUST use structured execution metadata and MUST NOT infer success, failure, or timeout from stdout/stderr text. Raw captured output remains in the artifact when spill succeeds; replayed bash/python execution messages retain the execution metadata alongside the output.
## Rendering paths

## Tool-call renderer (`bashToolRenderer`)

`bashToolRenderer` is used for tool-call messages (`toolCall` / `toolResult`):

- collapsed mode shows visual-line-truncated preview,
- expanded mode shows all currently available output text,
- warning line includes truncation reason and `artifact://<id>` when truncated,
- timeout value (from args) is shown in footer metadata line.

### Caveat: full artifact expansion

`BashRenderContext` has `isFullOutput`, but current renderer context builder does not set it for bash tool results. Expanded view still uses the text already in result content (tail/truncated output) unless another caller provides full artifact content.

## User bang-command component (`BashExecutionComponent`)

`BashExecutionComponent` is for user `!` commands in interactive mode (not model tool calls):

- streams chunks live,
- collapsed preview keeps last 20 logical lines,
- line clamp at 4000 chars per line,
- shows truncation + artifact warnings when metadata is present,
- marks cancelled/error/exit state separately.

This component is wired by `CommandController.handleBashCommand()` and fed from `AgentSession.executeBash()`.

## Mode-specific behavior differences

| Surface                        | Entry path                                            | PTY eligible                                          | Live output UX                                                           | Error surfacing                                  |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Interactive tool call          | `BashTool.execute`                                    | Yes, when `pty=true` and UI exists and `PI_NO_PTY!=1` | PTY overlay (interactive) or streamed tail updates                       | Tool errors become `toolResult.isError`          |
| Print mode tool call           | `BashTool.execute`                                    | No (no UI context)                                    | No TUI overlay; output appears in event stream/final assistant text flow | Same tool error mapping                          |
| RPC tool call (agent tooling)  | `BashTool.execute`                                    | Usually no UI -> non-PTY                              | Structured tool events/results                                           | Same tool error mapping                          |
| Interactive bang command (`!`) | `AgentSession.executeBash` + `BashExecutionComponent` | No (uses executor directly)                           | Dedicated bash execution component                                       | Controller catches exceptions and shows UI error |
| RPC `bash` command             | `rpc-mode` -> `session.executeBash`                   | No                                                    | Returns `BashResult` directly                                            | Consumer handles returned fields                 |

## Operational caveats

- Interceptor only blocks commands when suggested tool is currently available in context.
- If artifact allocation fails, truncation still occurs but no `artifact://` back-reference is available.
- Shell session cache has no explicit eviction in this module; lifetime is process-scoped.
- Timeout shaping is backend-specific: local non-PTY and interactive-PTY timeouts return error results with `details.timedOut`; the client-bridge terminal creation/execution timeout paths throw `ToolError`. Non-timeout cancellations throw across these tool-call routes.

## Implementation files

- [`src/tools/bash.ts`](../packages/coding-agent/src/tools/bash.ts) — tool entrypoint, input handling/interception, async and PTY/non-PTY selection, result/error mapping, bash tool renderer.
- [`src/tools/bash-pty-selection.ts`](../packages/coding-agent/src/tools/bash-pty-selection.ts) — `canUseInteractiveBashPty` predicate for choosing the local PTY overlay.
- [`src/tools/bash-interceptor.ts`](../packages/coding-agent/src/tools/bash-interceptor.ts) — interceptor rule matching and blocked-command messages.
- [`src/tools/bash-skill-urls.ts`](../packages/coding-agent/src/tools/bash-skill-urls.ts) — internal-URL expansion for commands, env values, and cwd.
- [`src/exec/bash-executor.ts`](../packages/coding-agent/src/exec/bash-executor.ts) — non-PTY executor, shell session reuse, cancellation wiring, output sink integration.
- [`src/exec/non-interactive-env.ts`](../packages/coding-agent/src/exec/non-interactive-env.ts) — non-interactive child-process env defaults (`buildNonInteractiveEnv`) used by the non-PTY executor.
- [`src/exec/direnv.ts`](../packages/coding-agent/src/exec/direnv.ts) — direnv/devenv environment loading used by executor preflight.
- [`src/tools/bash-interactive.ts`](../packages/coding-agent/src/tools/bash-interactive.ts) — PTY runtime, overlay UI, input normalization, and interactive `TERM` setup.
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink`, `TailBuffer`, truncation/artifact spill, and summary metadata.
- [`src/tools/output-meta.ts`](../packages/coding-agent/src/tools/output-meta.ts) — truncation metadata shape + notice injection wrapper.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — session-level `executeBash`, message recording, abort lifecycle.
- [`src/modes/components/bash-execution.ts`](../packages/coding-agent/src/modes/components/bash-execution.ts) — interactive `!` command execution component.
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — wiring for interactive `!` command UI stream/update completion.
- [`src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts) — RPC `bash` and `abort_bash` command surface.
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://<id>` resolution.
