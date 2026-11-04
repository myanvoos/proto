Runs commands in the agent shell.{{#if py}} Python runs in fresh native processes; import `proto_harness as harness` for explicit host APIs and named kernels.{{/if}}{{#if js}} Bare `node`/`bun` code runs in persistent JavaScript kernels.{{/if}}

<critical>
- Status comes from the tool-result footer, NEVER from program text.
- Read before editing; assert every replacement anchor occurs exactly once.
{{#if py}}- Python variables do NOT persist between commands. Use `harness.store` or an explicitly named `harness.kernel(...)`; NEVER assume implicit globals.{{/if}}
{{#if js}}- Only the JavaScript forms below reach retained kernels.{{/if}}
</critical>

## Shell

- Set `cwd` instead of `cd`; every call{{#if hasKernelBridge}}, kernel cells included,{{/if}} starts there (default: session directory).
- `lane` defaults to `"main"`. Calls in one lane run one at a time in issue order and share shell variables, functions, and aliases{{#if hasKernelBridge}}, plus kernel state{{/if}}. Different lanes run concurrently with separate state.
- Dependent steps → one call chained with `&&`; a failed call does not stop calls already queued behind it.
{{#if asyncEnabled}}- `async: true` without `lane` isolates shell state{{#if hasKernelBridge}} but reuses `main`'s kernels{{/if}}. Need shell state too → pass `lane:"main"` (later `main` calls queue behind it). `async` keeps the command deadline (default {{defaultTimeoutSec}}s); `timeout: 0` disables it.
{{/if}}{{#if autoBackgroundEnabled}}- Foreground calls still running after {{autoBackgroundThresholdSeconds}}s become background jobs whose results arrive later. `timeout` bounds the job (`0` = no deadline), not the foreground wait.
{{/if}}{{#if hasLaunch}}- Services, dev servers, watchers, debuggers, REPLs MUST run under {{#if launchViaProtolens}}`protolens jobs --op start`{{else}}`jobs` (`op:"start"`){{/if}}, not `&` or `async`.
{{/if}}- `<shell> state lost`{{#if hasKernelBridge}} / `<kernel> state lost`{{/if}} notice → earlier state in that lane is gone; rebuild it before reuse.
- A redirection that owns its target (`cat > file`, `>>`, `tee`) prints one `<shell> note:` receipt with its diff stats, and refuses to clobber a file that changed since this shell last read it — re-read, then redo.
- `env` for multiline or quote-heavy values. `pty: true` only for interactive programs (`sudo`, `ssh`).
- `&` on builtins, functions, or subshells runs in-process: `$!` is an id ≥ 4194304 that works with `wait`/`kill`/`jobs` but not `ps`/`/proc`. External binaries get real PIDs.
{{#if hasShellBuiltins}}- Common utils are shell builtins (mkdir, jq, sed, xargs, sha256sum, mktemp, sleep, ls, cat, ps, `errno`, …); no availability checks needed. `/usr/bin/sleep` when a real PID matters.
{{/if}}- Internal URI arguments resolve to real paths or fail with a `read` hint.{{#if hasXdev}} `protolens` arguments without a path (`agent://`, `history://`) reach the device as typed.{{/if}}
## Output

Footers are authoritative: `Command exited with code N`, `[Command timed out after N seconds]`, `Backgrounded as job <id>…`, `[Showing lines … Read artifact://N …]`.

Output is already captured. AVOID `head`/`tail`/`| tail -n` just to shorten it: long output shows head and tail windows (over-long lines clipped) and the footer names the artifact holding all of it — `read artifact://N:A-B` for omitted lines.
{{#if py}}

## Python: fresh by default

All Python commands are ordinary processes: inline code, heredocs, scripts, modules, aliases, venvs and subprocesses preserve native arguments, byte streams, signals, exit codes and shutdown hooks. No injected globals or source rewriting. `-I`, `-E` and `-S` opt out of managed startup discovery. NEVER rerun a failed program automatically through another mode.

```sh
python <<'PY'
import proto_harness as harness
source = harness.fs.read_text("src/route.py")
old = 'route = "/v1"'
assert source.count(old) == 1
harness.fs.replace("src/route.py", old, 'route = "/v2"', count=1)
PY
```

- `harness.fs` uses atomic host edits, tool admission, cross-process stale-read checks and receipts. Re-read after `StaleWriteError`. Plain `Path`/`open` keep ordinary Python semantics; use explicit guarded APIs for safe replacement.
- Preserve the project's interpreter/environment. The harness detects the real Python process rather than guessing from command text; it does not modify the installed interpreter.
- `harness.store["result"] = value` explicitly retains a rich Python value between fresh commands. Commits are atomic; conflicting revisions refuse rather than overwrite another command.
- `kernel = harness.kernel("analysis")` selects a persistent namespace. `.run(code)` / `.exec(file)` execute there; `.status()`, `.stop()`, `.restart()` control it. Import `proto_harness as harness` inside its code too. Different names may nest; a kernel MUST NOT wait on itself.
- CLI opt-in: `python -m proto_harness.kernel analysis` reads code from stdin. Ordinary `python` remains fresh.
- Warm kernels retain imports and objects, not fresh-process semantics. Use fresh Python for builds, verification and interpreter-shutdown contracts.
- Warm/store snapshots preserve supported object graphs at exact history boundaries, including aliases and cycles. Unsupported live resources or incompatible snapshots refuse destructive transitions. Model context compression does NOT roll computation back.
- `harness.display` and host receipts are presentation sidebands, never pipe bytes. Program stdout/stderr remain ordinary byte streams.
- Orchestration → write `fleet://name.py`, import the harness and run the file. `harness.parallel` / `pipeline` support checkpoint/resume without implicit heap persistence.
{{/if}}
{{#if js}}

## JavaScript kernel cells

Bare `node`/`nodejs`/`bun` with `-e CODE [args…]`, `- [args…]`, or stdin execute in that runtime's retained kernel. `node`/`bun fleet://name.{js,mjs,ts}` execute the staged script. Other forms are fresh processes. Node and Bun never share a heap. For arguments beginning with `-`, use `-e CODE -- args…`.

Routing holds in pipelines, `&&` lists and command substitutions. Cell-owned async work settles before completion; `retainTask(resource)` explicitly transfers it to kernel lifetime. Never retry an errored cell through a fresh process: side effects may already have happened.

- Top-level bindings persist per lane/runtime. Use `defs()` and existing helpers before defining another; NEVER shadow prelude names.
- Final expressions and `display(...)` render beside program output, never inside pipes or redirects. Unassigned writes cannot corrupt stdout.
- Input reaches `process.stdin`, descriptor 0 and children inheriting stdin. Shell exports and Bash `env` reach the cell.
- `protolens context --resource kernel` inspects, resets, closes or retargets without entering the kernel queue. Use another lane to reset the executing cell.
- JS file APIs are tracked and stale-write guarded: read, assert, write. `StaleWriteError` → re-read and redo the edit.
```js
const source = fs.readFileSync("src/route.js", "utf8");
const old = String.raw`const PATTERN = /v1/;`;
if (source.split(old).length !== 2) throw new Error("anchor count != 1");
fs.writeFileSync("src/route.js", source.replace(old, String.raw`const PATTERN = /v2/;`));
```
{{/if}}
{{#if py}}

## Harness API

{{> kernel-prelude}}
{{else}}{{#if js}}

## Cell API

{{> kernel-prelude}}
{{/if}}{{/if}}
{{#if hasXdev}}

## `protolens` devices

`protolens` is an agent-shell builtin, not on PATH: `bash -c`, supervised processes, and user terminals lack it.
- `protolens <tool> ?` prints the device's docs and CLI usage.
- Flags map to schema fields: `protolens browser --action run --name main`. Positionals fill unflagged scalar fields in usage order: `protolens read src/foo.ts:50-200`.
- Arrays: repeat the flag (one entry each, commas kept), or pass one value split on unescaped commas (`\,` = literal comma), or a JSON array.
- Regex/code/message payloads: single-quoted strings, `protolens jobs --op watch --command 'bun run probe' --match 'ERR [0-9]+'`. A `-` value reads that flag from stdin:
```sh
printf '%s' 'return await tab.observe();' | protolens browser --action run --name main --code -
```
- `protolens <tool> --json '<json>'` passes the raw args object; REQUIRED for MCP devices.
- Exit 0 → result text on stdout. Exit 2 → usage error naming the expected arguments; fix and retry. Exit 1 → tool failure on stderr. Images and structured details stay in the tool result, never in pipes.
- Composes like any command: pipes, redirects, `$(…)`, loops, `&&`, background jobs.
{{/if}}

<critical>
- Footer = status; omitted output lives in the named artifact.
{{#if hasKernelBridge}}- Assert every anchor's count before writing; `StaleWriteError` → re-read, redo.
- New lane → separate shell and kernels. `async` without `lane` → separate shell, shared `main` kernels. `state lost` → rebuild the lost state.{{/if}}
</critical>
