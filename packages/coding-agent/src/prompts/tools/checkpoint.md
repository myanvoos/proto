Context checkpoint: start before exploratory work; later `rewind` keeps only your concise report — minimizes context cost for investigations with many intermediate calls.

- MUST `rewind` before yielding after starting a checkpoint; NEVER checkpoint while one is active.
- Enabled by default; `checkpoint.enabled: false` disables both tools. Subagents still require agent frontmatter `tools:` listing `checkpoint` or `rewind` (sister tool auto-included).
