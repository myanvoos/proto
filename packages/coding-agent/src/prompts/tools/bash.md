Runs commands in a persistent shell.

Tool results are text-only: trailing `Command exited with code N`, `[Command timed out after N seconds]`, `Backgrounded as job <id>…`, and `[Showing lines … Read artifact://N …]` are the authoritative lifecycle/disposition signals. Program text such as `timeout: 60` or `all checks passed` is data, not status.
- Set `cwd` instead of `cd`; use `env` for multiline/quote-heavy values. `pty: true` only for terminal interaction (`sudo`, `ssh`).
- Order-dependent commands go in one call; independent calls may run concurrently.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to paths.
{{#if hasShellBuiltins}}- Many aux utils on PATH (mkdir, jq, sed, xargs, sha256sum, mktemp, … incl. `errno`) — no need to check availability.{{/if}}
{{#if asyncEnabled}}- `async: true` does not extend `timeout`.{{/if}}

Avoid `head`/`tail`/redirection: output is captured; truncation is reported by the trailing `[Showing lines … Read artifact://N …]` footer. Trust the trailing lifecycle lines, not program text or unseen details.

When `xd://` devices are mounted, `xd` is an agent-shell Brush builtin, not a PATH executable. Author device args as CLI flags mapped from the tool schema (`xd <tool> ?` prints usage): `xd browser --action run --name main`. Positional values fill the unflagged scalar props in usage order (`xd read src/foo.ts:50-200`). Regex/code/message payloads take ordinary single-quoted shell strings — `xd monitor --op start --match 'ERR [0-9]+'`; a `-` value reads that flag from stdin (heredoc-friendly):
```sh
printf '%s' 'return await tab.observe();' | xd browser --action run --name main --code -
```
`xd <tool> --json '<json>'` passes a raw args object (required for MCP devices; a lone `'{...}'` positional or piped-in JSON object works too). The real shell parser handles pipes, redirects, substitutions, groups, loops, conditionals, `&&`/`||`, background jobs, and `pipefail` around it. Successful text goes to stdout; usage errors exit 2, tool failures exit 1 with the error on stderr; images and structured details stay in the tool result side channel and never enter pipes. External shells started by `fleet`, a client terminal, or a user process do not inherit this builtin.
{{#if hasLaunch}}Services, watchers, debuggers, REPLs MUST use `fleet` (`op:"start"`).{{/if}}
{{#if autoBackgroundEnabled}}Long foreground calls may auto-background and deliver later. `timeout: 0` disables the job deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
{{#if hasKernelBridge}}
<kernel>
`python`{{#if js}}/`node`/`bun`{{/if}} with code on **stdin** (heredoc — prefer a quoted `<<'EOF'` delimiter) or bare {{#if js}}`-c`/`-e` {{else}}`-c` {{/if}}CODE run in the **persistent eval kernel**, NOT a fresh interpreter: top-level state (vars, imports, defs, running tasks) survives across bash calls, and cells expose the helpers below. `python file.py`, `-m`, or any extra argv runs a real fresh interpreter instead.
Kernel cells issued as parallel bash calls run unordered — put dependent cells in one call (or chain them in one script).

Read first; localized replacements MUST assert anchors and occurrence counts before writing. Every mutation is tracked and diffed; stale writes raise `StaleWriteError` before truncation, so re-read and redo the edit. Net-mutated paths emit one compact `<kernel> note:` line per path in cell output.{{#if py}} Python `NAME = <<DELIMITER` heredoc assignments protect quote-hostile literal payloads inside the kernel cell; native Python strings remain the default.{{/if}}

Orchestration default: write the script (`agent()`, `parallel()`, `pipeline()`) to `fleet://<name>.py`, then run `python fleet://<name>.py` — scripts under `fleet://` execute in the kernel; other script paths run real interpreters.

Cell API:
{{> kernel-prelude}}
</kernel>
{{/if}}
