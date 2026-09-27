Read files, directories, archives, SQLite, images, audio, video, documents, internal resources, and web URLs at `path`. Vision-capable models receive images inline; audio/video are passed natively when the active model accepts them, otherwise read reports a clear notice. SHOULD parallelize independent reads; prefer `read` over browser for web content.

Selectors — append `:<sel>` to `path` (e.g. `src/foo.ts:50-200`):
`N`/`N-` from line N/`N-M` inclusive/`N+K` K lines/`5-16,960-973` multi-range | `:raw` verbatim, no anchors (composes: `:2-4:raw`) | `:conflicts` one line per unresolved merge conflict

Non-raw code-range anchors are prefixed with `⋮` (after the `|` in numbered mode); they are context, not selected lines.

{{#if SUMMARIZE}}- Code of ≥{{SUMMARY_MIN_LINES}} lines without selector → structural summary (shorter files come back whole): declarations kept; bodies ≥{{SUMMARY_BODY_LINES}} lines and block comments ≥{{SUMMARY_COMMENT_LINES}} lines fold to their first/last lines around `…` (a fully folded brace body collapses to `head { … }`, numbered `N-M|`); footer names recovery ranges — re-issue ONLY those, NEVER guess elided content.{{/if}}
- Directory → depth-limited listing; child dirs cap at 12 (`… N more` → read the sub-path). Documents → text; notebooks → editable cells; images → {{#if IMAGES_INLINE}}decoded inline{{else}}metadata{{/if}}; audio/video → native media blocks when accepted by the active model, otherwise a clear unsupported-input notice. `:raw` bypasses converters.
- SQLite: `file.db[:table[:key]]`; `?limit=`/`?where=`/`?q=SELECT`. Archives → `archive.ext:member/path` (zip/tar/rar/7z/iso families); single-stream `.gz`/`.bz2`/`.xz`/`.zst` take a line selector directly (`log.gz:1-40`).
- URLs → reader-mode text/markdown (scheme required); `:raw` untouched HTML; a trailing `:<port>` stays part of the URL, so select lines after a path (`http://host:8080/:5-20`). HTTP error statuses and unreachable hosts are errors, not empty reads. Internal URIs take selectors; `artifact://<id>` recovers spilled output (page `:N-M`/`:raw:N-M`).
- `ssh://host/<path>` remote UTF-8 text reads (≤1 MiB; percent-encode `:`/`?`/`#`; POSIX shell required). Use a write-capable API when one is exposed; otherwise use `bash` with a remote command or `sshfs` for writes. Bare `ssh://` lists hosts.
- Image attachments accept `Image #N` or `attachment://N` when available in the current turn.
