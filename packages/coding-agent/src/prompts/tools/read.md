Read files, directories, archives, SQLite, images, documents, internal resources, web URLs via `path`. SHOULD parallelize independent reads; prefer `read` over browser for web content.

Selectors — append `:<sel>` to `path` (e.g. `src/foo.ts:50-200`, `db.sqlite:users:42`):
`N`/`N-`/`N-M` inclusive/`N+K` K lines/`5-16,960-973` multi-range | `:raw` verbatim, no anchors (composes: `:2-4:raw`) | `:conflicts` one line per unresolved merge conflict

- Code without selector → structural summary (declarations only, bodies elided); footer names recovery ranges — re-issue ONLY those, NEVER guess elided content.
{{#if IS_HL_MODE}}- File + selector → `[foo.ts#1A2B]` snapshot header + numbered lines; copy `[FILENAME#TAG]` verbatim for anchored edits; NEVER fabricate the tag.
{{/if}}- Directory → depth-limited listing. Documents → text; notebooks → editable cells; images → {{#if INSPECT_MEDIA_ENABLED}}metadata (use `inspect_media`){{else}}decoded inline{{/if}}; `:raw` bypasses converters.
- SQLite: `file.db[:table[:key]]`; `?limit=`/`?where=`/`?q=SELECT`. Archives → `archive.ext:member/path` (zip/tar/rar/7z/iso families; single-stream `.gz`/`.bz2`/`.xz`/`.zst`).
- URLs → reader-mode text/markdown; `:raw` untouched HTML; bare `host:port` needs trailing slash. Internal URIs take selectors; `artifact://<id>` recovers spilled output (page `:N-M`/`:raw:N-M`).
- `ssh://host/<path>` remote read/write (UTF-8, ≤1 MiB; percent-encode `:`/`?`/`#`; POSIX shell required — else `bash` with remote command or `sshfs`); bare `ssh://` lists hosts.
