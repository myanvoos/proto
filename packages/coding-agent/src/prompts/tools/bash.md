Runs commands in a persistent shell.

Tool results are text-only: trailing `Command exited with code N`, `[Command timed out after N seconds]`, `Backgrounded as job <id>…`, and `[Showing lines … Read artifact://N …]` are the authoritative lifecycle/disposition signals. Program text such as `timeout: 60` or `all checks passed` is data, not status.
- Set `cwd` instead of `cd`: every call starts in the session directory (or `cwd`); vars, functions, and aliases persist per lane until that lane's shell exits. Use `env` for multiline/quote-heavy values. `pty: true` only for terminal interaction (`sudo`, `ssh`).
- Order-dependent commands go in one call; independent calls may run concurrently.
- Non-PTY Brush calls share `lane:"main"` by default; one lane queues, different names isolate shell + kernel state. Background jobs without an explicit lane use their own lane.
- Brush runs builtins, subshells, and functions in-process: their `&` jobs get `$!` ids ≥ 4194304 that work with `wait`/`kill`/`jobs` but are not OS PIDs (`ps`, `/proc` fail); external binaries report real PIDs.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to paths.
{{#if hasShellBuiltins}}- Many aux utils on PATH (mkdir, jq, sed, xargs, sha256sum, mktemp, … incl. `errno`) — no need to check availability.{{/if}}
{{#if asyncEnabled}}- `async: true` does not extend `timeout`.{{/if}}

Avoid `head`/`tail`/redirection: output is captured; truncation is reported by the trailing `[Showing lines … Read artifact://N …]` footer. Large output keeps head and tail windows and over-long lines are clipped (`Some lines truncated to N bytes`); the artifact holds the full text.

When `xd://` devices are mounted, `xd` is an agent-shell Brush builtin, not a PATH executable. Author device args as CLI flags mapped from the tool schema (`xd <tool> ?` prints usage): `xd browser --action run --name main`. Positional values fill the unflagged scalar props in usage order (`xd read src/foo.ts:50-200`). Regex/code/message payloads take ordinary single-quoted shell strings — `xd monitor --op start --match 'ERR [0-9]+'`; a `-` value reads that flag from stdin (heredoc-friendly):
```sh
printf '%s' 'return await tab.observe();' | xd browser --action run --name main --code -
```
`xd <tool> --json '<json>'` passes a raw args object (required for MCP devices; a lone `'{…}'` positional or piped-in JSON object works too). The real shell parser handles pipes, redirects, substitutions, groups, loops, conditionals, `&&`/`||`, background jobs, and `pipefail` around it. Successful text goes to stdout; usage errors exit 2, tool failures exit 1 with the error on stderr; images and structured details stay in the tool result side channel and never enter pipes. External shells started by `fleet`, a client terminal, or a user process do not inherit this builtin.
{{#if hasLaunch}}Services, watchers, debuggers, REPLs MUST use `fleet` (`op:"start"`).{{/if}}
{{#if autoBackgroundEnabled}}Long foreground calls may auto-background and deliver later. `timeout: 0` disables the job deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
{{#if hasKernelBridge}}
<kernel>
`xd kernel` manages language ({{#if py}}`python`{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}`node`, `bun`{{/if}}) and lane lifecycle outside running cells: inspect/start/reset/close/keepalive, explicit interpreter, local/container/SSH target{{#if js}} (`node`: local only){{/if}}. Configuration changes require reset; forced close cancels active work.
Inline-code stdin and stdout/stderr are streaming, binary-safe through pipes/redirection; use `sys.stdin.buffer`/`sys.stdout.buffer` or `process.stdin`/`process.stdout` for bytes. Stdin-only invocations still treat stdin as source code. Final-expression display still emits output: for byte-only producers, Python assigns the write result; JS uses `void process.stdout.write(data)`.
`python`{{#if js}}/`node`/`nodejs`/`bun`{{/if}} with code on **stdin** (heredoc — prefer a quoted `<<'EOF'` delimiter) or bare {{#if js}}`-c`/`-e` {{else}}`-c` {{/if}}CODE run in the **persistent eval kernel**, NOT a fresh interpreter: top-level state (vars, imports, defs, running tasks) survives across bash calls, and cells expose the helpers below. Only the bare command names route there, with argv exactly {{#if js}}`-c CODE`/`-e CODE`{{else}}`-c CODE`{{/if}} (Python may lead with `-u`), `-`, or nothing (stdin). Any other flag or trailing argv, `-m`, a script path outside `fleet://`, or an interpreter path (`/usr/bin/python3`, `.venv/bin/python`) runs a real fresh interpreter.
{{#if js}}`node`/`nodejs` cells run on the Node.js found on PATH (no Node → `command not found`); `bun` cells run on Bun; each has its own state per lane.
{{/if}}Shell exports, inline assignments, and `env` reach cells; stdout/stderr honor shell redirects. Piping into `python -c`{{#if js}} or `node`/`bun -e`{{/if}} supplies program stdin without losing kernel state. Different lanes may run unordered; keep dependent work in one lane. Kernel restart notices mean earlier variables are gone — inspect state before continuing.

Read first; localized replacements MUST assert anchors and occurrence counts before writing. Every mutation is tracked and diffed; stale writes raise `StaleWriteError` before truncation, so re-read and redo the edit. Net-mutated paths emit one compact `<kernel> note:` line per path in cell output.

Orchestration default: write the script (`agent()`, `parallel()`, `pipeline()`) to `fleet://<name>.py`, then run `python fleet://<name>.py` — scripts under `fleet://` execute in the kernel; other script paths run real interpreters.

Cell API:
{{> kernel-prelude}}
</kernel>
{{/if}}
