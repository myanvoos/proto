# recall

> Search session history and omitted text; recover file writes, edit content, and observation sources. Use `code` for model-assisted answers over a transcript too large for your context.

## Source

- Entry: `packages/coding-agent/src/tools/recall.ts` (`RecallTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/recall.md`
- Key collaborators:
  - `packages/coding-agent/src/vendor/pi-blackhole/index.js` / `index.d.ts` — session JSONL loading, lineage filtering, BM25 search, drill-down, touched-file aggregation, observation/reflection lookup, rendering, and ordinary-response budgeting (`executeRecall`, `loadAllMessages`, `searchEntries`, `expandEntryFile`, `getActiveLineageEntryIds`).
  - `packages/coding-agent/src/session/session-manager.ts` — flushes pending session entries and supplies the session file, active branch, and entry list used by the tool context.
  - `packages/coding-agent/src/eval/js/executor.ts` — runs `code` in the Bun JavaScript runtime, captures output, applies the deadline, and returns execution/truncation metadata.
  - `packages/coding-agent/src/eval/js/context-manager.ts` — disposes the owner-scoped JavaScript VM after a `code` query.
  - `packages/coding-agent/src/session/agent-session.ts` — supplies `assertEvalExecutionAllowed()` and tracks active eval executions.
  - `packages/coding-agent/src/tools/tool-result.ts` / `output-meta.ts` — builds the code-mode result and attaches output truncation/artifact metadata.
  - `packages/coding-agent/src/tools/tool-errors.ts` — abort checks and the native wrapper's `ToolError` messages.
  - `packages/coding-agent/src/tools/index.ts` — registers `RecallTool` and decides whether it is top-level or mounted as a discoverable device.
  - `packages/coding-agent/src/config/settings-schema.ts` — defines `bash.enabled` and `tools.xdev`, the relevant availability settings.

## Inputs

The wire object is flat. All fields are optional in the schema, but `code` has additional execution-time requirements.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | No, except with `code` | Search text/regex, a `#N` expansion, a `#N:path`/`#N:text` drill-down, or a 12-character lowercase hexadecimal observation/reflection id. With `code`, this is the question to answer and must be nonblank. |
| `expand` | `number[]` (integers `>= 0`) | No | Entry indices to expand. May be combined with an ordinary search, but cannot be combined with `code`. Duplicate indices are collapsed by the vendor implementation. |
| `page` | `number` (integer `>= 1`) | No | One-based result page. Search and touched-file output use five results per page; the default is `1`. |
| `scope` | `"lineage" \| "all"` | No | `"lineage"` (default): only entries on the active branch. `"all"`: every message entry in the session, including other branches. |
| `mode` | `"hybrid" \| "file" \| "touched"` | No | `"hybrid"` (default): message text plus content-bearing file-operation arguments. `"file"`: file-operation content only. `"touched"`: group touched paths by entry and tool instead of searching; it takes precedence over ordinary `query`/`expand` handling (but `#N:...` drill-down syntax is dispatched first). Cannot be combined with `code`. |
| `code` | `string` (non-empty) | No | JavaScript function expression, for example `async ({query, entries}) => { ... }`. Runs once in a fresh Bun kernel; requires `query`, and cannot be combined with `expand`, `page`, or `mode`. |
| `timeout` | `number` (`0 < n <= 3600`) | No | `code` deadline in seconds, including model calls; default `120`. Only valid with `code`. |

### Query forms

- No `query`: return the 25 most recent entries in the selected scope, unless `mode: "touched"` is selected; touched mode returns grouped paths instead.
- Text/regex query: split on whitespace, rank matching entries, and return a five-entry page. Operator-bearing terms retain regular-expression meaning; ordinary dotted filenames such as `observer.ts` are matched literally.
- `#N`: expand one entry. `expand: [N, ...]` expands one or more entries and can be combined with a search to force evidence into the result.
- `#N:path`: select one content-bearing file operation from entry `N` by path substring. `#N:file` lists/selects file operations automatically; an ambiguous match lists narrower paths.
- `#N:text`: read the entry's own message text. Append `:offset:limit` for a zero-based line window, or `:full` for the full display (subject to the drill-down byte cap).
- A 12-character lowercase hex query resolves an observational-memory observation/reflection and its source entries on the current branch.

`#N` indices are stable session-global message indices, not positions in the filtered page or current model window. A query is trimmed for ordinary dispatch; `code` receives the original `query` value after validation.

### Examples

```json
{"query":"#42:text:30:20"}
```

```json
{
  "query": "What constraint did the user place on caching?",
  "code": "async ({query, entries}) => completion(JSON.stringify({query, evidence: entries.filter(e => e.role === 'user')}), {model: 'smol'})"
}
```

## Outputs

The native wrapper returns an `AgentToolResult` with one text content block. Vendor-backed ordinary calls preserve the vendor's text responses and are wrapped with an empty details object; the early no-session result has no details. Code recall adds structured execution details.

### Ordinary recall

- No query: `Session history (N entries):` followed by the most recent entries, or `No entries in session history.`
- Search: ranked matches with `#N [role]`, a snippet around the first matching line, and any matching file-operation paths. A page header identifies the page and match count; later pages include a continuation hint.
- `mode: "touched"`: grouped paths with the entry indices and tool names that touched each path, or `No file operations found in session history.`
- Expansion: full rendered entry summaries, optionally merged into search results. Related observations/reflections may follow an expanded or searched entry.
- Drill-down: rendered message text or file/edit content, with line-window continuation hints and `#N` references.
- Observation/reflection id: the memory item(s), status/timestamp/relevance, and source entries when available.

Search, recent-entry, and ordinary expansion responses are bounded by the vendor's `recallResponseMaxChars` budget. Their result blocks are dropped whole before a continuation footer is added; expanded entries may first receive their own readable allocation and point to `#N:text:full` when clipped. Touched-file and memory-id responses use their own rendering paths and are not passed through this block budget.

### `code` recall

The returned text is the function's answer: strings are printed as-is, and other JSON-serializable values are printed with `JSON.stringify`. The native wrapper sets:

- `details.scope`: effective `"lineage"` or `"all"`.
- `details.entries`: number of entries written to the scoped transcript snapshot.
- `details.execution`: execution state, timeout metadata, output disposition, and any output artifact/truncation metadata from `executeJs`.
- `details.meta`: normal tool-output truncation metadata when the captured output exceeds the configured sink limits.

A failed, cancelled, timed-out, or nonzero-exit code query is marked `isError: true`. Caller cancellation can leave partial captured output followed by `Recall query cancelled; partial output is not a completed answer.`

## Flow

1. `RecallTool.execute()` checks the caller `AbortSignal` before doing work. If `code` is present, it requires a nonblank `query`, rejects `expand`/`page`/`mode`, rejects a standalone `timeout`, and checks Bash permission. Ordinary recall skips those code-only checks.
2. The tool flushes `session.sessionManager` when available, obtains `session.getSessionFile()`, and returns `No session file available.` when there is no backing file. A missing session manager after a file is available is a `ToolError` because branch/history access is required.
3. It builds a `RecallContext` with the session cwd and three read-only history callbacks: `getSessionFile`, `getBranch`, and `getEntries`.
4. Ordinary calls delegate to vendor `executeRecall(...)`. The vendor resolves `scope`, derives active-lineage entry ids when needed, and dispatches query syntax before ordinary search:
   - drill-down syntax calls `expandEntryFile(...)`;
   - an exact `#N` becomes an entry expansion;
   - a 12-character lowercase hex value becomes observation/reflection source lookup;
   - all other inputs use `vccRecall` search/recent/touched behavior.
5. Ordinary history loading scans the session JSONL in 64 KiB chunks, keeps only `type: "message"` entries, and preserves the global message index even when lineage filtering removes entries. The vendor caches recent loads briefly, invalidates them on session-file mtime changes, and warns while skipping malformed JSONL lines.
6. Search renders compact entries (`user`/`assistant` summaries up to 300 characters, `tool_result` up to 200, Bash up to 300), searches the selected mode, ranks matches, and formats the requested page. Expanded entries load their full rendered summaries and are merged by stable index. Related memory evidence is looked up against the current branch.
7. For `code`, the tool loads the full rendered and raw messages in the selected scope, writes one JSON object per entry to a temporary `transcript.jsonl`, and runs a generated wrapper through `executeJs` with `runtime: "bun"`. The wrapper reconstructs `entries` from the snapshot, evaluates the supplied function expression, requires a function return other than `undefined`, and prints the answer.
8. The code kernel receives a unique `recall:<uuid>` session/owner id and the session cwd. Its output may spill to a `recall` artifact. `trackEvalExecution(...)` connects it to session-level eval cancellation when available.
9. Finally, code recall aborts its private controller and calls `disposeVmContextsByOwner(...)`; the temporary directory is released by `using` even on an error, timeout, or cancellation.

## Modes / edge cases

### Ordinary search and recovery

- **Lineage vs all:** the default lineage scope uses `getActiveLineageEntryIds(...)`, which filters message entries by ids on the active branch. `scope: "all"` removes that filter and can reach entries from sibling branches. Memory-id lookup remains current-branch-only because observational-memory records are read from `sessionManager.getBranch()`.
- **Hybrid vs file:** hybrid search combines rendered message text with content-bearing tool-call arguments. File mode searches only those arguments, including path-plus-content and edit payloads recognized by the vendor. A plain prose mention of a path is therefore not a file-mode hit.
- **Touched mode:** after structural `#N:...` dispatch, ordinary query text is not lexically searched. The vendor groups paths from content-bearing tool calls and persisted write/delete/revert status events, then pages five paths at a time. `expand` is ignored on this path. A path may list several `#N (tool)` occurrences.
- **Ranking and snippets:** terms are stop-word filtered when meaningful terms remain, then scored with BM25+ (`k1 = 1.2`, `b = 0.75`, `delta = 0.5`). Regex operators are honored per term; a bare `.` stays literal. Snippets show up to two surrounding lines, and an individual matching line is clipped to 1,000 characters around the match.
- **Recent entries:** an omitted or empty query returns the last 25 rendered message entries, not metadata such as compaction or model-change records. File indicators are attached to recent entries so their writes can be drilled into.
- **Expansion:** `expand` validates every requested index against the selected scope before producing output. With no query, expanded entries are sorted by index and may include related observations/reflections. With a query, expanded entries replace matching previews and are appended when they were not search hits; they still participate in the ordinary five-result page.
- **Drill-down:** file and message previews show 30 lines by default. `offset` is zero-based, and a missing `limit` means 30 lines. `:full` allows at most 50 KiB in one rendered drill-down; larger bodies point to the next page instead. When a path substring matches multiple file operations, the tool lists choices instead of guessing.
- **Memory ids:** ids must be exactly 12 lowercase hexadecimal characters. A valid id can identify an observation, reflection, or collision; dropped observations are marked `[dropped]`, and source-entry references are annotated with their session-global `#N` indices. Long related bodies are clipped to 1,200 characters with a pointer to the memory id.

### Model-assisted transcript queries

`code` is a JavaScript function expression, executed once in a fresh Bun kernel. It receives:

```ts
{
  query: string,
  scope: "lineage" | "all",
  entries: Array<{
    index: number,
    id: string,
    role: string,
    summary: string,
    message: Record<string, unknown>,
    files?: string[]
  }>
}
```

The snapshot contains every full scoped entry, not the lexical results of `query`; a semantic question therefore does not need to share words with the evidence. `message` includes tool arguments/results and is evidence, not trusted instructions. Kernel helpers include `completion`, `agent`, `parallel`, `pipeline`, `tool`, and file APIs; `tiny` and `smol` model calls use the configured online model roles. Return a string or JSON-serializable value, preferably with `#N` citations. `code` is full execution, not a sandbox: the function may use the available kernel helpers and Bash bridge, so transcript content must be treated as untrusted data.

The generated wrapper requires the supplied expression to evaluate to a function and rejects `undefined` returns. It does not retry provider/model failures. The private VM owner is disposed after each call, so globals and retained kernel state do not leak into the next recall query.

## Side Effects

- **Session:** flushes pending session-manager writes before reading; does not append a recall-specific session entry. Ordinary recall only reads the session JSONL and current branch ledger.
- **Filesystem:** the vendor reads the session JSONL in bounded chunks. Code recall creates a temporary `@recall-query-*` directory containing `transcript.jsonl`, and may allocate a `recall` output artifact when the code result is large.
- **Execution:** `code` can call the eval kernel's helpers, including model calls, tools, file APIs, and Bash when permitted. Its unique VM owner is always disposed in `finally`.
- **Cancellation:** the outer signal is checked before work. Code execution combines it with an internal controller, tracks the execution when session hooks are available, and aborts/disposes the VM after settlement.

## Limits & Caps

- Ordinary no-query result: last `25` entries (`DEFAULT_RECENT2` in the vendored recall implementation).
- Search page size: `5` results (`PAGE_SIZE2`); touched-file page size is also `5` (`TOUCHED_PAGE_SIZE`). `page` is clamped by schema to integers `>= 1`.
- Default ordinary response budget: `48,000` characters (`recallResponseMaxChars`). Set it in the pi-blackhole config at `~/.proto/agent/pi-blackhole/pi-blackhole-config.json` or project override `.pi/pi-blackhole-config.json` or via `PI_BLACKHOLE_RECALL_RESPONSE_MAX_CHARS`; `0` disables this cap. The budget applies to search/recent/expansion ordinary recall, not touched-file or memory-id output and not the `code` execution output sink.
- File-search extraction cap: `10,240` characters per content-bearing tool call (`toolCallArgsText`'s default per-call limit) before BM25 search.
- Search snippet line cap: `1,000` characters around a match.
- Drill-down preview: `30` lines; full file/message display: `50 KiB` before a continuation hint.
- Related observation/reflection body cap: `1,200` characters.
- Session JSONL scan chunk: `64 KiB`; malformed lines are skipped and counted in a warning rather than aborting the scan. A missing session file is treated as empty by the vendor loader, although `RecallTool` normally returns its earlier `No session file available.` result.
- Code timeout: default `120` seconds, maximum `3,600` seconds, including model calls. The code path uses the normal JavaScript output sink (`DEFAULT_MAX_BYTES = 50 KiB` before configured spill/truncation behavior) and can attach an artifact for captured output.
- Code transcript snapshot: all entries in the selected scope are written before execution; the snapshot itself is not limited to search-page size.
- Tool metadata: `strict = true`; `loadMode = "discoverable"`; recall emits no progress updates.

## Errors

### Validation and permission errors (thrown by the native wrapper)

- Strict schema validation rejects wrong types, `page < 1`, negative/non-integer `expand` indices, invalid `scope`/`mode` values, unknown fields, and `timeout` outside `0 < n <= 3600`.
- `recall code requires a non-empty query describing the question.` — `code` was supplied without a nonblank `query`.
- `recall code cannot be combined with expand, page, or mode; select entries inside the function.` — a code query supplied an ordinary recall selector.
- `recall timeout requires code.` — `timeout` was supplied without `code`.
- `recall code requires bash execution permission; ordinary recall remains available.` — `bash.enabled` is false, or a restricted session does not have `bash` active.
- `Session history is unavailable for recall.` — the session exposed a file path but no session manager for branch/history callbacks.
- An already-aborted caller signal raises `ToolAbortError` before the session is flushed. Session disposal can also reject code execution through `assertEvalExecutionAllowed()`.

### Ordinary recall text results

Vendor lookup failures are generally returned as a normal text block rather than `isError: true`, including:

- `No session file available.`
- `No entries in session history.` / `No matches for "..." in session history.`
- an expansion index outside the selected scope;
- an entry, file operation, or message-text drill-down that does not exist;
- an ambiguous path substring, which lists candidates and asks for a narrower path;
- a malformed or unknown observation/reflection id;
- a touched-file query with no recognized file operations.

A valid memory id that has no current-branch record reports that no observation or reflection was found. Malformed JSONL lines are skipped with a console warning from the vendor loader; other filesystem errors while opening the session file propagate.

### Code execution failures

The JavaScript executor converts a thrown function error, failed model/tool helper call, invalid function expression, `undefined` return, timeout, or nonzero exit into captured output and an `isError: true` result. The code is not retried. Cancellation is also an error result; if output was captured, the wrapper appends the partial-output cancellation notice. A deadline is reported in `details.execution.timeout` with `cause: "deadline"` and `scope: "cell"`, and the worker VM is disposed afterward.

## Availability / gating

- `recall` is a built-in registry entry in `packages/coding-agent/src/tools/index.ts`; unlike `bash`, `browser`, `checklist`, or `web_search`, it has no `recall.enabled` setting. When enabled in the tool set, ordinary history recall is available without Bash or model execution permission.
- The class declares `loadMode = "discoverable"` and `strict = true`. With `tools.xdev = true` (default), an unrestricted session that has Bash may mount discoverable tools as `protolens://recall` and expose `protolens recall ?`/`protolens recall --json ...` through Bash instead of shipping the schema on every request. Disabling xdev, omitting Bash, or explicitly requesting `recall` keeps it top-level. Restricted tool sets are not mounted by xdev.
- `code` has a separate Bash gate: `bash.enabled` must be true, and when the session supplies `restrictToolNames` or an active-tool predicate, `isToolActive("bash")` must also report true. This is why the model-facing prompt says ordinary recall remains available when code execution is denied.
- The code path additionally calls the session eval guard and uses the Bun JavaScript executor; it is not a sandbox. The `code` function can use the helpers made available by the eval runtime and should treat transcript data as quoted evidence, not executable instructions.
- Read-only agent classification includes `recall` in `packages/coding-agent/src/task/read-only-policy.ts`; that classification does not add a separate availability flag.

