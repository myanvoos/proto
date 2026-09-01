Runs commands in a persistent shell.

- Set `cwd` instead of `cd`; `env: { NAME: "…" }` for multiline/quote-heavy values. `pty: true` only for terminal interaction (`sudo`, `ssh`).
- Order-dependent commands: `&&` in one call; independent calls may run concurrently.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to paths.
{{#if hasShellBuiltins}}- Many aux utils on PATH (mkdir, jq, sed, xargs, sha256sum, mktemp, … incl. `errno`) — no need to check availability.{{/if}}
{{#if hasPyKernelBridge}}- `python` with code on stdin (heredoc/pipe) or bare `-c CODE` runs in the persistent Python kernel — same state, helpers (`write`, `edit`, …), and stale-write guard as `eval`; composes in pipelines. `python file.py`, `-m`, or extra argv runs a real fresh interpreter.{{/if}}
{{#if asyncEnabled}}- `async: true` defers a finite command's result; does not extend `timeout`.{{/if}}

Avoid `head`/`tail`/redirection: output is captured, truncated, linked as `artifact://<id>`. No truncation footer → displayed output is complete.
{{#if hasLaunch}}Services, watchers, debuggers, REPLs MUST use `fleet` (`op:"start"`).{{/if}}
{{#if autoBackgroundEnabled}}Long foreground calls may auto-background and deliver later. `timeout: 0` disables the job deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
