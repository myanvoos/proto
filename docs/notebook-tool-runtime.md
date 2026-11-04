# Notebook file runtime internals

This document describes current `.ipynb` handling in `coding-agent` and its relationship to native Python execution and optional explicit warm kernels. The Python execution overhaul is **unreleased**; notebook file conversion/editing is unchanged.

The critical distinction: **notebook support is file conversion/editing, not notebook execution**. `.ipynb` files are exposed as editable cell-marked text through `read` and the edit pipeline; no notebook-specific tool starts or talks to a Python kernel.

## Implementation files

- [`src/edit/notebook.ts`](../packages/coding-agent/src/edit/notebook.ts)
- [`src/edit/read-file.ts`](../packages/coding-agent/src/edit/read-file.ts)
- [`src/tools/read.ts`](../packages/coding-agent/src/tools/read.ts)
- [`src/eval/py/harness-bridge.ts`](../packages/coding-agent/src/eval/py/harness-bridge.ts) — Authenticated explicit Python host integration.
- [`src/eval/py/executor.ts`](../packages/coding-agent/src/eval/py/executor.ts)
- [`src/eval/py/kernel.ts`](../packages/coding-agent/src/eval/py/kernel.ts)
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts)

## 1) Runtime boundary: editing vs executing

## `.ipynb` file conversion (`src/edit/notebook.ts`)

- `read` treats `.ipynb` files as notebooks unless the selector is `:raw`.
- The default notebook view is editable text with markers:
  - `# %% [code] cell:N`
  - `# %% [markdown] cell:N`
  - `# %% [raw] cell:N`
- Line selectors and multi-range selectors operate on that virtual text.
- The edit pipeline round-trips virtual text back to notebook JSON through `serializeEditedNotebookText(...)`.
- Existing notebook metadata is preserved when a marker references an existing unused `cell:N`; new cells get fresh empty metadata.
- A missing notebook passed to the serializer starts from an empty nbformat 4.5 notebook.
- Shell-level writes (`bash`, a Bash kernel cell's `write()`) are not notebook-aware: they replace the file with the supplied bytes. Use them only with valid notebook JSON, not the virtual marker representation.

No kernel lifecycle exists in this path:

- no kernel session ID
- no code execution
- no stream chunks from Python
- no rich display capture
- no output artifact pipeline from execution

## Python execution path (separate from notebook editing)

A Bash invocation such as `python <<'PY' ... PY`, `python -c '...'`, or `python script.py` runs an ordinary **fresh Python process**. It does not implicitly submit a cell to a persistent kernel. `import proto_harness as harness` explicitly accesses host tools, safe filesystem operations, rich displays, artifacts and model/agent APIs; `harness.store` persists session-owned rich graph values across fresh invocations.

For a warm namespace, use `harness.kernel("notebook").run(code)` / `.exec(file)` or `python -m proto_harness.kernel notebook -c '...'`. The warm namespace must also import the library explicitly; there are no injected helper globals or IPython magic/reset contract. None of these execution surfaces reads/writes notebook outputs or execution counts automatically. See [Python APIs](./python-repl.md) and [explicit named kernels](./bash-tool-runtime.md#explicit-named-python-kernels).

## 2) Notebook cell handling semantics

## Source normalization

Notebook JSON `source` is converted to virtual text by joining source arrays. When virtual text is serialized back, cell source is split with newline preservation:

- each line ending in `\n` stays as a separate source entry with the newline
- a final non-newline-terminated line is stored without forcing a trailing newline
- empty content becomes an empty `source` array

This mirrors notebook JSON conventions and avoids accidental line concatenation on later edits.

### Marker-like source escaping

A source line that itself looks like a cell marker is escaped on render by adding one `%` (`# %% ...` becomes `# %%% ...`) and unescaped on parse. Already escaped marker-like lines gain and lose one additional `%` the same way. This prevents literal marker text inside a cell from being misparsed as a new cell during round-trip editing.

## Marker parsing and cell preservation

- A non-empty representation must start with a marker; text before the first marker, including a blank line, is rejected. Empty text serializes to a notebook with no cells.
- Markers must match `# %% [code|markdown|raw]` with optional `cell:N`.
- If `cell:N` points at an unused existing cell, that cell is cloned, its `cell_type` and `source` are updated, and unrelated fields are preserved.
- Existing code-cell `execution_count` and `outputs` are preserved rather than cleared; missing fields are initialized to `null` and `[]`.
- Markdown/raw cells remove `execution_count` and `outputs`.
- If no valid unused original index is present, a new cell with empty metadata is created.
- Notebook-level metadata, format fields, and unrelated top-level fields survive because serialization clones the original document and replaces only `cells`.

## Error surfaces

Hard failures are thrown for:

- missing notebook on read
- invalid JSON
- missing/non-array `cells`
- invalid cell objects or cell types
- invalid editable representation (for example, text before the first cell marker)

These surface through notebook-aware callers such as `read` and the edit pipeline as normal tool errors. The standalone `write` path does not parse notebook JSON.

## 3) Explicit warm namespace semantics

Ordinary Python commands and the fresh `executePython` API do not retain globals. There is no `python.kernelMode` session/per-call switch. Persistence is an explicit product choice:

- `harness.store` commits one session-owned rich mapping graph with revision CAS. Assignment/deletion commits; nested in-place mutations need `commit()` or a transaction batch. Stale concurrent writers fail without overwrite/retry.
- `harness.kernel(name, interpreter=None, cwd=None, target=None)` selects an optional owner-scoped warm namespace. Its `run(code)` and `exec(file)` execute in order; native persistent imports remain cached until deliberately reloaded/restarted.
- `status()` reports the actual environment/lifecycle/residency. `stop()` and `restart()` intentionally discard that namespace; they do not change notebook files or other language runtimes. There is no `%reset` or prelude reinjection API.
- Warm namespaces automatically capture the whole supported Python graph at exact durable continuity boundaries, including aliases, cycles, functions, closures, classes and module metadata. Unsupported live resources refuse capture before destructive transitions. Durable parking/host restart restores exact compatible manifests, not a recent/older/fresh approximation.
- Errored/interrupted cells are **not replayed automatically**. Definitions, mutations and external effects completed before failure may remain; inspect them before retrying. Process loss after an uncaptured mutation refuses silent state substitution.

See [session state boundaries](./session-operations.md#declared-state-at-temporal-boundaries) and [residency policy](./interactive-memory.md#interpreters-subprocesses-and-provider-state). Python's 64 MiB **encoded graph payload** limit is distinct from JavaScript's unchanged 16 MiB selected-data codec. Neither is notebook JSON editing policy.

## 4) Host integration and execution environment

The managed agent shell makes the explicit `proto_harness` package available through a tiny authenticated bootstrap, without modifying installed Python. Native `-I`, `-E`, `-S` flags remain opt-outs. Helpers remain bound to their owning run/session and canonical tool authority; user code cannot choose another session's capability. Ordinary Python `Path`/`open` use native executing-target filesystem semantics; `harness.fs` and path-taking source helpers use permission-checked host filesystem operations.

Warm kernels execute in the selected interpreter/cwd/target environment. They do not fake fresh imports between submissions. Ordinary synchronous cells preserve native `asyncio.run()`; explicit top-level await is supported. Live retained tasks/threads have process lifetime and prevent safe durable capture. These runtime choices do not alter `.ipynb` parsing, cell markers, metadata preservation or serialization.

## 5) Streaming/chunk and display handling (kernel-backed path)

The Python backend uses an NDJSON subprocess runner. The host processes frames per execution:

- `stdout` / `stderr` -> text chunks to `onChunk`
- `display` / `result` -> MIME bundle rendering
- `error` -> traceback text and structured error metadata
- `done` -> final status, execution count, cancellation state

Display text MIME precedence:

1. `text/markdown`
2. `text/plain`
3. converted `text/html`

Structured outputs captured separately include:

- `application/json` -> JSON display output
- `image/png` / `image/jpeg` -> image output
- `application/x-proto-status` -> status event

Cancellation/timeout:

- abort/timeout sends `SIGINT` to the runner
- if the runner does not settle after the interrupt grace window, shutdown escalates; no cell is silently replayed, and uncaptured state cannot silently fall back to an older or fresh namespace
- timeout output is annotated with a timeout message

## 6) Truncation and artifact behavior

`OutputSink` in `src/session/streaming-output.ts` is used by kernel execution paths:

- sanitizes every chunk
- tracks total/output lines and bytes
- optionally spills full output to an artifact file
- keeps a UTF-8-safe in-memory tail buffer when output exceeds the configured threshold

The Bash tool converts this metadata into result truncation notices and TUI warnings.

Notebook file conversion does **not** use `OutputSink`; it has no stream/artifact truncation pipeline because it does not execute code.

## 7) Renderer assumptions and formatting

## Read/edit notebook representation

Notebook files are rendered to the model as text. The visible cell markers are part of the editable representation, not comments that are ignored during serialization.

## Python renderer (for actual execution output)

Kernel-backed execution rendering expects:

- per-cell status transitions (`pending` / `running` / `complete` / `error`)
- optional structured status events
- optional JSON output trees
- image outputs
- truncation warnings + optional `artifact://<id>` pointer

This renderer behavior is unrelated to notebook JSON editing except that both reuse shared TUI primitives.

## 8) Practical workflow

If a workflow needs both notebook mutation and execution:

1. read the `.ipynb` file in its default editable view and mutate that view with the edit pipeline
2. execute desired source in a normal Bash Python heredoc/`python -c` for a fresh process, or explicitly submit it to `harness.kernel("notebook")` / `python -m proto_harness.kernel notebook` for warm state
3. repeat using the same explicit kernel name when later cells depend on globals; use `harness.store` for durable values shared across fresh processes
4. apply later source changes through the edit pipeline; a whole-file `write` must contain notebook JSON

Current implementation does not provide a single tool that both mutates `.ipynb` and executes notebook cells through kernel context.
