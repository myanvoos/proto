Runs commands in a persistent shell.

Use ONLY for one binary or a short pipeline that computes a fact (`wc -l`, `sort | uniq -c`, `diff`).
{{#if hasEval}}Inline scripts, heredocs, `$(…)`, complex control flow/quoting, non-trivial pipelines → `eval`.{{else}}Inline scripts, heredocs, `$(…)`, complex control flow → a purpose-built tool or checked-in script.{{/if}}

- Set `cwd` instead of `cd`; `env: { NAME: "…" }` for multiline/quote-heavy values. `pty: true` only for terminal interaction (`sudo`, `ssh`).
- Order-dependent commands: `&&` in one call; independent calls may run concurrently.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to paths.
{{#if hasShellBuiltins}}- Many aux utils on PATH (mkdir, jq, sed, xargs, sha256sum, mktemp, …{{#unless isWindows}} incl. `errno`{{/unless}}) — no need to check availability.{{/if}}
{{#if asyncEnabled}}- `async: true` defers a finite command's result; does not extend `timeout`.{{/if}}

Avoid `head`/`tail`/redirection: output is captured, truncated, linked as `artifact://<id>`. No truncation footer → displayed output is complete.
{{#if hasLaunch}}Services, watchers, debuggers, REPLs MUST use `fleet` (`op:"start"`).{{/if}}
{{#if autoBackgroundEnabled}}Long foreground calls may auto-background and deliver later. `timeout: 0` disables the job deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
