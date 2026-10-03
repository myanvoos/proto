# Upstream fix review — 2026-10-03

## Source and scope

Reviewed `can1357/oh-my-pi` through upstream tip `d19afc2861` (fork merge-base `b8e8c213c1`).
The September 23–24 sync was used to exclude previously finalized work; pending halves were reconsidered.
This review covered **1,751 fix/performance candidates** touching code retained in proto, not an upstream merge.
Features removed from proto, Windows-only paths, and the upstream KDL catalog architecture were not adopted.

[Per-commit ledger](upstream-sync-2026-10-03-ledger.tsv) preserves the review for future syncs.
`PORTED` means the applicable behavior was adapted; mixed commits can have deliberately omitted parts explained in notes.
`SUPERSEDED` includes follow-ups handled by a series owner in another area. Counts are review dispositions, not independent bugs.

| Disposition | Candidate commits |
|---|---:|
| PORTED | 679 |
| PRESENT | 236 |
| SUPERSEDED | 122 |
| N/A | 613 |
| DEFERRED | 101 |

## Highlights

- Shell: quoted heredocs inside command substitution remain literal; shell `ulimit` changes no longer lower proto's own process limits; builtin command lookup and redirected `rg` output are corrected.
- MCP: accepted requests are not replayed after SSE resume/EOF/body failures, diagnostics retain bounded redacted context, OAuth discovery/refresh and reconnect behavior are hardened.
- Isolation: failed patch capture retains the workspace under a unique path; cleanup validates backend metadata and refuses unsafe teardown rather than deleting the only copy.
- Interactive input: Ctrl+Enter detaches drafts before asynchronous work, preserving newer typing and attachments across success and failure. Focused-agent replay, selectors, streaming text and checklist rendering are corrected.
- Sessions: interrupted tool calls are recovered, retry/queue/async delivery races are hardened, session and blob publication/GC are safer, and advisor admission/delivery is repaired.
- Providers: final tool-argument parsing, malformed replay filtering, Cursor terminal/usage handling, thinking limits, account usage and credential rotation behavior are updated without replacing proto's provider architecture.
- Extensions/configuration: prepared factories are reused by children, marketplace validation and environment propagation are corrected, and external configuration edits are preserved.
- Catalog sources were updated and bundled models regenerated with `bun run gen:models`.
- Integration regression fixed: logging's stderr-rotation dependency no longer eagerly imports Bun FFI into standalone Node.js kernels.

Package changelogs contain the detailed user-facing changes. Upstream identifiers and adaptation caveats are retained in the ledger.

## Verification

- `bun run check:ts`: passed workspace Biome and TypeScript checks.
- Final isolated regression sweep: **213 TypeScript test files, 1,565 passing tests, zero failed file processes**. Files were run separately, not as a single whole-suite process.
- `cargo fmt --all -- --check`: passed.
- `cargo clippy -p pi-natives -p pi-shell -p pi-builtins -p pi-walker -p pi-ast --no-deps -- -D warnings`: passed.
- `cargo test -p pi-shell --test heredoc_cmdsubst --test ulimit_isolation --test builtin_regressions`: nine tests passed.
- Focused worker verification additionally exercised the vendored brush-parser suite, native cancellation/accessibility contracts, MCP HTTP servers, retained-workspace failure paths and draft-detachment cases.
- `cargo build -p pi-natives`: passed. Loaded the resulting addon in a separate Bun process and reproduced the quoted-heredoc contract successfully.
- Source CLI `--help` and an isolated PTY TUI session (`/hotkeys`, `/settings`) exercised successfully. No provider inference request was made for this smoke check.

### Verification boundaries

The broader Rust `--all-targets` clippy invocation still rejects `assert!(...is_empty())` in
`crates/pi-shell/tests/file_redirections.rs` and `crates/pi-natives/src/diff.rs` under the current nightly lint.
Those diagnostics were not suppressed; the production targets and focused regression tests above passed.
Platform-specific macOS/Wayland behavior was not verified on live desktops. Retained Overlayfs/Btrfs cleanup tests use native-boundary spies, not privileged mounts.
The generated catalog used the generator's normal fallback behavior where provider credentials were unavailable.
Installed/compiled proto executables and the packaged native addon were not replaced; the native smoke used the freshly built addon in a scratch location.

## Deliberately deferred

The ledger's `DEFERRED` rows are **not included fixes**. They retain specific counterpart files and follow-up approaches.
Major groups:

- Auth/broker concurrency and persistence protocols: shared reset redemption, sibling-rotation waiting, protected block scopes and refresh-churn cooldowns.
- Session ownership/move/IRC transition redesigns and new queue-admission/continuation protocols.
- Browser relay Runtime virtualization/multi-instance routing and native Wayland/macOS lifecycle changes.
- Model-cache schema/materialization changes, deferred extension prewalk resolution and extension-root policy propagation.
- Large transcript/Markdown/logger/status-line performance rewrites that require separate profiling and adaptation.
- Product/semantic changes such as expanded advisor tool I/O, persisted checklist dismissal and upstream statement-range semantics.

These were not prerequisites for the selected ports. The existing proto contracts remain in place rather than receiving partial implementations.

## Execution notes

The initial uncommitted agent-abort/output change was committed separately as `d24eddcdf7` after its focused tests passed.
Work was split into area workers requested as Opus 5.5 with fleet `effort: med`; heavier selected ports used GPT-6 Astra.
Fleet's relative `med` resolved to the displayed `high` tier for these model ladders. Some Opus turns automatically fell back to GPT-5.6 Luna under the configured provider fallback policy.
The host restarted during the review; workers were resumed from their durable ledgers and final checks rerun.
Heavy-command wrappers were memory-gated, and a low-memory alert was configured at **MemAvailable below 5 GiB**, as requested. No reboot cause is asserted here.
