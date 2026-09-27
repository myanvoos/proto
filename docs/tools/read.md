# read

> Read files, directories, archives, SQLite databases, internal resources, images, audio, video, documents, and URLs through `path`.

## Source
- Entry: `packages/coding-agent/src/tools/read.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/read.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/path-utils.ts` — split `path` from trailing selectors; prefer literal filenames; normalize local paths and recover accidental delimited path lists.
  - `packages/utils/src/ar/open.ts` / `packages/utils/src/ar/registry.ts` — parse archive-member paths, select readers, and open/list/read entries.
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — detect SQLite targets, parse selectors, render tables.
  - `packages/coding-agent/src/tools/fetch.ts` — URL parsing, fetch/render pipeline, and output-artifact persistence.
  - `packages/coding-agent/src/internal-urls/router.ts` — built-in internal-resource registry, including `ssh://` and `protolens://`; MCP may advertise additional schemes.
  - `packages/coding-agent/src/tools/notebook.ts` — convert `.ipynb` to editable `# %% [...] cell:N` text.
  - `packages/coding-agent/src/utils/cpuprofile.ts` / `sample-profile.ts` — summarize recognized profiler reports.
  - `packages/coding-agent/src/utils/file-display-mode.ts` — decide line-number vs raw display.
  - `packages/coding-agent/src/utils/image-loading.ts` / `media-loading.ts` — decode and bound media inputs.
  - `packages/coding-agent/src/workspace-tree.ts` — render directory trees.
  - `packages/coding-agent/src/tools/index.ts` — adds `ReadTool` in `createTools()` as the essential `read` tool.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Filesystem path, internal URL, or web URL. May end with a trailing selector such as `:50-100` or `:raw`. |

### Selector grammar

For normal file-like reads, `splitPathAndSel()` in `packages/coding-agent/src/tools/path-utils.ts` recognizes the final suffix only when it matches one of these forms:

| Suffix | Meaning |
| --- | --- |
| `:raw` | Raw/verbatim mode. Disables structural summaries and line prefixes. |
| `:conflicts` | Scan a local file for unresolved Git merge-conflict regions, register them in session conflict history, and render a compact `#N Lx-Ly` index. |
| `:N` / `:LN` / `:N-` / `:N..` | Start at 1-indexed line `N`, open-ended. |
| `:A-B` / `:LA-LB` / `:A..B` | Inclusive 1-indexed line range (`..` is a forgiving alias normalized to `-`). |
| `:A+C` / `:LA+LC` | `C` lines starting at `A`; tool converts this to end line `A + C - 1`. |
| `:R1,R2,...` | Multiple ranges, sorted and merged before reading (for example `:5-16,960-973`). |
| `:range:raw` or `:raw:range` | Same line selection, but raw output. |

Validation in `parseLineRangeChunk()`:
- line numbers are 1-indexed; `:0` throws.
- `+` counts must be `>= 1`.
- `-` end must be `>= start`.

Selector parsing intentionally falls through for unrecognized trailing `:...`; archive and SQLite paths consume their own colon syntax.

URL selectors are parsed separately in `packages/coding-agent/src/tools/fetch.ts`, but use the same line-range parser for `:raw`, `:N`, `:A-B`, `:A+C`, `:5-10,20-30`, and `:range:raw` / `:raw:range`. Because URL ports also use `:`, add a trailing slash before a selector on a host/port URL, e.g. `https://example.com/:80`.
Literal filesystem paths take precedence over selector interpretation, so an existing POSIX filename that ends in selector-looking text is read literally.

## Outputs
- Single-shot `AgentToolResult` built through `toolResult()` in `packages/coding-agent/src/tools/tool-result.ts`.
- `content` is usually one text block. Image reads may return `[text, image]`.
- `details` is path-dependent. `ReadToolDetails` may include:
  - `kind: "file" | "url"` (URL path uses `kind: "url"`; file reads usually omit `kind`)
  - `isDirectory`
  - `resolvedPath`
  - `suffixResolution`
  - URL fields: `url`, `finalUrl`, `contentType`, `method`, `notes`
  - `truncation`
  - `displayContent` (unprefixed text + starting line for TUI rendering)
  - `summary` (`lines`, `elidedSpans`, `elidedLines`) for structural summaries
  - `conflictCount` for `<path>:conflicts`
  - `displayReadTargets` when the tool recovered an accidental delimited list of paths for TUI display
  - `meta` from `packages/coding-agent/src/tools/output-meta.ts`
- `details.meta.source` is set to the backing path, URL, or internal URL.
- `details.meta.truncation` carries shown range, total lines/bytes, next offset, and optional `artifactId` for persisted URL output.
- Archive listings and SQLite table lists set `details.meta.limits` when their list caps trigger.

## Flow
1. `ReadTool.execute()` accepts `{ path }`. `file://...` inputs are expanded first with `expandPath()`. `conflict://<N>[/ours|theirs|base]` is handled before ordinary URLs; `conflict://*` is rejected.
2. It tries web URL handling via `parseReadUrlTarget()` from `packages/coding-agent/src/tools/fetch.ts`.
   - Plain URL reads call `executeReadUrl()`.
   - URL reads with line selectors fetch/render the current URL output, then paginate that rendered text locally (and request an output artifact).
3. It checks the internal URL router, including built-ins and MCP-advertised schemes.
   - `local://` resources backed by actual files are promoted into the local-file path so images, conversion, and selectors use filesystem handling.
   - `agent://` query extraction (`/path` or `?q=`) bypasses pagination and returns the extracted content directly.
   - `artifact://` uses a bounded file-backed reader rather than loading the full artifact.
   - Other internal resources are paginated in memory by `buildInMemoryTextResult()`.
4. It prefers an existing literal filesystem path before treating selector-looking colons as archive, SQLite, PDF-image, or line-selector syntax.
5. It tries archive resolution next with `resolveArchiveReadPath()`.
   - `parseArchivePathCandidates()` recognizes the extensions registered in `packages/utils/src/ar/registry.ts` (ZIP aliases, tar/compressed forms, ASAR, RAR, 7z, ISO, CAB, CPIO, RPM, ar/deb, LZH, and ARJ) before `:sub/path`.
   - On success, `readArchive()` either lists a directory or decodes an entry as UTF-8 text.
6. It tries SQLite resolution with `resolveSqliteReadPath()`.
   - `parseSqlitePathCandidates()` scans for `.sqlite`, `.sqlite3`, `.db`, `.db3` before any `:table`, `:key`, or `?query` suffix.
   - `readSqlite()` dispatches on `parseSqliteSelector()`.
7. Otherwise it treats the input as a local filesystem path.
   - `resolveReadPath()` expands `~`, resolves relative to session cwd, treats bare `/` as session cwd, and retries macOS screenshot/NFD/curly-quote variants.
   - If the path does not exist, `findUniqueWorkspaceSuffix()` attempts a workspace-wide unique suffix match (skipped for remote mounts). As a final guarded recovery, a mistakenly delimited list of existing paths is read part by part; callers should still issue one `read` per path.
8. Directories go through `#readDirectory()`.
9. Non-directories branch by content type:
   - image metadata / inline image
   - summarized macOS `sample` or V8 `.cpuprofile` report
   - editable notebook text
   - markit-converted document
   - binary-file notice unless `:raw` was explicit
   - structural summary for parseable code/prose
   - streamed text/line-range read
10. Local text reads buffer files up to 4 MiB and otherwise use streaming readers. Bounded non-raw ranges may include syntactic enclosing-block/bracket context when source is available for block analysis; raw formatting does not add context, and all ranges remain subject to normal line/byte caps.
11. If suffix resolution happened, the first text block is prefixed with `[Path '...' not found; resolved to '...' via suffix match]`.

## Modes / Variants

### Local text files
- No selector: if summarization is enabled and the file is eligible, `trySummarize()` calls `summarizeCode()`.
  - Defaults: `read.summarize.enabled = true`; prose (`.md` variants and `.txt`) stays unsummarized unless `read.summarize.prose = true`; files below `read.summarize.minTotalLines = 100` stay verbatim.
  - Hard guards: file size `<= 2 MiB` (`MAX_SUMMARY_BYTES`), line count `<= 20_000` (`MAX_SUMMARY_LINES`).
  - Summary output keeps selected declarations and replaces elided spans with `…` or merged brace-pair lines containing `{ … }`. When at least one span is elided, the text content ends with a footer naming the elided line count and up to three largest concrete ranges from the actual elisions, listed in file order.
  - When an elided block sits between matching brace lines, `renderSummary()` may merge them into one anchored line rather than emitting separate opener/closer lines.
- Explicit selector or summarization miss: ordinary text read; local files up to 4 MiB are buffered and larger files are streamed.
  - Default open-ended limit is `read.defaultLimit = 300`, clamped to `[1, DEFAULT_MAX_LINES]`.
  - Bounded non-raw ranges on non-plaintext paths may include syntactic enclosing-block/bracket context from block analysis when source is available. Plaintext paths and explicit raw ranges do not add context; all reads remain subject to normal line/byte caps. Multi-range reads may include the same context when buffered. Directory listing selectors slice rendered entries without context.
  - Non-raw output uses `resolveFileDisplayMode()`: line numbers are prepended only when the `readLineNumbers` setting is `true`; `:raw` reads never get them.
  - Non-raw code-range anchors are prefixed with `⋮` (after the `|` in numbered mode); they are context, not selected lines.
  - A terminal newline terminates the preceding line and is not addressable; totals and `Use :N` continuation hints use that same addressable-line count.
- With `readLineNumbers` enabled, output is plain text where each line is prefixed with its 1-indexed line number and a `|` separator, e.g. `41|def alpha():` (`prependLineNumbers()` in `packages/coding-agent/src/tools/read-format.ts`).

### Directory listings
- `#readDirectory()` calls `buildDirectoryTree()` with:
  - `maxDepth = 2`
  - `perDirLimit = 12`
  - `rootLimit = null`
  - `lineCap = limit` only when `offset` is undefined and a limit is supplied; otherwise `null`
- `buildDirectoryTree()` sorts siblings by recency, shows file sizes and relative ages, and renders child truncation inline as `- … N more`; local directory results do not attach list-limit metadata.
- Empty directories render as `(empty directory)`.

### Archives

- Supported archive/compression containers are the formats registered in `packages/utils/src/ar/registry.ts`: ZIP aliases (`.zip`, `.jar`, `.war`, `.ear`, `.apk`, `.whl`, `.ipa`, `.xpi`, `.vsix`, `.nupkg`, `.cbz`); tar and compressed tar (`.tar`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tbz2`, `.tbz`, `.tar.xz`, `.txz`, `.tar.zst`, `.tzst`, `.tar.Z`); ASAR, RAR/CBR, 7z, ISO, CAB, CPIO, RPM, ar/deb, LZH/LHA, ARJ; and single-stream `.gz`, `.bz2`, `.xz`, `.zst`, `.Z`, `.lzma`.
- Syntax: `archive.ext`, `archive.ext:path/inside`, `archive.ext:path/inside:50-60`.
- `openArchive()` applies the archive limits from `packages/utils/src/ar/limits.ts`:
  - readers that need whole input (including tar/compressed formats) buffer or decompress it with `maxInMemorySize = 256 MiB`
  - ZIP archives index the central directory through ranged `ByteSource` reads and extract members on demand; supported methods include stored, DEFLATE, bzip2, LZMA, Zstandard, and XZ, with `maxMemberSize = 64 MiB`
- Archive paths normalize `/`, drop `.` segments, and reject `..`.
- Directory reads list immediate children; files show `name` plus ` (size)` when size > 0.
- Directory listing default limit is `500` entries in `readArchiveDirectory()`.
- File entries are UTF-8 decoded. Binary or non-UTF-8 entries return `[Cannot read binary archive entry '...' (...)]` instead of bytes.
- Text archive entries reuse the normal in-memory pagination/anchoring path.

### Profiler reports
- Recognized macOS `sample` call-tree files (`*.sample.txt`) and V8 `.cpuprofile` JSON are rendered as bottleneck summaries rather than raw dumps when valid and at most `32 MiB`.
- Line selectors page the rendered summary. `:raw` bypasses profile rendering and reads the original file.
- A file that merely has one of those names/extensions but does not parse as the expected report falls through to ordinary text handling.


### SQLite databases
- Database detection requires both a matching extension and a valid SQLite file header (`isSqliteFile()`).
- Selector forms from `parseSqliteSelector()`:

#### `db.sqlite`
- `kind: "list"`
- Lists non-`sqlite_%` tables with row counts.
- `readSqlite()` caps the rendered list to `500` tables via `applyListLimit()`.

#### `db.sqlite:table`
- `kind: "schema"`
- Returns `sqlite_master.sql` plus sample rows.
- Sample size is `DEFAULT_SCHEMA_SAMPLE_LIMIT = 5`.

#### `db.sqlite:table:key`
- `kind: "row"`
- Resolves by primary key when the table has exactly one PK column; tables with composite primary keys or `WITHOUT ROWID` reject the lookup, while tables without a primary key fall back to `rowid`.
- No query parameters allowed on row lookups.

#### `db.sqlite:table?limit=...&offset=...&order=...&where=...`
- `kind: "query"`
- Defaults: `limit = 20`, `offset = 0`.
- `limit` is capped at `500`.
- `order` accepts `column` or `column:asc|desc` and must name an existing column.
- `where` is accepted only after `validateWhereClause()` rejects comments, semicolons, and control keywords such as `LIMIT`, `OFFSET`, `UNION`, `INTERSECT`, `EXCEPT`, `ATTACH`, `DETACH`, and `PRAGMA`.
- Unknown query parameters throw.

#### `db.sqlite?q=SELECT ...`
- `kind: "raw"`
- Cannot be combined with table selectors or any other query param.
- Empty `q` throws.
- `executeReadQuery()` prepares the SQL, rejects bound parameters, and collects rows from `statement.iterate()` capped at `MAX_RAW_QUERY_ROWS = 1000`; it does not verify that the SQL starts with `SELECT`.

- Rendering caps in `packages/coding-agent/src/tools/sqlite-reader.ts`:
  - ASCII table width `120` (`MAX_RENDER_WIDTH`)
  - per-column width `40` (`MAX_COLUMN_WIDTH`)
- `readSqlite()` uses `openSqliteReadConnection()`, which normally opens Bun SQLite with `{ readonly: true, strict: true }`, may fall back to `{ readwrite: true, create: false, strict: true }` for WAL-sidecar initialization or `SQLITE_CANTOPEN`, then sets `PRAGMA query_only = ON` and `PRAGMA busy_timeout = 3000`.

### Documents
- `CONVERTIBLE_EXTENSIONS` in `packages/coding-agent/src/utils/markit.ts` covers `.pdf`, `.docx`, `.pptx`, `.xlsx`, and `.epub`.
- `convertFileWithMarkit()` converts the file to text/markdown; line-range and `:raw` selectors then apply to the converted output (`file.pdf:50-100`, `file.pdf:5-16,40-80`).
- A selector such as `doc.pdf:p11-img0.png` is handled by `packages/coding-agent/src/tools/read-pdf.ts` as a browser-rendered screenshot request for PDF page 11; it is not an extracted embedded-image member.
- Conversion failures return a text block like `[Cannot read .pdf file: ...]`.

### Jupyter notebooks
- `.ipynb` goes through `readEditableNotebookText()` unless `:raw` was requested.
- Output is editable plain text with markers like:

```text
# %% [code] cell:0
...
```

- Raw mode bypasses that conversion and falls back to file-text reading.

### Media
- Image detection is metadata-based (`readImageMetadata()`).
- Vision-capable image submissions and modality-supported audio/video payloads are capped at `20 MiB` (`MAX_IMAGE_INPUT_BYTES` / `MAX_MEDIA_INPUT_BYTES`); oversize loads for those capable paths throw.
- Ordinary image reads call `loadImageInput()`: vision-capable active models receive a text note plus an inline image block; text-only models receive metadata and a simple unsupported-input notice without loading image bytes.
- Audio/video reads call `loadMediaFileInput()` and return native media blocks when the active model accepts that modality. Unsupported active models receive an error notice without binary media content.
- Image reads accept `Image #N` and `attachment://N` references from the current turn. `images.blockImages=true` suppresses image submission.
- On image-submission paths, recognized image decode/size failures surface as `ToolError`; unrecognized local media follows ordinary binary/text handling.

### Internal URLs
- `read` delegates internal and MCP-advertised schemes to `InternalUrlRouter`; the built-in registry currently includes `agent://`, `artifact://`, `history://`, `local://`, `mcp://`, `harness://`, `rule://`, `skill://`, `ssh://`, and `protolens://`.
  - `protolens://` lists mounted tool devices; `protolens://<name>` returns that device's input documentation. Writing JSON to the same URI dispatches the device through the xdev protocol layer.
  - `ssh://host/<path>` reads a remote UTF-8 file or directory; bare `ssh://` lists configured hosts. Remote file reads are limited to 1 MiB and require a POSIX remote shell. Percent-encode literal `:`, `?`, or `#` in the path.
- `#handleInternalUrl()` behavior:
  - parses the URL with `parseInternalUrl()` so colons inside the host segment are legal
  - for `agent://`, treats non-root path extraction or `?q=` extraction as a special no-pagination mode
  - routes `artifact://` through a bounded artifact-file reader and large-output workflow hints
  - otherwise paginates the resolved text in memory
  - does not use the router's `immutable` flag for display formatting; line-number and block-context behavior still comes from `resolveFileDisplayMode()` and the normal in-memory reader
  - sets `ignoreResultLimits: true` for `skill://` so the full skill text is paginated only by explicit selectors, not by the normal default line limit
- `conflict://` is handled separately from the router. `<path>:conflicts` registers blocks; `conflict://<N>` reads one registered marker block, `/ours`, `/theirs`, or `/base` selects a side, and an omitted scope returns the full marker block. `conflict://*` is rejected.

### Web URLs
- `parseReadUrlTarget()` accepts `http://`, `https://`, or `www.` targets.
- Plain URL reads call `executeReadUrl()` in `packages/coding-agent/src/tools/fetch.ts`.
- `:raw` skips special URL handlers and uses the raw body for ordinary text/HTML; binary/document/image handling still runs before that fallback. Plain URL reads otherwise prefer rendered/reader-friendly output.
- `:N`, `:A-B`, `:A+C`, and comma-separated multi-ranges fetch/render the requested URL, then page over the rendered output locally; the current fetch path does not reuse a prior URL render cache.
- URL render pipeline in `renderUrl()`:
  1. normalize scheme (`https://` added for bare `www.`)
  2. try special handlers for known sites unless raw
  3. fetch with `loadPage()`
  4. if content is image/PDF/DOCX/etc., try binary fetch + markit/image handling
  5. handle JSON directly, feeds via feed parser, plain text directly
  6. for HTML and non-raw mode, try markdown alternates, `URL.md`, content negotiation, then HTML-to-text renderers; on renderer failure, try feed alternates then `llms.txt`, and on low-quality output, try extracted linked documents, feed alternates, then `llms.txt`
  7. fall back to raw body text/html
- URL output is wrapped with a small header (the `Notes` line appears when nonempty):

```text
URL: ...
Content-Type: ...
Method: ...
Notes: ...

---
```

- `method` records the winning path (`json`, `feed`, `text`, `alternate-markdown`, `md-suffix`, `content-negotiation`, `image`, `markit`, `llms.txt`, `raw`, `raw-html`, etc.).
- URL reads may return an inline image block when the fetched resource is a supported image and survives resizing.

## Side Effects
- Filesystem
  - Opens and reads local files, buffering small files and streaming larger line reads.
  - Readers that need whole archive input (including tar/compressed formats) buffer it before indexing within the archive limits; ZIP archives are indexed via ranged central-directory reads.
  - Writes URL output artifacts for truncated plain URL output and for selector reads that request `ensureArtifact`.

- Network
  - URL mode performs HTTP fetches, binary refetches, and alternate-endpoint probes.
- Subprocesses / native bindings
  - Uses Bun SQLite for `.db`/`.sqlite*`.
  - Uses the archive readers in `packages/utils/src/ar`; ZIP uses ranged reads plus `node:zlib`/codec decoders.
  - URL HTML rendering can delegate into site handlers and HTML-to-text backends from `packages/coding-agent/src/tools/fetch.ts`.
- Session state
  - Passes session `cwd`, `settings`, and `localProtocolOptions` into the process-global `InternalUrlRouter.instance().resolve()` for internal URLs.
  - Uses `session.allocateOutputArtifact()` for truncated and selector-paginated URL output.
- Background work / cancellation
  - Local text streaming, URL/internal-URL reads, archive, SQLite, document conversion, structural summary, and suffix resolution receive or check the `AbortSignal`. The directory-listing call passes `undefined`; image/media loaders are not signal-aware. `<path>:conflicts` checks before its scan, while conflict warnings appended during ordinary text reads scan without a signal.

## Limits & Caps
- Shared text truncation defaults from `packages/coding-agent/src/session/streaming-output.ts`:
  - `DEFAULT_MAX_LINES = 3000`
  - `DEFAULT_MAX_BYTES = 50 * 1024`
- Local text open-ended default line limit: `read.defaultLimit` (default `300`), clamped to `[1, DEFAULT_MAX_LINES]`.
- Bounded non-raw ranges on non-plaintext paths may include syntactic enclosing-block/bracket context when source is available; plaintext paths and explicit raw ranges do not add context, but all reads remain subject to normal line/byte caps.
- File streaming chunk size: `8 * 1024` bytes (`READ_CHUNK_SIZE`).
- Local streamed byte budget for line reads: `max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512)`.
- Structural summaries only run when file size `<= 2 MiB` and line count `<= 20_000`.
- Profile summaries run only for recognized reports at most `32 MiB`; `:raw` bypasses them.
- Image input max: `20 MiB`.
- Directory tree caps for local directories: depth `2`, per-directory children `12`.
- Archive directory default list cap: `500` entries; member extraction cap: `64 MiB`; readers that buffer whole input/decompression cap: `256 MiB`; ZIP central-directory index cap: `64 MiB`.
- SQLite:
  - default row query limit `20`
  - schema sample limit `5`
  - max query limit `500`
  - raw `?q=` row cap `1000` (`MAX_RAW_QUERY_ROWS`)
  - table list cap `500`
  - render width `120`, column width `40`
  - busy timeout `3000` ms
- URL read result shown to the model is truncated to `300` lines and `50 KiB` in `executeReadUrl()`; full rendered output can be attached as an artifact.
- Inline fetched URL images:
  - source bytes cap `20 MiB`
  - post-resize inline output cap `300 KiB`
- Unique suffix auto-resolution glob timeout: `5000` ms.
- An unbounded `artifact://<id>:raw` read is refused when the artifact exceeds `50 KiB`; use a bounded `:raw:N-M` range.

## Errors
- Validation and operational failures surface as `ToolError`.
- Selector errors include:
  - `Line selector 0 is invalid; lines are 1-indexed. Use :1.`
  - invalid `A+B` / `A-B` shapes
  - `Cannot combine query extraction with line selectors` for `agent://.../path:50`
  - multi-ranges on directory/archive-directory listings
- `conflict://*` reads are rejected; unknown/stale conflict ids require re-reading `<path>:conflicts`.
- Missing local/archive/sqlite paths first attempt unique suffix resolution; if no unique match or guarded recovery exists they error.
- Out-of-bounds line reads do not throw. They return explanatory text with a suggestion such as `Use :1 ...` or `Use :<last line> ...`.
- Probable binary local files return a notice unless `:raw` was requested.
- Binary archive entries do not throw; they return a text notice.
- Document conversion failure returns a text notice.
- On image-submission paths, recognized image oversize or decode failures throw; unrecognized local media can instead follow ordinary binary/text handling. Unsupported audio/video modality returns an error result without binary content.
- SQLite parser rejects unsupported parameter combinations early; DB/runtime errors are caught and rethrown as `ToolError(message)`.
- URL fetch failures (HTTP non-OK responses or transport failures) throw `ToolError` with the status/cause and a bounded body excerpt when available.
- Large unbounded raw artifact reads return a workflow notice rather than loading the artifact into memory.

## Notes
- `splitPathAndSel()` intentionally treats unknown trailing `:...` as part of the path so `archive.zip:inner/file` and `db.sqlite:table:key` still work.
- `resolveReadPath()` contains macOS-specific filename fallbacks for screenshot timestamps, NFD Unicode normalization, and curly apostrophes.
- A bare `/` resolves to the session cwd, not the filesystem root.
- URL selector reads invoke `fetchReadUrl()` for the requested URL and paginate the current rendered output locally; the current fetch path has no prior-render cache.
- URL line-range reads pass `ensureArtifact: true` to persist the current rendered output as an artifact; there is no `preferCached` option in the current fetch path.
- Raw SQLite `q=` execution is not keyword-restricted beyond “no bound parameters”; `openSqliteReadConnection()` enables `PRAGMA query_only = ON`, so SQLite itself rejects writes.