# Python: fresh processes, explicit library and named kernels

The Python execution overhaul is **unreleased**, following the v20/P5 selected-data continuity work. Ordinary Python now runs as real fresh processes. The explicit `proto_harness` library provides host integration; optional named kernels provide warm namespaces. This page describes those current contracts, not the former implicit Bash-to-kernel routing.

## Choose execution and persistence independently

| Need | Surface |
|---|---|
| Native Python process | `python script.py`, `python -c '...'`, `python -`, heredocs, modules, aliases, shebangs or subprocesses |
| Host tools, models, artifacts, safe edits | `import proto_harness as harness` in a managed agent-shell process |
| Durable session-owned Python values | `harness.store` |
| Optional warm namespace | `harness.kernel("analysis")` or `python -m proto_harness.kernel analysis` |

Ordinary commands, interactive `$` / `$$` Python submissions and fresh `executePython` API calls do not reuse a hidden namespace. Native argv, binary stdin/stdout/stderr, exit codes, signals, `atexit`, `asyncio.run()` and import semantics remain native. No automatic source transformation, injected `tool`/`Path`/helper globals, IPython magics or project-module reload hooks are part of this API. Use ordinary Python (`os.chdir`, `os.environ`, `subprocess`, `time`, `runpy`) or explicit harness calls rather than `%reset`, `%pip` or shell-escape syntax.

Interactive Python uses `$ code` (included in model context) or `$$ code` (excluded). `! command` / `!! command` are **shell** shortcuts; `!!` is excluded shell execution, not Python.

For example, two ordinary commands are independent:

```bash
python -c 'value = 10; print(value)'
python -c 'print("value" in globals())'  # False
```

Managed agent-shell integration stages a tiny `sitecustomize` bootstrap and the public package without modifying the user's installed Python. The bootstrap detects actual CPython invocation and authenticates the run; it chains an existing `sitecustomize`. `-I`, `-E` and `-S` remain ordinary explicit opt-outs from that environment integration. Plain startup does not eagerly load cloudpickle or the host helper stack. The public package is **`proto_harness`**, not a shadow of the external `proto` CLI or a third-party `proto` package.

## Explicit host library

```python
import proto_harness as harness

result = harness.tool.read({"path": "package.json"})
print(result)
```

Helpers are run/session/owner authenticated and use the existing canonical host bridges. Calling them does not bypass tool availability, extension `tool_call` policy/schema validation, spawn authority, execution admission, cancellation or turn budget. Run capabilities are revoked when the owning shell invocation completes or aborts. There is no peer-supplied session-ID authority.

### Tools, completions and agents

- `harness.tool.<name>(args)` calls an enabled host tool; keyword arguments are also supported. A blocked or unavailable tool raises a visible error.
- `harness.completion(prompt, *, model="default", system=None, schema=None)` performs a stateless, tool-free completion. Model roles/IDs use the configured session pool; ambiguous IDs need `provider/id`. With a JSON schema it returns parsed data, otherwise text.
- `harness.agent(prompt, *, agent=None, model=None, label=None, schema=None, schema_mode=None, isolated=None, apply=None, merge=None, handle=False)` blocks for a subagent result. With no explicit agent, the host selects the effective permitted role. `model` accepts a role alias or concrete model ID and is validated against the effective role's configured bank. `schema` overrides agent/session schemas; `schema_mode` is `"permissive"` or `"strict"`. Isolation/apply/merge preserve the existing worktree policy.
- `agent()` returns final text or parsed structured data. `handle=True` returns a result-node mapping with `text`, `output`, `handle`, `id` and `agent`; `handle` is a recoverable `agent://<id>` URI when a child reference exists. Parsed output is under `data` when available. Isolation metadata can include `patch_path`, `branch_name`, nested patch fields, `changes_applied` and `isolation_summary`.
- `harness.output(*ids, format="raw"|"json"|"stripped", query=None, offset=None, limit=None)` reads agent/task output. It does not read Bash output artifacts; use `harness.tool.read({"path": "artifact://..."})` for those.

### Workflows and cancellation

`harness.parallel(thunks, **options)` runs zero-argument callables concurrently and preserves input order. `harness.pipeline(items, *stages, streaming=False, **options)` maps values through stages: each stage normally waits for all items; streaming advances each item independently.

Shared options include `concurrency=N`, `settled=True`, `timeout` (seconds per item), `cancel` (a threading event), `on_result(row)`, `checkpoint=dir`, `key=str`, `keys=[...]` and `resume=True`. Failure normally raises `harness.BatchError`, with every row in `.results`; settled mode returns `{status, index, stage, value|error}` rows. Long-running loops call `harness.task_signal().check()` for cooperative deadlines/cancellation. Running callbacks drain before the workflow returns. Checkpoints persist successful JSON-compatible results, require stable unique item keys for parallel calls, and resume completed work without automatic retries; change the checkpoint key when code changes.

```python
import proto_harness as harness

results = harness.parallel([
    lambda: harness.completion("Summarize the first approach"),
    lambda: harness.completion("Summarize the second approach"),
], concurrency=2)
```

Use the enclosing Bash command's timeout for ordinary process lifetime. Helper item deadlines do not turn arbitrary Python threads or native code into forcibly cancellable computations.

### Safe filesystem operations and source inspection

`harness.fs.read_text(path)`, `read_bytes(path)`, `write_text(path, content)`, `write_bytes(path, content)` and `replace(path, old, new, count=1)` use permission-checked host filesystem operations. Writes are atomic and honor the shared stale-observation guard across tools/processes. `harness.StaleWriteError` means re-read, reconstruct the edit and retry deliberately; do not blindly overwrite.

```python
import proto_harness as harness

text = harness.fs.read_text("src/config.py")
old = "DEBUG = True"
assert text.count(old) == 1
harness.fs.write_text("src/config.py", text.replace(old, "DEBUG = False"))
```

`harness.symbols(path=None, *, code=None, lang=None)` returns a structural outline; `harness.block_range(path, line)` returns inclusive 1-based syntactic block bounds. Path-taking harness filesystem/source helpers address the **host filesystem**, including from remote kernels. Native Python `Path`/`open` address the executing interpreter's filesystem and keep native semantics; they are not monkey-patched. For internal resources such as `skill://` or `artifact://`, call `harness.tool.read` rather than treating the URI as a filesystem path.

### Displays, artifacts, status and owned tools

- `harness.display(value)` publishes rich displays explicitly. Text/JSON, images and supported MIME representations follow existing bounded rendering/output admission; display sidebands do not become stdout bytes.
- `harness.publish_artifact(value, kind="json", path=None, ...)` publishes immutable data and returns a reference. `read_artifact(ref, offset=0, length=None, encoding=None)` pages artifacts published through this API; `resolve_artifact(ref)` validates a reference. These are distinct from tool-output artifact reads.
- `harness.executions(id=None, limit=20)` returns recent owned Bash execution captures, including bounded/truncated capture metadata. It is not permission to rerun uncertain effects.
- `harness.log(message)`, `phase(title)` and `env(key=None, value=None)` expose explicit status/environment helpers. `harness.budget.total`, `.spent()` and `.remaining()` read the live host goal budget.
- `start_tool(name, args)` starts owned execution; `tool_events(handle, cursor=0, limit=128, wait_ms=30000)` streams retained events. Leaving the iterator does not cancel the tool: call `cancel_tool`, then `dispose_tool` after settlement.
- `delegate(grants, ttl_ms=..., max_concurrent=..., max_requests=...)`, `launch_delegated(...)`, `delegations()` and `revoke_delegation(...)` retain bounded scoped external-tool leases. They are capabilities, not a sandbox; never print capability tokens/files.

All helpers in this section are attributes of `harness`, not implicitly installed globals.

## Durable session store

```python
import proto_harness as harness

shared = []
shared.append(shared)
with harness.store.transaction() as store:
    store["left"] = shared
    store["right"] = shared
```

A later compatible fresh process in the same session can read `harness.store["left"] is harness.store["right"]` and the self-cycle. The store serializes its **entire mapping as one graph**, not independent per-key pickle files. Assignment/deletion commits automatically; in-place nested mutations need `commit()` or a successful transaction batch. `refresh()` loads the current durable graph; `revision` identifies its CAS revision. A stale writer fails without automatic retry or overwriting a competing writer. Transactions batch one commit; they are not cross-process locks or rollback of external effects.

The graph uses lazy vendored cloudpickle **3.1.2**, preserving supported aliases/cycles, closures, functions, classes and module metadata. Native-store validation uses its captured interpreter, including the virtualenv launcher and prefix, independently of the named-kernel Python 3.10 minimum. A compatible native Python 3.9 store does not require a Python 3.9 warm kernel. Its **64 MiB encoded payload** limit is base64 text, not 64 MiB of raw heap/pickle. Trusted session-local graphs must not be treated as safe untrusted pickle uploads. Interpreter/format/module environment compatibility is validated before restore; unsupported live resources are refused rather than silently converted or discarded.

## Optional named warm kernels

```python
import proto_harness as harness

kernel = harness.kernel("analysis")
first = kernel.run("values = [1, 2, 3]")
second = kernel.run("print(sum(values))")
print(kernel.status())
```

`harness.kernel(name="main", *, interpreter=None, cwd=None, target=None)` returns a handle. `run(code)` submits code; `exec(file)` executes a script in that warm namespace; `status()` reports lifecycle/environment/residency; `stop()` closes and forgets its configuration; `restart()` intentionally discards its namespace and starts a new generation. Explicit reset/close is not a request to restore old state.

Named kernels belong to their authenticated owner/name/interpreter/environment, not the calling fresh process's globals. Separate workers own separate namespaces/store state; copied ancestor history is not live ownership. Compatible same-name calls reuse the warm namespace; change cwd/target deliberately with restart, and disambiguate an interpreter when a name has multiple environments. Nested named kernels are supported, but a kernel cannot synchronously depend on itself or a waiting ancestor.

The CLI streams code output and maps execution status to process exit status:

```bash
python -m proto_harness.kernel analysis -c 'values = [1, 2, 3]'
python -m proto_harness.kernel analysis -c 'print(sum(values))'
python -m proto_harness.kernel analysis --file analyze.py
python -m proto_harness.kernel analysis <<'PYCODE'
import proto_harness as harness
harness.display({"sum": sum(values)})
PYCODE
```

CLI options include `--interpreter` and `--cwd`. Omitted options preserve the named environment configuration instead of selecting the caller's interpreter; remote runs use the configured target cwd. Explicit interpreter selectors are resolved by the selected runtime: local bare names follow the invocation PATH, relative paths follow cwd, and remote-only paths are not checked against the host filesystem. With `-c` or `--file`, piped stdin is program input; otherwise stdin supplies code. No notebook gateway is involved.

### Execution, imports and failure

Warm cells execute in order on the main thread. Ordinary synchronous cells have no active event loop, so `asyncio.run()` remains native. Explicit top-level await is supported; cell-owned tasks settle before completion. Warm-only `harness.retain_task(task)` transfers a task on the top-level-await loop to kernel lifetime; such live work prevents safe durable capture. User threads/executors likewise have process lifetime, not cell lifetime.

Warm imports remain native **persistent** imports: editing a file does not evict its old module or rebind earlier objects. Use explicit `importlib.reload` where appropriate or restart deliberately. A failed cell can retain definitions/mutations completed before failure. Errored or interrupted cells are never silently replayed; inspect partial effects before retrying. Uncaptured/dirty state after process loss refuses an older or fresh substitute rather than claiming continuity.

Warm-only `harness.defs()` and `harness.kernel_state(limit=200)` inspect current bindings/generation. Persistence uses `harness.store` or automatic whole-namespace history graphs. The old Python selected-file codec and manual save/load helpers are removed, not retained as aliases.

### Exact continuity and resource limits

Warm Python automatically captures the whole supported namespace as one graph at exact history/continuity boundaries. There is no `declare_state` opt-in and no per-binding serialization that breaks aliases. Immutable manifests commit durably under the existing owner/kernel gate before boundary-dependent teardown, temporal navigation or fork. Historical snapshots survive with their branches: no twenty-turn cutoff, nearest-earlier restore or silent fresh fallback. Lazy restore validates the selected interpreter, working directory, target and declared module environment. Open files, sockets, generators, live tasks/threads and unsupported OS resources refuse capture **before destruction**, leaving the source usable.

Interactive fork creates a destination-owned independent root/graph/store copy and leaves the source unchanged. Parking and host restart preserve exact durable computation; explicit handle restart discards it. None restores workspace files, installed packages or external process state. Model context-only `checkpoint`/`rewind(report)` preserves current computation instead of applying temporal restoration. See [session operations](./session-operations.md#declared-state-at-temporal-boundaries).

State transport has **96 MiB** envelope framing; ordinary HTTP requests remain **8 MiB**, and the ordinary warm request queue remains **16 MiB**. Python residency defaults to `python.kernelMemoryBudgetBytes = min(25% physical RAM, 4 GiB)` and `python.kernelMaxResidentCount = 64`, separate from runnable concurrency and JavaScript's **256 total / 16 owner** admission pool. Under measured pressure only idle, durably restorable LRU kernels park; busy, dirty, frozen or unknown state is not evicted. Unknown pressure refuses unsafe admission, not a made-up memory guarantee.

Supported local POSIX CPython uses a real per-interpreter sterile, single-threaded `-I -S` forkserver, with child threads/user imports only after fork and buffered `node:net` transport. Other supported targets report explicit spawn/remote launch mode. Memory accounts for parent and children using macOS physical footprint/Linux private mappings, not summed RSS. Capacity releases only after actual process settlement. See [memory policy and scoped measurements](./interactive-memory.md#interpreters-subprocesses-and-provider-state); local samples establish neither cross-platform performance nor a whole-application RSS ceiling.

## Troubleshooting

- **A later command cannot see a variable:** ordinary commands are fresh. Persist a value in `harness.store` or explicitly submit both computations to the same named kernel.
- **`proto_harness` unavailable:** run in the managed agent-shell environment with its staged package; `-I`, `-E`, `-S` deliberately opt out. Ordinary external Python still runs natively; no alternate interpreter/kernel is silently substituted.
- **Host helper refused:** inspect enabled tools, extension policy, authority, cancellation and budget. Importing the package does not grant tools the owning agent lacks.
- **Store conflict:** `refresh()`, reconcile the competing state and commit deliberately. Do not blindly retry a stale whole-graph overwrite.
- **Transition or admission refused:** remove/finish unsupported live resources or commit at a valid boundary; inspect status/reasons. Do not delete state or reset the kernel to hide a dirty/unknown failure.
- **Imports appear old in a warm kernel:** persistent `sys.modules` is native behavior; reload deliberately or explicitly restart. Fresh processes use normal fresh imports.

## Implementation owners

Paths are under `packages/coding-agent/src/`: `eval/py/proto_harness/` (public library and vendored codec), `eval/py/harness-bridge.ts` (authenticated runs), `eval/py/harness-dispatch.ts` (canonical host dispatch), `eval/py/python-store.ts` (durable graph CAS), `eval/py/executor.ts` (fresh/explicit warm execution), `eval/py/kernel.ts` and `runner.py` (warm runtime), `eval/declared-state.ts` (exact manifests), and `eval/kernel-memory.ts` / `eval/py/forkserver.*` (residency/launch). JavaScript's prelude/routing and data-only `declareState` are unchanged by this Python cutover.
