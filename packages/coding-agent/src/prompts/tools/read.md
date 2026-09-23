Read files, directories, archives, SQLite, images, documents, internal resources, web URLs via `path`. SHOULD parallelize independent reads; prefer `read` over browser for web content.

Selectors — append `:<sel>` to `path` (e.g. `src/foo.ts:50-200`, `db.sqlite:users:42`):
`N`/`N-`/`N-M` inclusive/`N+K` K lines/`5-16,960-973` multi-range | `:raw` verbatim, no anchors (composes: `:2-4:raw`) | `:conflicts` one line per unresolved merge conflict

Non-raw code-range anchors are prefixed with `⋮` (after the `|` in numbered mode); they are context, not selected lines.

- Code without selector → structural summary (declarations only, bodies elided); footer names recovery ranges — re-issue ONLY those, NEVER guess elided content.
- Directory → depth-limited listing; child dirs cap at 12 (`… N more` → read the sub-path). Documents → text; notebooks → editable cells; images → {{#if IMAGES_INLINE}}decoded inline{{else}}metadata{{#if INSPECT_MEDIA_ENABLED}} (use `inspect_media`){{/if}}{{/if}}; `:raw` bypasses converters.
- SQLite: `file.db[:table[:key]]`; `?limit=`/`?where=`/`?q=SELECT`. Archives → `archive.ext:member/path` (zip/tar/rar/7z/iso families); single-stream `.gz`/`.bz2`/`.xz`/`.zst` take a line selector directly (`log.gz:1-40`).
- URLs → reader-mode text/markdown (scheme required); `:raw` untouched HTML; a trailing `:<port>` stays part of the URL, so select lines after a path (`http://host:8080/:5-20`). HTTP error statuses and unreachable hosts are errors, not empty reads. Internal URIs take selectors; `artifact://<id>` recovers spilled output (page `:N-M`/`:raw:N-M`).
- `ssh://host/<path>` remote UTF-8 text reads (≤1 MiB; percent-encode `:`/`?`/`#`; POSIX shell required). Use a write-capable API when one is exposed; otherwise use `bash` with a remote command or `sshfs` for writes. Bare `ssh://` lists hosts.
