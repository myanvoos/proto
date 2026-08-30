Web search: current information beyond knowledge cutoff. SHOULD prefer primary sources; corroborate key claims; MUST link cited sources in the final response.

NEVER for programmatically accessible content or known URLs (GitHub, arXiv, Wikipedia, official docs) — `read` the URL directly.

`query` supports Google-style `site:`/`-site:`, `after:`/`before:` (`YYYY-MM-DD`), `inurl:`, `intitle:`, `filetype:`, `"exact phrase"`, `-term`, `OR`. Map constraints to native filters when available, else filter leniently; a constraint matches nothing → relax and report, never return zero results.
