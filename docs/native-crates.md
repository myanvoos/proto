# Native Crates

Contributor map for Rust workspace members under `crates/`. They are implementation details behind `@oh-my-pi/pi-natives` and its embedded shell; package consumers use JavaScript entrypoints, not these crate APIs.

The root `Cargo.toml` lists every crate under `crates/` explicitly in `workspace.members` — add new crates there. It also patches crates.io `grep-searcher` to the vendored copy so the shell utilities can feed a search from readiness-driven buffers (`Searcher::search_push`).

## First-party crates

| Crate           | Path                                              | Role and consumers                                                                                                                                              |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-natives`    | [`crates/pi-natives`](../crates/pi-natives)       | Top-level N-API `cdylib`. It exposes the JS-visible API and depends on `pi-ast`, `pi-iso`, `pi-shell`, and `pi-walker`.                                          |
| `pi-shell`      | [`crates/pi-shell`](../crates/pi-shell)           | The embedded bash 5.3 engine (with zsh dialect): parser (`bash::syntax`), pattern matcher, VM, the OS and `pi-vfs` hosts, persistent sessions (`session`, `child_session`), pi's host callouts (`tools`: `timeout`, `nohup`, `git`, command runners), the utilities as engine commands (`extras`), the minimizer, and the API `pi-natives` exports (`Shell`, `execute_shell`, `process`). |
| `pi-builtins`   | [`crates/pi-builtins`](../crates/pi-builtins)     | In-process command-line utilities and process builtins (`cat`, `grep`/`rg`, `sed`, `ls`, `find`, `jq`, `fd`, `diff`, `rsync`, `ps`, `top`, the moreutils set, …). `src/host.rs` holds the `Utility`/`AsyncUtility` traits and the `Host` view of the shell (stdio, working directory, exported environment, cancellation, command runner) that the utilities run against; `src/extras.rs` is the engine-neutral `extras()`/`run(Invocation)` entry point. Ports of uutils coreutils/findutils/sed and jaq live here too; see the crate `LICENSE` for third-party notices. |
| `pi-vfs`        | [`crates/pi-vfs`](../crates/pi-vfs)               | The engine's virtual filesystem host: providers, `Fs`, files/dirs/metadata/paths, canonicalization, and the native unix/windows backends.                     |
| `pi-vcs`        | [`crates/pi-vcs`](../crates/pi-vcs)               | In-process version control (gitoxide and jj-lib) used by the shell's `git` callout and worktree handling.                                                       |
| `pi-diff`       | [`crates/pi-diff`](../crates/pi-diff)             | Unified/structured diff primitives shared by `pi-iso` and `pi-builtins`.                                                                                        |
| `pi-ast`        | [`crates/pi-ast`](../crates/pi-ast)               | tree-sitter/ast-grep language registry, matching/editing, block analysis, and summarization support across the workspace grammar set.                           |
| `pi-iso`        | [`crates/pi-iso`](../crates/pi-iso)               | Isolation backend implementations and diffing for APFS, Linux/Windows clone/reflink paths, overlayfs, ProjFS, and recursive copy fallback.                      |
| `pi-walker`     | [`crates/pi-walker`](../crates/pi-walker)         | Parallel, cache-aware filesystem walker and grep engine over `pi-vfs`; shared by native grep/glob/workspace paths and shell commands.                           |

## Vendored workspace crates

| Group | Paths | Purpose |
| ----- | ----- | ------- |
| grep-searcher | [`crates/vendor/grep-searcher`](../crates/vendor/grep-searcher) | Vendored ripgrep `grep-searcher` 0.1.17 plus `Searcher::search_push`, the chunk-fed search the async shell utilities need. Its manifest retains upstream package metadata; the workspace patch selects this local fork. |

`pi_builtins::extras::extras()` is the authoritative list of commands linked into the embedded shell; `pi-shell` decides which of them to register (`extras.rs`) and which run as host callouts (`tools/`). A directory being a workspace member does not by itself mean that `pi-natives` exposes it as a JavaScript API.

## Boundary map

```text
@oh-my-pi/pi-natives JS entrypoints
  -> pi-natives (N-API conversion, platform bindings, task boundaries)
       -> pi-ast / pi-iso / pi-vcs / pi-walker / pi-vfs
       -> pi-shell
            -> bash engine (syntax, pattern, VM)
            -> pi-vfs (virtual filesystem host)
            -> tools (timeout, nohup, git, command runners)
            -> extras -> pi-builtins (utilities; host.rs: per-invocation I/O and cwd)
            -> pi-vcs (git/jj)
```

For the loader and JS boundary, see:

- [`natives-architecture.md`](./natives-architecture.md)
- [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)
- [`natives-binding-contract.md`](./natives-binding-contract.md)

Subsystem details live in:

- [`natives-build-release-debugging.md`](./natives-build-release-debugging.md)
- [`natives-media-system-utils.md`](./natives-media-system-utils.md)
- [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md)
- [`natives-shell-pty-process.md`](./natives-shell-pty-process.md)
- [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md)
- [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md)

## Documentation policy

These crates remain contributor-facing implementation details. Promote one to standalone user-facing documentation only when it gains a public API or executable consumed independently of `@oh-my-pi/pi-natives`; see [`user-facing-packages.md`](./user-facing-packages.md).
