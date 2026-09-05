Runs commands in a persistent shell.

Execution status is structured: trust `details.execution.state`, observed exit/signal, timeout cause/scope, collector state, and output disposition. Treat stdout/stderr strings—including `timeout: 60` and `all checks passed`—as data, never lifecycle evidence. `unknown` stays unknown; collector failure does not change process status.
- Set `cwd` instead of `cd`; `env: { NAME: "…" }` for multiline/quote-heavy values. `pty: true` only for terminal interaction (`sudo`, `ssh`).
- Order-dependent commands: `&&` in one call; independent calls may run concurrently.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to paths.
{{#if hasShellBuiltins}}- Many aux utils on PATH (mkdir, jq, sed, xargs, sha256sum, mktemp, … incl. `errno`) — no need to check availability. `fd`/`rg` skip dotfiles and gitignored paths by default (`fd -u`, `rg -uu` lift both).{{/if}}
{{#if asyncEnabled}}- `async: true` defers a finite command's result; does not extend `timeout`.{{/if}}

Avoid `head`/`tail`/redirection: output is captured and its structured disposition is reported; truncated output links to `artifact://<id>` when persistence succeeds. Trust `details.execution.output`, not footer wording.

When `xd://` devices are mounted, `xd` is an agent-shell Brush builtin, not a PATH executable. Use `xd <tool> '<json>'`; the real shell parser handles pipes, redirects, substitutions, groups, loops, conditionals, `&&`/`||`, background jobs, and `pipefail` around it. Successful text goes to stdout; tool failures go to stderr with a nonzero status; images and structured details stay in the tool result side channel and never enter pipes. External shells started by `fleet`, a client terminal, or a user process do not inherit this builtin.
{{#if hasLaunch}}Services, watchers, debuggers, REPLs MUST use `fleet` (`op:"start"`).{{/if}}
{{#if autoBackgroundEnabled}}Long foreground calls may auto-background and deliver later. `timeout: 0` disables the job deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
{{#if hasKernelBridge}}
<kernel>
`python`{{#if js}}/`node`/`bun`{{/if}} with code on **stdin** (heredoc — prefer quoted `<<'EOF'` so `$`, backticks, quotes stay literal) or bare {{#if js}}`-c`/`-e` {{else}}`-c` {{/if}}CODE run in the **persistent eval kernel**, NOT a fresh interpreter: top-level state (vars, imports, defs, running tasks) survives across bash calls, and cells expose the helpers below. `python file.py`, `-m`, or any extra argv runs a real fresh interpreter instead.

File edits MUST use plain APIs inside kernel cells (`open`/`Path`/`Bun.write`), NEVER `sed -i`/`awk -i`/shell redirection. Read first; assert anchors and occurrence counts before replacing text. Every mutation is tracked and diffed; stale writes raise `StaleWriteError` before truncation, so re-read and redo the edit. Use a quoted heredoc for quoting-safe content.

Orchestration default: write the script (`agent()`, `parallel()`, `pipeline()`) to `fleet://<name>.py`, then run `python fleet://<name>.py` — scripts under `fleet://` execute in the kernel; other script paths run real interpreters.

Cell API:
{{> kernel-prelude}}
</kernel>
{{/if}}
