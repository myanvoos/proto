Runs commands in a persistent shell.

- Set `cwd` instead of `cd`; `env: { NAME: "…" }` for multiline/quote-heavy values. `pty: true` only for terminal interaction (`sudo`, `ssh`).
- Order-dependent commands: `&&` in one call; independent calls may run concurrently.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to paths.
{{#if hasShellBuiltins}}- Many aux utils on PATH (mkdir, jq, sed, xargs, sha256sum, mktemp, … incl. `errno`) — no need to check availability. `fd`/`rg` skip dotfiles and gitignored paths by default (`fd -u`, `rg -uu` lift both).{{/if}}
{{#if asyncEnabled}}- `async: true` defers a finite command's result; does not extend `timeout`.{{/if}}

Avoid `head`/`tail`/redirection: output is captured, truncated, linked as `artifact://<id>`. No truncation footer → displayed output is complete.
{{#if hasLaunch}}Services, watchers, debuggers, REPLs MUST use `fleet` (`op:"start"`).{{/if}}
{{#if autoBackgroundEnabled}}Long foreground calls may auto-background and deliver later. `timeout: 0` disables the job deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
{{#if hasKernelBridge}}
<kernel>
`python`{{#if js}}/`node`{{/if}} with code on **stdin** (heredoc — prefer quoted `<<'EOF'` so `$`, backticks, quotes stay literal) or bare {{#if js}}`-c`/`-e` {{else}}`-c` {{/if}}CODE run in the **persistent eval kernel**, NOT a fresh interpreter: top-level state (vars, imports, defs, running tasks) survives across bash calls, and cells expose the helpers below. `python file.py`, `-m`, or any extra argv runs a real fresh interpreter instead.

File edits MUST use the kernel helpers, NEVER `sed -i`/`awk -i`/`>` redirection/`str.replace` surgery: `edit(path, old, new)` asserts the anchor and occurrence count and writes atomically or not at all; `write(path, content)` for a new or wholly-replaced file. Reach for a cell — `python <<'EOF'` … `edit(...)` … `EOF` — instead of a `sed` one-liner; the heredoc is the quoting-safe channel (no escape gymnastics). Reads (`cat`, `rg`, `read` tool, in-cell `Path(p).read_text()`) arm the stale-write guard that protects both helpers.

Orchestration default: write the script (`agent()`, `parallel()`, `pipeline()`) to `fleet://<name>.py`, then run `python fleet://<name>.py` — scripts under `fleet://` execute in the kernel; other script paths run real interpreters.

Cell API:
{{> kernel-prelude}}
</kernel>
{{/if}}
