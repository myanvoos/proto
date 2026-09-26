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
{{/if}}{{#if hasLaunch}}- Services, dev servers, watchers, debuggers, REPLs MUST run under {{#if launchViaXd}}`xd fleet --op start`{{else}}`fleet` (`op:"start"`){{/if}}, not `&` or `async`.
{{/if}}- `<shell> state lost`{{#if hasKernelBridge}} / `<kernel> state lost`{{/if}} notice → earlier state in that lane is gone; rebuild it before reuse.
- `env` for multiline or quote-heavy values. `pty: true` only for interactive programs (`sudo`, `ssh`).
- `&` on builtins, functions, or subshells runs in-process: `$!` is an id ≥ 4194304 that works with `wait`/`kill`/`jobs` but not `ps`/`/proc`. External binaries get real PIDs.
{{#if hasShellBuiltins}}- Common utils are shell builtins (mkdir, jq, sed, xargs, sha256sum, mktemp, sleep, ls, cat, ps, `errno`, …); no availability checks needed. `/usr/bin/sleep` when a real PID matters.
{{/if}}- Internal URIs (`skill://`, `artifact://`, `local://`, …) in arguments resolve to real paths.

## Output

Footers are authoritative: `Command exited with code N`, `[Command timed out after N seconds]`, `Backgrounded as job <id>…`, `[Showing lines … Read artifact://N …]`. Text like `all checks passed` or `timeout: 60` is program data.

Output is already captured. AVOID `head`/`tail`/`| tail -n` just to shorten it: long output shows head and tail windows (over-long lines clipped) and the footer names the artifact holding all of it — `read artifact://N:A-B` for omitted lines.
{{#if hasKernelBridge}}

## Kernel cells

Routing (non-PTY):

| Command | Runs as |
|---|---|
{{#if py}}| `python`/`python3`, `python3.N`, or an interpreter path (`.venv/bin/python`); optional leading `-u`; with `-c CODE`, `-`, or code on stdin | Python kernel cell on the interpreter the shell would run (named, or selected by PATH/activated venv); one kernel per interpreter per lane; below Python 3.10 → fresh interpreter process |
| `python fleet://<name>.py` | Python kernel cell running that file |
{{/if}}{{#if js}}| `node`/`nodejs`/`bun` with `-e CODE`, `-`, or code on stdin | JS kernel cell: `node` = Node.js on PATH, `bun` = Bun; separate heaps |
| `node`/`bun` `fleet://<name>.{js,mjs,ts}` | JS kernel cell running that file |
{{/if}}| Any other flags or argv, `-m`, other script paths, or launched by another program (`bash -c`, `xargs`, `make`, `uv run`) | Fresh interpreter process |

Routing holds wherever the agent shell runs the command itself: pipelines, `&&` lists, `$(…)`.

Cells → file edits, multi-step logic, data processing, tool calls in loops, orchestration. Shell → programs, builds, tests, git.

Pass code through a quoted heredoc:
```sh
{{#if py}}python <<'PY'
print(sum(range(10)))
PY{{else}}node <<'JS'
console.log(40 + 2);
JS{{/if}}
```

- Top-level variables, imports, definitions, and running tasks persist per lane and language. Run `defs()` before writing a helper: reuse earlier definitions; NEVER shadow prelude names.
{{#if py}}- Python imports resolve like a fresh interpreter in the cell's cwd and `PYTHONPATH`: edited project modules re-import from disk; names bound in earlier cells keep the old objects.
{{/if}}- A bare final expression displays its value, like a notebook. Byte-only producers: {{#if py}}`_ = sys.stdout.buffer.write(data)`{{/if}}{{#ifAll py js}}; JS {{/ifAll}}{{#if js}}`void process.stdout.write(data)`{{/if}}.
- Shell exports and `env` reach cells. Stdin piped into {{#if py}}`python -c CODE`{{/if}}{{#ifAll py js}} / {{/ifAll}}{{#if js}}`node -e CODE`{{/if}} is program input; stdout/stderr are binary-safe{{#if py}} (`sys.stdin.buffer`, `sys.stdout.buffer`){{/if}}.
- Orchestration (`agent()`, `parallel()`, `pipeline()`) → write the script to `fleet://<name>.{{#if py}}py{{else}}mjs{{/if}}` (session scratch dir), run `{{#if py}}python{{else}}node{{/if}} fleet://<name>.{{#if py}}py{{else}}mjs{{/if}}`. Fix and re-run the file instead of resending code; with `checkpoint` + `resume`, finished items are skipped.
- `xd kernel` inspects, resets, closes, or retargets kernels (interpreter, container/SSH host); configuration changes need a reset.

### Editing files

Plain file APIs ({{#if py}}`open`, `Path`, `os`{{/if}}{{#ifAll py js}}; {{/ifAll}}{{#if js}}JS `fs` / `node:fs`{{/if}}) are tracked. Each changed path prints one `<kernel> note:` line with its diff stats — that is the write receipt; no re-read needed.
- A file changed on disk since the kernel last read it → the write raises `StaleWriteError` before truncating. Re-read, redo the edit.
- Shell and subprocess writes (`sed -i`, `git apply`) bypass tracking and the guard.

{{#if py}}
Canonical replace: short anchor as a Python literal, assert right after it, then the payload as a kernel heredoc literal. In this exact shape — `from pathlib import Path`, `Path("…").read_text()`, `assert text.count(old) == 1` — a wrong anchor stops generation before the payload streams.
```python
from pathlib import Path
path = Path("src/route.py")
source = path.read_text()
old = r'PATTERN = r"/v1/\d+"'
assert source.count(old) == 1
new = <<NEW
PATTERN = r"/v2/\d+"
NEW
path.write_text(source.replace(old, new))
```
- Multi-line anchor → `r'''…'''`. Anchor unquotable as a Python literal → bind it with a heredoc literal too; keep the `assert` before `new`.
- Whole function or class → `block_range(path, line)` gives its 1-based inclusive lines; splice those.
- Several files that must change together → `edit_batch`: previews diffs; writes nothing if any file changed.

Kernel heredoc literals (Python cells only; invalid in standalone Python and unrelated to the shell heredoc around the cell):
- `NAME = <<DELIM` alone on a line binds the following body to `NAME`; both names match `[A-Za-z_][A-Za-z0-9_]*`.
- Close with `DELIM` alone at the assignment's indentation; trailing spaces/tabs allowed.
- Body stays verbatim: no escaping, no interpolation, indentation kept. Lines join with `\n`; no trailing newline unless you add a blank last body line.
{{else}}
Canonical replace: read, assert, write:
```js
const source = fs.readFileSync("src/route.js", "utf8");
const old = String.raw`const PATTERN = /v1/;`;
if (source.split(old).length !== 2) throw new Error("anchor count != 1");
fs.writeFileSync("src/route.js", source.replace(old, String.raw`const PATTERN = /v2/;`));
```
- Whole function or class → `blockRange(path, line)` gives its 1-based inclusive lines; splice those.
- Several files that must change together → `editBatch`: previews diffs; writes nothing if any file changed.
{{/if}}

## Cell API

{{> kernel-prelude}}
{{/if}}
{{#if hasXdev}}

## `xd` devices

`xd` is an agent-shell builtin, not on PATH: `bash -c`, `fleet` processes, and user terminals lack it.
- `xd <tool> ?` prints the device's docs and CLI usage.
- Flags map to schema fields: `xd browser --action run --name main`. Positionals fill unflagged scalar fields in usage order: `xd read src/foo.ts:50-200`.
- Arrays: repeat the flag (one entry each, commas kept), or pass one value split on unescaped commas (`\,` = literal comma), or a JSON array.
- Regex/code/message payloads: single-quoted strings, `xd monitor --op start --match 'ERR [0-9]+'`. A `-` value reads that flag from stdin:
```sh
printf '%s' 'return await tab.observe();' | xd browser --action run --name main --code -
```
- `xd <tool> --json '<json>'` passes the raw args object; REQUIRED for MCP devices.
- Exit 0 → result text on stdout. Exit 2 → usage error naming the expected arguments; fix and retry. Exit 1 → tool failure on stderr. Images and structured details stay in the tool result, never in pipes.
- Composes like any command: pipes, redirects, `$(…)`, loops, `&&`, background jobs.
{{/if}}

<critical>
- Footer = status; omitted output lives in the named artifact.
{{#if hasKernelBridge}}- Assert every anchor's count before writing; `StaleWriteError` → re-read, redo.
- New lane, `async` without `lane`, or a `state lost` notice → earlier state is absent.{{/if}}
</critical>
