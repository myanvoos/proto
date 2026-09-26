Runs commands in the agent shell{{#if hasKernelBridge}}; bare {{#if py}}`python`{{/if}}{{#ifAll py js}}/{{/ifAll}}{{#if js}}`node`/`bun`{{/if}} code runs as cells in a persistent kernel{{/if}}.

<critical>
- Status comes from the tool-result footer, NEVER from program text.
{{#if hasKernelBridge}}- Edit files in kernel cells: read, assert each anchor occurs exactly once, then write.
- Only the bare forms in the routing table reach the kernel; everything else is a fresh process with no kernel state.{{/if}}
</critical>

## Shell

- Set `cwd` instead of `cd`; every call{{#if hasKernelBridge}}, kernel cells included,{{/if}} starts there (default: session directory).
- `lane` defaults to `"main"`. Calls in one lane run one at a time in issue order and share shell variables, functions, and aliases{{#if hasKernelBridge}}, plus kernel state{{/if}}. Different lanes run concurrently with separate state.
- Dependent steps → one call chained with `&&`; a failed call does not stop calls already queued behind it.
{{#if asyncEnabled}}- `async: true` without `lane` runs in its own fresh lane: none of `main`'s shell{{#if hasKernelBridge}} or kernel{{/if}} state. Needs that state → pass `lane:"main"` (later `main` calls queue behind it). `async` does not extend `timeout`.
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
{{#if hasKernelBridge}}

## Kernel cells

**Ordinary interpreter code, retained state, additive tools.** Preserve native language semantics, program arguments, stdout/stderr bytes, and exit status within a cell; persistence and the prelude add capabilities rather than a different programming language. Use normal interpreter idioms.

- Rich displays, final-expression values, and harness notes are presentation sidebands: visible in the tool result, never inserted into pipes, redirects, or command substitutions. A write's return value cannot corrupt its output; no `_ =` / `void` suppression is needed.
- Persistence is not a fresh OS process: bindings and explicitly retained work survive cells; interpreter-shutdown hooks and Python thread/executor lifetimes belong to the kernel process. Use a real subprocess when process isolation or interpreter teardown is part of the program's contract. Never retry a failed cell automatically in a fresh process: its side effects may already have happened.

Routing (non-PTY):

|Command|Runs as|
|---|---|
{{#if py}}| `python` with `-c CODE [args…]`, `- [args…]`, or code on stdin | Python kernel cell on the interpreter the shell resolves (`python3.N`, `.venv/bin/python`, an activated venv); one kernel per interpreter per lane |
|`python fleet://<name>.py [args…]`|Python kernel cell running that file|
{{/if}}{{#if js}}| `node`/`nodejs`/`bun` with `-e CODE [args…]`, `- [args…]`, or code on stdin | JS kernel cell: `node` = Node.js on PATH, `bun` = Bun; separate heaps |
|`node`/`bun` `fleet://<name>.{js,mjs,ts} [args…]`|JS kernel cell running that file|
{{/if}}| Anything else | Fresh process |

Routing holds wherever the agent shell runs the command itself: pipelines, `&&` lists, `$(…)`. Program arguments stay in the kernel; for JS arguments starting with `-`, use `-e CODE -- args…` so they are not interpreter options.

Cells → file edits, multi-step logic, data processing, tool calls in loops, orchestration. Shell → programs, builds, tests, git.

Pass code through a quoted heredoc:
```sh
{{#if py}}python <<'PY'
print(sum(range(10)))
PY{{else}}node <<'JS'
console.log(40 + 2);
JS{{/if}}
```

- Top-level variables, imports, and definitions persist per lane and language; ordinary cell-owned async work settles before completion. Run `defs()` before writing a helper: reuse earlier definitions; NEVER shadow prelude names.
{{#if py}}- Ordinary synchronous Python cells support `asyncio.run()`; top-level `await` is an additive option.
- Python imports resolve like a fresh interpreter in the cell's cwd and `PYTHONPATH`: edited project modules re-import from disk; names bound in earlier cells keep the old objects.
{{/if}}- A bare final expression displays its value beside program output, like a notebook. {{#if py}}`retain_task(task)` keeps an asyncio task beyond the cell; {{/if}}{{#if js}}`retainTask(resource)` keeps an unref-capable JS resource beyond the cell; {{/if}}retained work still ends when the kernel closes.
- Shell exports and `env` reach cells. Stdin piped into {{#if py}}`python -c CODE`{{/if}}{{#ifAll py js}} / {{/ifAll}}{{#if js}}`node -e CODE`{{/if}} is program input; stdout/stderr are binary-safe{{#if py}} (`sys.stdin.buffer`, `sys.stdout.buffer`){{/if}}.{{#if js}} Node/Bun input also reaches descriptor 0 (`fs.readFileSync(0)`, `fs.readSync`) and children inheriting stdin.{{/if}}
- Orchestration (`agent()`, `parallel()`, `pipeline()`) → write the script to `fleet://<name>.{{#if py}}py{{else}}mjs{{/if}}` (session scratch dir), run `{{#if py}}python{{else}}node{{/if}} fleet://<name>.{{#if py}}py{{else}}mjs{{/if}}`. Fix and re-run the file instead of resending code; with `checkpoint` + `resume`, finished items are skipped.
- `protolens context --resource kernel` inspects, resets, closes, or retargets interpreters (local, container, or SSH); configuration changes need a reset.{{#if py}} `--op start --language python --interpreter <path>` makes that interpreter the lane's bare `python`.{{/if}} Use `--resource lane` for whole-lane lifecycle control from another lane.

### Editing files

Plain file APIs ({{#if py}}`open`, `Path`, `os`{{/if}}{{#ifAll py js}}; {{/ifAll}}{{#if js}}JS `fs` / `node:fs`{{/if}}) are tracked. Each changed path prints one `<kernel> note:` line with its diff stats — that is the write receipt; no re-read needed.
- A file changed on disk since the kernel last read it → the write raises `StaleWriteError` before truncating. Re-read, redo the edit.
- Shell writes that own their target (`cat > file`, `>>`, `tee`, builtin `sed -i`) are tracked and guarded the same way, reporting `<shell> note:`. Writes inside other programs (`git apply`, `bash -c`, an installed binary) bypass both.

{{#if py}}
Canonical replace: short anchor as a Python literal, assert right after it, then the payload. In this exact shape — `from pathlib import Path`, `Path("…").read_text()`, `assert text.count(old) == 1` — a wrong anchor stops generation before the payload streams.
```python
from pathlib import Path
path = Path("src/route.py")
source = path.read_text()
old = r'PATTERN = r"/v1/\d+"'
assert source.count(old) == 1
new = r'PATTERN = r"/v2/\d+"'
path.write_text(source.replace(old, new))
```
- Multi-line anchor or payload → `r'''…'''`; build the replacement from parts when it contains both quote styles.
- Whole function or class → `block_range(path, line)` gives its 1-based inclusive lines; splice those.
{{else}}
Canonical replace: read, assert, write:
```js
const source = fs.readFileSync("src/route.js", "utf8");
const old = String.raw`const PATTERN = /v1/;`;
if (source.split(old).length !== 2) throw new Error("anchor count != 1");
fs.writeFileSync("src/route.js", source.replace(old, String.raw`const PATTERN = /v2/;`));
```
- Whole function or class → `blockRange(path, line)` gives its 1-based inclusive lines; splice those.
{{/if}}

## Cell API

{{> kernel-prelude}}
{{/if}}
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
- New lane, `async` without `lane`, or a `state lost` notice → earlier state is absent.{{/if}}
</critical>
