# Session-node architecture: fixes to bring back to proto

Status: P0–P6 implemented for the v20 release. Grounded on 2026-11-04. The original investigation and acceptance contract are retained below as historical context, not a description of the remaining implementation.

## Implementation record

| Slice | Delivered behavior and canonical owner |
| --- | --- |
| P0: transport and waits | `utils/socket-writer.ts` supplies bounded byte-oriented socket backpressure for broker and session-host connections. Automatic and explicit dependency barriers lend runnable admission; depth-three waits complete at concurrency one. |
| P1: targeting | `session/command-target.ts` captures node identity/generation/head once. Existing command specifications declare their scope; slash commands, selectors, keys and explicit extension commands share the selected target. Late selectors refuse stale targets rather than mutating the new focus. |
| P2: durable ownership | Persisted topology separates parent/root/spawn anchors from fork provenance. Registry lifecycle separates runtime release, turn stop, subtree termination and tree close. Parking retains descendants, durable receipts and pending results; cleanup failures remain visible and retain ownership reservations. |
| P3: execution policy | `task/execution-admission.ts` owns node exclusivity, fair tree scheduling, accepted-node bounds and wait lending across persistent, structured, isolated, eval, focused and wake turns. Hosted processes acquire broker-wide runnable reservations. Direct embedded SDK execution uses process-local admission. |
| P4: history and forks | `AgentSession.fork()` constructs and returns an independent root, leaving source runtime, descendants and recorded results unchanged. Temporal navigation freezes affected admission and records abandoned continuation generations durably; revisiting history does not reactivate them. |
| P5: declared state | `eval/declared-state.ts` captures data-only declarations at exact history boundaries under the owner execution gate, commits manifests before destructive transitions and restores only compatible interpreter/lane/environment state. Unsupported or dirty state refuses unsafe transitions; model context rewind does not undo computation. |
| P6: hosted terminal | Ordinary persisted interactive sessions run the full TUI in the existing broker-supervised host. The client is a bounded terminal relay with a fenced controller lease. Typed direct/RPC node operations provide revision checks, semantic history pages and bounded subscriptions; parked history reads do not revive runtimes. |

### Ownership and restart details

- Terminal attachment is latest-wins for the controller; observers never acquire mutation authority. Detaching with Ctrl+] neither cancels work nor closes the tree. Resize/reconnect requests a fresh frame even when dimensions did not change.
- A per-session host locator is checked against the authoritative host ownership record and live lease. Foreground root changes commit before acknowledgment. Restart uses the committed active root and current saved model, never silently the host's original root.
- Restart arguments are persisted after extension flag discovery. They retain actual configuration/extension flags without replaying the initial prompt, file attachments, tail input or superseded model/provider/thinking selections.
- Reusable root extension definitions and trusted discovery policy follow independent forks, including forks of restricted descendants. Worker-only tools do not become root tools. Missing reusable provenance fails explicitly rather than broadening discovery.
- Declared state is JSON-like data and bytes, not arbitrary heap serialization. The selected-data payload bound remains 16 MiB; cycles, aliasing, custom objects and live resources are rejected. Historical manifests are tied to exact boundaries, not a last-N-turn fallback.
- Independent forks share the workspace. They do not copy worktrees or transfer live descendants. Context compression, same-node branch selection and independent-root fork remain distinct operations.

### Follow-up refinements

- Recent main/fleet transcript retention is 512 messages / 4 MiB; committed main replay is 2,000 blocks / 4 MiB. Typed node and legacy RPC history pages admit up to 512 messages / 1,536 KiB, with semantic grouping and generation-aware cursors. These are history bounds, not increases to child/tree admission, outstanding requests, result retention or kernel residency.
- Manually invoked extension commands receive an invocation-only UI context from the active terminal. Notifications/dialogs work while inspecting a child or an independent fork; autonomous worker tools/events remain headless. The override does not rebind a worker's runtime or broaden its authority.
- Ask accepts an optional timeout in seconds, overriding the configured default; zero disables it. One deadline covers the entire form, including custom editing and question navigation. Expiry preserves confirmed answers, marks unanswered questions as timed out and never picks a recommendation or accepts an unconfirmed draft. It is not user approval. Ordinary reversible work may continue by model judgment; disproportionate spend and consequential public-facing/external actions must stop for explicit approval. Manual cancellation and an external abort remain distinct outcomes. Saved Ask replay preserves the full input contract and cannot turn a timed-out request into approval through tree navigation.

### Removed competing paths

The cutover removes the focused-command allow-list and model/jobs special dispatch, forced tree unfocus, the eight-hop ancestry heuristic, the mutating `SessionManager.fork()` path, separate runtime semaphore accounting and the child-prefix shortcut for async-manager ownership. Runtime parking no longer masquerades as logical session shutdown. Existing SDK/no-session direct execution remains intentional, not a remote-host failure fallback.

### Verification record

Verification is contract-level: deterministic providers exercise scheduling and lifecycle; actual sockets, subprocesses and PTYs exercise host ownership and terminal behavior. No implementation-text assertions or prompt hashes are used.

- Transport: large/non-ASCII frames, slow receivers, partial writes, connection replacement and real host negotiation; broker-wide reservation cancellation and host death/restart.
- Lifecycle: real Python state survives runtime parking while a grandchild completes, result delivery, revival and strict garbage collection. Failed preflight leaves the runtime and descendants intact.
- Fork/state: independent depth-three fork preserves root extension policy, can spawn a new worker, and leaves source history/tree unchanged. Exact earlier declared values restore across boundaries; dirty/unsupported state refuses silent loss.
- Full TUI: real CLI → supervised broker PTY → depth-three fleet → focused context/compaction/tree/fork; source root unchanged and new fork starts at depth zero. Separate actual-terminal smoke covers detach, cross-directory reattach, resize and broker-driven host restart.
- Terminal rendering: committed scrollback survives streamed output and shrink/reflow; blank padding below the cursor is not mistaken for committed rows.
- Final integrated architecture/async/host/controller/kernel/Ask selection: **1,422 passed, one skipped, zero failed; 9,639 assertions across 244 files**. This includes the actual hosted depth-three TUI regression and deferred-cleanup publication/reservation contracts.
- Full TUI package: **406 passed, one skipped, zero failed; 5,618 assertions across 35 files**. Additional CLI history/editor integration: **20 passed, zero failed**; release build-gate scripts: **eight passed, zero failed**.
- Workspace `bun check` passed after the final source changes, including TypeScript, Biome and Rust checks. Local tests ran on Bun 1.4.2; cross-platform release build/smoke results are separate CI evidence.
- The expanded integration run caught and fixed a deferred-cleanup deadlock: settled results are now published before slow cleanup finishes, while runnable permits, node exclusivity and accepted count/byte reservations remain held until actual resource settlement. Late failures remain observable and require successful lifecycle retry before releasing ownership.

### Deliberate limits

- This is not an arbitrary Python/JS heap snapshot, an RSS ceiling, a fixed-four-kernel policy, or a fork-server implementation. Existing 256-total/16-owner interpreter admission remains separate from runnable concurrency.
- Local continuity measurements cover macOS CPython 3.13.16 and Bun 1.4.2. Small/large namespace transition timings and disk growth are recorded in `docs/interactive-memory.md`. These measurements do not establish Linux/remote kernel equivalence.
- The hosted full-TUI node protocol is version 3; the existing line-oriented SDK RPC protocol is version 2. A line attach client cannot control a full-TUI host by pretending these protocols are interchangeable.
- Destructive filesystem rollback, new permission commands and migrating the entire transcript storage layout were not part of this cutover.

## Original investigation and accepted implementation contract

The following baseline facts and imperative acceptance criteria were written before implementation. Line references and reproduced failures describe that baseline; they are not current-source navigation anchors or remaining defects.

## Original recommendation

Bring back proto-fx's ownership and targeting rules, not its Zig implementation. Repair the existing transport and scheduler first; then make every session addressable through the same node-targeted operations. Build on proto's existing session host, registry, lifecycle manager, journal, admission controls, and bounded transcript views.

Do not start by rewriting the daemon, replacing Brush, or moving every transcript on disk. Those are not prerequisites for fixing focused commands or nested scheduling.

## Historical requirements, including the later corrections

Source: Claude Code session `5ba1bb59-2855-4f54-a89c-9b244c98f8ad`, archived at:

`~/.claude/projects/-Users-fouriermac-code-proto-fx/5ba1bb59-2855-4f54-a89c-9b244c98f8ad.jsonl`

| Transcript line | Requirement or design decision |
| --- | --- |
| 150 | One backend contract; typed transport; serialized host ownership; persistent connections; bounded subscriptions; persist before reporting a committed mutation. These are historical proto-fx findings, not proof that proto has the same bugs. |
| 822, 903 | Focus is a node, commands declare scope, nesting is policy-controlled, records outlive active runtimes, waits lend execution permits, resource bounds cover the tree. |
| 1548, 1583 | A four-kernel cap is not a satisfactory memory policy. Distinguish execution concurrency from kernel residency and measure private memory rather than summing RSS. |
| 1741, 1800, 1849 | Preserve the useful host API independently of Python persistence. Plain Python plus an explicit harness import and optional named kernels was the eventual proto-fx direction. This is a separate product decision for proto, not a necessary daemon fix. |
| 1889 | A user fork of any node creates a new root, not a sibling or a child. |
| 1909, 1928, 1933 | Fork/temporal rewind must not silently discard valuable Python context. No worktree fork, no arbitrary last-20-turn continuity window. |
| 2387, 2405 | The old implementation report itself left live state-restoration proof, snapshot measurements, some cross-platform coverage, and long-running specs unfinished. Do not treat those claims as verified proto code. |

Two different graphs must remain distinct: the **agent/session ownership tree** and each session's **conversation-entry branch graph**. Their parent pointers and lifecycle rules are not interchangeable.

## Pre-implementation proto: established facts

Paths below are under `packages/coding-agent/src/` unless prefixed with `docs/`.

| Area | Current implementation | Consequence |
| --- | --- | --- |
| Focus | `modes/interactive-mode.ts:519-530`: `viewSession` follows focus, while `session` and `sessionManager` remain main. | Routing requires scattered opt-ins. |
| Focused input | `modes/controllers/input-controller.ts:927-970`: special-cases model selection and read-only `/jobs`; rejects the remaining commands, shell, and Python shortcuts. | Child `/context`, `/compact`, `/tree`, `/fork`, rename and similar actions are not ordinary session operations. |
| Tree / branch | `selector-controller.ts:1227-1269,1304-1517`: branch reads main; tree explicitly unfocuses and reads main. Keybindings call these methods directly. | Fixing only slash parsing leaves keyboard paths wrong. |
| Command dispatch | `slash-commands/types.ts`; `builtin-registry.ts:102-137`: no declared scope, adapted handlers receive main. | A dispatcher cannot enforce one targeting rule today. |
| Execution | `orchestrator/runtime.ts:1901-1918,2410-2538`: persistent fleet turns share a process-wide semaphore and explicit waits lend permits. | Keep this mechanism; extend it to every blocking dependency path. |
| Automatic waiting | `task/executor.ts:1846-1898` waits for owned work through `AgentSession.settleAsyncWork()`; `agent-session.ts:1951-1959` does not lend the runnable permit. | Reproduced starvation at concurrency one; see evidence below. |
| Lifetime | `sdk.ts:3117-3127,3248-3269`; `registry/agent-lifecycle.ts:202-275`: parking disposes a session, and disposal suspends that session's child scope. | Runtime eviction and descendant ownership are coupled. Normal yield also drains owned jobs, so the old claim that every successful parent yield immediately kills grandchildren is not established by today's code. |
| Restore | `runtime-controlled.test.ts:1484-1595` exercises cold revival of a worker and continuation of its grandchildren. | This is already implemented; do not propose rebuilding it from scratch. |
| Host | `session-host/worker-entry.ts`, `ensure.ts`, `transport.ts`; `docs/session-host.md`: broker-supervised RPC worker per hosted session, single latest-wins attached client. Ordinary full TUI still constructs a local `AgentSession` in `main.ts`. | A daemon foundation exists, but the full TUI is not uniformly a client of it. Current resource limits are process-local, not broker-wide. |
| Transport | `SessionHostMux.writeLine()` and host/client socket writes ignore short writes; installed Bun socket types explicitly describe unbuffered writes and `drain`. | A real host startup frame was truncated, corrupting the following response. |
| Topology | `session/session-entries.ts:29-44`, `session-manager.ts:342-351`; registry/persisted-agent discovery and parent journals. | Parent provenance is overloaded; breadcrumb root discovery still uses an eight-step directory heuristic. |
| Execution paths | `tools/fleet/workers.ts:91-143`, `task/structured-subagent.ts`, `eval/agent-bridge.ts`: persistent fleet and structured/isolated execution differ, although both ultimately use executor code. | Consolidate lifecycle/admission semantics without deleting isolation or structured-return behavior. |
| Memory | `docs/interactive-memory.md`; `eval/kernel-admission.ts`. | Existing byte/count bounds, dormant SQLite indexes, idle reap and 256-total/16-owner interpreter admission are substantial. They are not an RSS ceiling or a durable heap snapshot. |
| Python state | `eval/py/state.py`, JS counterpart: explicit selected, data-only, size-bounded snapshots. | This is not whole-heap save/restore. Do not label it exact Python continuity. |
| Escape | Current focused Escape handles child streaming, compaction and retries. | The historical Escape finding is already addressed. Preserve it. |

### Pre-implementation reproduced failures

1. **Nested automatic-barrier starvation.** Deterministic provider: parent spawns a child, then terminally yields without an explicit `jobs wait`; concurrency is one. After the probe's two-second failure deadline, the child has never entered its provider while the parent holds capacity. The existing explicit-`jobs wait` nested test passes. Fix the automatic dependency barrier, not its timeout or prompt wording.
2. **Focused `/context` is blocked.** Exercising `InputController.handleFollowUp()` records zero context-handler calls and the main-session refusal notice.
3. **Tree navigation leaves the child.** Exercising `SelectorController.showTreeSelector()` records one unfocus and one root-tree read, with zero child-tree reads.
4. **Hosted-session handshake is corrupted.** The existing socket contract fails with `probe.socket === "refused"`. A diagnostic copy, including one run with isolated HOME/config and a dummy selectable model, captures a valid `ready` frame, then an `available_commands_update` cut inside a property name with the negotiation response concatenated onto it. The client's actual JSON parser fails. The host transport discards the return count from `socket.write`; this matches Bun's documented short-write contract. This is not simply a missing model or slow-start timeout.

Temporary probes exercised real controllers, the actual orchestrator/executor with a deterministic provider, and a real CLI host worker. They are not a visual TUI verification or a full-suite claim.

## Required invariants

1. **Explicit targets.** A node mutation receives an immutable node identity captured when the user acts. It never re-resolves a later focus or silently falls back to root. Async selectors carry expected identity/revision and refuse stale completion.
2. **Observation is not ownership.** Switching focus or disconnecting a client does not cancel turns, mutate topology, or require a full runtime just to browse history.
3. **Durable records, leased runtimes.** A parent record remains while descendants exist; its expensive `AgentSession` need not. Releasing a runtime lease is distinct from stopping a node or closing a tree.
4. **One execution admission path.** Fleet initial/follow-up turns, isolated and structured calls, kernel `agent()`, focused user submissions, and wake turns honor the same node exclusivity and applicable budgets. A blocking dependency lends every held runnable permit and safely reacquires before continuing.
5. **Bounded and fair capacity.** Retain accepted-work and byte admission separately from runnable limits. Add tree fairness and broker-wide admission if multiple host processes participate; a singleton semaphore in each host is not a daemon-wide limit.
6. **Explicit cancellation scope.** Cancelling a turn is not tombstoning a node. Node termination stops its subtree; tree shutdown stops all descendants and confirms resource cleanup before releasing reservations. Detach does neither.
7. **Authority is explicit.** Spawn policy derives a child's effective grants from the parent and agent definition; no entrypoint or revival path widens them accidentally. Observe existing proto authority contracts rather than inventing proto-fx permission commands that proto does not have.
8. **Durability precedes success.** A committed graph/history mutation is acknowledged only after its durable state is recoverable. Writes, response queues and snapshots have bounded backpressure and fail visibly rather than dropping accepted bytes/state.
9. **History semantics are named.** Model `checkpoint`/`rewind(report)` is context compression, not time travel. It deliberately preserves files/process state (`docs/tools/rewind.md:60-82`). User temporal tree navigation is a different operation; do not roll back Python values or abandon useful workers just because the model compressed its investigation.
10. **Fork means independence.** User fork creates a new root at the selected boundary; source ownership and descendants are unchanged. Copied lifecycle messages are historical records, not instructions to adopt the source's workers.

## Accepted work packages and acceptance criteria

### P0 — Repair transport and dependency waiting

These are independent fixes and do not need a new architecture first.

**Transport**
- Implement bounded, byte-oriented queued socket writes for the session-host output and command paths; resume the unwritten suffix on `drain` before sending the next frame. Audit equivalent broker socket callsites against the same contract.
- A disconnect/replacement invalidates only that connection's pending bytes. Never spill an old client's partial frame into a new client's stream.
- Keep the existing RPC frame encoder and UTF-8 reader. Surface queue overflow/transport failure; never swallow a partial control reply.
- Separate listener readiness from serving readiness. A successful negotiate verifies compatibility, not merely that a response-shaped frame exists.
- Reuse or extend a central transport utility if suitable; `eval/js/stdio-protocol.ts` provides a bounded writer pattern, but its FileSink implementation is not directly a Bun socket writer.

**Dependency waiting**
- Route automatic `settleAsyncWork()` dependency waits through the same permit-lending primitive as explicit job waits.
- Cover cancellation during lending/reacquisition and overlapping nested waits. No duplicate releases, leaked permits, or continuation after cancellation.
- Audit structured/eval blocking child calls and wake turns too. Do not assume the passing explicit-wait test covers them.

**Acceptance:** real hosted handshake/client churn with a command catalog larger than socket capacity; non-ASCII frames; slow receiver; client replacement during a partial write. Explicit and automatic depth-three dependency chains finish at concurrency one; cancellation releases capacity for unrelated work. The existing failing host contract becomes green.

### P1 — Node-targeted commands, without a daemon rewrite

- Add scope metadata to existing command specs, resolving at subcommand/operation level where necessary: **node**, **tree/workspace**, **root-session**, or **application/user**. The old three-scope sketch omitted auth/help and other application-wide actions.
- Introduce a small typed session-operations boundary around existing `AgentSession` methods. Resolve/capture its target once; don't add another parallel slash-command catalog.
- Node actions include context, model/effort, compact, tree/history, branch, fork, rename, bookmarks and owned jobs. New/resume/switch remain explicit root-session operations; MCP/workspace configuration declares its actual shared scope; credentials/provider installation remain user/application scope.
- Migrate both `handle` and `handleTui`, keyboard shortcuts, selectors, context-menu actions, RPC/ACP dispatch and extension-command integration. UI-only actions can stay local but must not smuggle in root mutations.
- Pass the selected session manager to tree/branch/label/render code. Remove forced unfocus, the focused-command allow-list and model/jobs special dispatch only once their callers use the shared path.
- Keep extension commands fail-closed in a focused view until their scope is explicit; do not silently run an undeclared command on main.

**Acceptance:** at depths zero through three, slash and keyboard actions agree on the same target; root state remains unchanged by child node actions. Root busy does not block unrelated idle-child inspection. A selector opened on A cannot mutate B after focus changes. Existing focused Escape/jobs/model behavior stays intact.

### P2 — Durable topology and runtime ownership

- Extend the existing registry/journal schema with explicit node parent, root and spawn-anchor entry identity. Keep stable existing worker IDs; stop using the process-wide display label `Main` as a durable routing identity.
- Separate ownership edges from fork provenance. An independent fork records where it came from without belonging to that source tree.
- Maintain a rebuildable node index from durable session/journal data. Import legacy relationships once, detecting cycles, missing parents, duplicate identities and tombstones; do not infer live ancestry from filenames in normal operation.
- Retain existing on-disk locations/artifact handles initially. Flat storage is desirable for new layout, but moving all history is not required to remove path-derived topology. Delete the eight-hop heuristic after readers and migration use explicit metadata.
- Split `releaseRuntime`, `stopTurn`, `terminateSubtree` and `closeTree` semantics in the existing lifecycle. Parking must not call a disposal path that recursively suspends children it does not own for teardown.
- Preserve parent-owned result delivery and immutable historical receipts even when the parent runtime is absent. Tree/node records own pending work and resumability; a transient executor frame does not.
- Preserve restart identity and the existing grandchild-restoration behavior. Shutdown traverses descendants with one admission freeze and bounded, observable cleanup; failed cleanup retains reservations rather than claiming resources are free.

**Acceptance:** evict a parent's runtime while a grandchild runs; the grandchild finishes and remains addressable. Restore a depth-three tree after host restart. Switch focus and clients without cancellation. Terminate one subtree without affecting siblings or another root. Stale revival cannot resurrect a stopped generation.

### P3 — Unify execution policy and scheduling

- Make persistent, isolated and structured/eval invocations use one node creation/admission/turn lifecycle. Isolation, structured return, merge/apply policy and keep-alive are execution options, not separate ownership systems.
- Preserve callers' public observable behavior while migrating every path: fleet, Python/JS `agent()`, commit/review helpers and other structured-subagent callers.
- Keep the current depth semantics unless intentionally migrated: `maxRecursionDepth` counts worker-to-worker levels; default two already allows workers three levels below main. It is not an off-by-one bug needing a blind default bump.
- Extend the central spawn preflight with per-node child and per-tree admitted-node policies, backed by admission reservations. Runnable/retained-result budgets remain distinct.
- Add per-tree fairness within host limits; broker-wide reservations are needed before claiming a global limit across hosts. Cancellation/kill paths return every reservation after actual settlement.
- Derive effective capabilities once for spawn and restore. Replace scattered identity-based behavior with declared capabilities/ownership where it changes authority or lifetime; display-role distinctions may remain.

**Acceptance:** every invocation surface obeys the same depth/authority/count/byte/concurrency policy. Isolation still captures/applies changes correctly. Nested waits cannot starve a different root. Follow-up, direct focused input and wake turns cannot bypass node exclusivity or steal/reuse turn identity.

### P4 — Temporal navigation and independent forks

Requires explicit topology and serialized node mutations. Do not implement it as `ctx.session = ctx.viewSession` or by mutating the source worker object into a root.

- Provide a backend temporal-navigation operation separate from model context rewind. Freeze new admissions into the affected subtree and check running/admitted work atomically; an earlier UI busy check is not enough.
- Base child abandonment on durable spawn anchors and entry ancestry, not timestamps. Children born exclusively in the abandoned continuation become browse-only on that continuation. Preserve the historical branch and define reactivation/revisit semantics explicitly.
- Reject sends/revival/mutations to abandoned generations. Keep them distinct from user-killed tombstones.
- Parent transcript results stay immutable. A later send to the navigated child continues from its new head; it does not retroactively change the parent's recorded answer.
- Fork the selected node's active lineage into a newly constructed root session with fork provenance and a fresh ownership/scheduling scope. Retain the mission as history, rebuild root instructions/capabilities, and leave the original runtime/tree untouched.
- Do not attach/copy live descendants or rehydrate them from copied lifecycle entries. Copy referenced history/artifact payloads needed for readability without turning artifact-directory contents into ownership edges.
- The user explicitly declined worktree forks. The workspace remains shared, so a session fork is not a filesystem snapshot.

**Acceptance:** navigate a grandchild while main is idle or independently active, with correct local busy checks; later children are browse-only, earlier valid children remain addressable. A race between spawn and navigation cannot create an orphan. Fork a depth-three node, land on depth zero, spawn there, and confirm the source tree and its result history did not change.

### P5 — State continuity, then measured memory optimization

This is a prerequisite for calling the full fork/temporal-navigation experience complete, not permission to silently ship transcript-only continuity.

- Make useful declared durable state part of the session history at exact boundaries. Reuse the existing safe selected-data codec for its documented domain, and connect state manifests to the same branch cut as history.
- Capture under the node/kernel execution gate before the next cell/turn can mutate state; commit the manifest durably before acknowledging a boundary-dependent fork. Background blob I/O is fine only if the snapshot view is already immutable and readiness is enforced.
- Restore lazily into the correct interpreter/lane/target/environment with explicit compatibility checks. Preserve all reachable historical manifests while their session/branches exist; no arbitrary twenty-turn fallback.
- Do not claim arbitrary heap fidelity: current data snapshots reject custom objects/resources/cycles and do not preserve arbitrary object identity. Rich Python state requires a separately specified, trusted serialization contract; independent per-variable pickle blobs can break aliasing and shared references. Unsupported resources must be visible before a destructive transition, with an explicit refusal/choice rather than silent reset or an approximate older snapshot.
- Keep model context rewind's state-preserving semantics. Do not automatically undo useful computation when `rewind(report)` drops exploratory prose.
- Once continuity is real, separate node runtime parking from kernel residency, measure private/native memory and startup/restore/snapshot latency, then consider a configurable memory-pressure policy. Never evict busy, unknown-busy or unsafely snapshotted state.
- Do not copy proto-fx's old fixed-four-kernel cap. Keep existing interpreter admission until measurement supports a different policy. Fork servers are optional platform-specific optimizations, not correctness prerequisites; Python/JS/remote targets need separate evidence.
- Treat plain-Python plus an explicit `proto`-namespaced harness library as a separate compatibility/product migration. It must preserve helpers, host tool admission, safe-edit guards, preflight and observable shell semantics; it is not a prerequisite for the node fixes.

**Acceptance:** compute values over two turns; fork/navigate at the earlier boundary and observe that exact declared state, while context-only rewind keeps current values. Host restart preserves declared durable state. Aliasing/unsupported resources/corrupt manifests fail according to the declared contract. Measure small and large namespaces, repeated transitions, and disk growth; don't advertise a whole-process RSS bound.

### P6 — One daemon-backed full-TUI backend and bounded observation

- Reuse the existing broker and session-host CLI re-entry path. Supervise a host per root/tree; do not spawn one process per node or introduce a competing daemon.
- Make the full TUI select one session backend at bootstrap. The daemon-backed and direct SDK/test implementations expose the same typed node operations; don't spread `if remote` through controllers or re-parse typed actions into slash text.
- Extend the existing typed RPC contract to explicit node targets, request IDs, expected generations/revisions and negotiated compatibility. Migrate clients, decoders, validation, docs and tests together; no root-fallback aliases or permanent legacy command lane.
- Keep command results separate from lossy progress/replay retention. Reconnect restores authoritative state rather than fishing a reply out of a bounded event log.
- Use per-node subscriptions and bounded semantic history pages/cursors. Existing subagent byte-offset reads and bounded UI windows are useful foundations, not reasons to read every transcript on each update. Carry reset/generation information across rewrite/navigation and reconnect.
- Render breadcrumb/parent/children navigation from explicit metadata at every depth. Browsing a parked or abandoned node is a read lease, not an implicit runtime revival.
- Preserve or explicitly version the current latest-wins attachment behavior; multi-view read subscriptions and a controlling-client lease should not accidentally grant simultaneous writers.
- Route any existing/future interactive requests through a bounded tree registry with node identity and correlation; do not add proto-fx-specific approval UI until mapped to proto's actual interaction/authority system.

**Acceptance:** drive the real TUI: focus a grandchild, inspect/context/compact/navigate/fork, detach mid-turn, reattach, restart the host, browse older history while new events arrive, and resize. Slow clients remain bounded and cannot corrupt replies. Commands never hit the wrong node and there is no UI-thread stall from hydrating a whole tree.

## Sequencing and cutover

1. Land P0's two independent regression fixes first.
2. Build P1 targeting and P2 explicit ownership as the shared foundations; keep their interfaces small and use existing modules.
3. P3 execution consolidation and P4/P5 history-state work then share those foundations. P5's contract must be settled before promising seamless P4 transitions.
4. P6 consumes the same operations; it must not create a second interpretation of focus, topology or commands.
5. Each cutover updates all affected callers and removes superseded dispatch/heuristics at that boundary. Persisted history is data to migrate, not deprecated executable fallback logic to keep indefinitely.
6. Update `docs/orchestration.md`, `docs/agent-fleet.md`, `docs/session-host.md`, `docs/session-operations.md`, `docs/tree.md`, `docs/rpc.md`, `docs/interactive-memory.md` and affected command/tool contracts when their implementation changes. Add user-facing changelog entries with each actual behavior change, not for this planning document.

## Implementation self-audit gates

Apply the supplied thermo-nuclear code-quality principles during implementation; this is not a request for a separate branch review.

- **Delete a decision path, not just hide it.** The targeted-operations boundary earns its keep by removing root/focus dispatch divergence. Do not add forwarding wrappers while leaving competing controllers authoritative. The unified executor must replace divergent lifecycle paths, not sit beside them.
- **Change ownership so special cases disappear.** A node record owns descendants and pending results; an attached view and a leased runtime do not. Do not compensate with new `isChild`, `isRemote`, `keepChildrenAlive` flags scattered through unrelated flows.
- **Keep each concept canonical.** Command scope belongs in the existing registry; permit accounting in the scheduler; lifecycle in the registry/lifecycle owner; transport buffering below RPC; persisted topology and manifests in session storage. Extend existing hardened utilities rather than duplicate them.
- **Use types to exclude half-states.** Target/revision, admission, shutdown and durable-commit outcomes should be explicit typed states. Avoid nullable bags, casts and silent root/restart fallbacks that obscure ownership.
- **Decompose by responsibility, not line-count theater.** Do not push a sub-1,000-line file over that threshold without a compelling structural reason. Existing oversized `agent-session.ts`, `sdk.ts`, executor and orchestrator files are not invitations to append another feature branch; put new cohesive responsibilities in their canonical focused modules and remove displaced code. Moving the same tangled flow to another file is not simplification.
- **Make related updates atomic.** Reservations, topology/history changes, visible generations and durable acknowledgments have one commit/rollback story. Independent transport and scheduler repairs need not wait on one another; dependency ordering must reflect real contract prerequisites.
- **Reject needless generality.** No generic backend/plugin/state-machine framework for a handful of known operations; no identity wrappers or exact-hash tests. Every abstraction must remove coupling or a repeated policy decision and remain legible at its callsites.
- **Audit structural subtraction as well as behavior.** At each cutover, identify which old dispatch cases, ownership routes, duplicated policies and fallback paths actually disappear. Passing tests does not excuse keeping both architectures or adding permanent transitional branches.

## Verification strategy

Use deterministic provider fixtures for dependency/lifecycle tests and real sockets/processes for transport/host contracts. Prefer observable results and state transitions; no source-text assertions or exact prompt hashes.

Required transition matrix: depth 0–3; live/idle/parked/abandoned/stopped; slash/key/RPC/kernel entry; direct/hosted backend; concurrency one/saturated; focus switch/detach/reconnect/restart; persistence/restore failure. Rows must cover distinct branches, not duplicate the same path mechanically.

Model-based state-machine tests should cover permit conservation, admission/navigation races and stale-generation refusal. A small TLA+ model for tree lifetime and permit-lending liveness can supplement those tests, with bounded completion and mutation checks; it does not prove the TypeScript implementation is wired correctly.

Before each implementation slice is declared done: focused package tests, `bun check` as appropriate, changed-contract tests, and actual TUI/CLI proof for visible behavior. Cross-platform kernel/process claims require macOS and Linux runs; remote-runtime claims require that target. Do not inherit proto-fx's known-failing-suite baseline as acceptable verification.

## Pre-implementation investigation verification record

- Existing architecture selection: **71 passed, 1 failed, 408 assertions**, nine files. Covers controlled orchestrator, registry lifecycle, focus attachment/jobs, spawn policy, rewind rehydration, Python/JS selected state, and the session-host socket contract. Failure: session-host negotiation described above.
- Temporary deterministic probes reproduced the automatic-barrier starvation and two focused-command/tree routing failures. The identical provider/implicit-barrier control at concurrency two passes (one test, two assertions), isolating the capacity dependency from basic provider or child startup failure. A real-worker diagnostic captured the corrupted socket frame; isolated configuration did not remove it.
- Additional input/structured-subagent/host-client/transport selection: **42 passed, 1 failed** across five files. The detached-session-switch failure compares an absolute expected session path with a relative returned path; this run does not establish a turn-survival regression. It still needs diagnosis before using that test as a cutover gate.
- Reproduction sources (temporary diagnostic copies, not permanent regression tests): `artifact://168`. The copied host fixture was run first as-is, then with isolated HOME/config, then with wire diagnostics; its final archived form contains the wire diagnostics and isolated configuration.
- These were investigation results before implementation. The implementation record above supersedes the baseline status; the acceptance criteria remain the contract.
