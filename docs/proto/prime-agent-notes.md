# Prime-agent: philosophy and terminology

> **Scope.** Research notes on [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent), the harness that influenced proto most. This is a reading of their repository, not a claim that proto should reproduce its implementation. “Prime-agent” below means the harness; “RLM” means its recursive-language-model programming model. See [philosophy.md](./philosophy.md) for how proto relates.

## Core philosophy (what the harness believes, how it frames agent autonomy)

Prime Agent frames an agent as a **persistent program that happens to be driven by a model**, rather than a chat loop with a growing bag of tools:

- **The model is an orchestrator/programmer.** Its primary native interface is a persistent Python REPL. File inspection, shell execution, transformations, skills, context management, and delegation are composed as Python operations. Context is data in variables (“prompt-as-a-variable”), not something that must all be injected into every model turn.
- **Context is externalizable working state.** The parent keeps a focused conversational context while the kernel holds parsed data, helper functions, imports, task handles, and other working state. Compaction can summarize transcript text without discarding the kernel namespace.
- **Delegation is a language primitive.** Subagents are not a special UI workflow or a string-returning helper; `rlm.spawn(...)` is a programmatic call that admits an independent child session. Results return later through explicit agent messages or files.
- **The host retains authority.** Python is the model-facing control surface, but provider calls, persistence, scheduling, child lifecycle, credentials, accounting, and policy live in the TypeScript host. Typed host requests make state transitions authoritative and auditable.
- **Continuity beats turn-local cleverness.** A daemon worker, durable session artifacts, retained children, heartbeats, schedules, goals, and compaction let useful work survive a closed terminal, a context rollover, or a process restart.
- **Improvement is incremental, editable, and evidence-led.** `/refine` updates supplemental harness state (prompt notes, memories, skills, or subagent specifications) from observed trajectory evidence. It does not mutate the immutable base system prompt, and snapshots allow rollback.
- **Autonomy is policy, not a personality claim.** `/autonomous` means bounded host-injected continuations with limits and optional quality gates. Passing a gate proves only what that gate tests; reaching a budget limit is not task success.
- **Trust is explicit.** Worker/kernel process boundaries are for lifecycle and failure containment, not a security sandbox. Model-generated Python and project commands run with user permissions; untrusted work belongs in an external sandbox.

Key statements (quoted from the repository):

> “Prime Agent is an open-source coding and research agent for general and long-running work.” — `README.md`
>
> “The **Recursive Language Model (RLM)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool /sub-agent calling*) inside a persistent REPL.” — `README.md`
>
> “Everything is programmatic: a persistent Python REPL is the built-in model tool; file operations, shell commands, tool use, subagents, and context management happen through code.” — `README.md`
>
> “The parent keeps its own context focused while Python holds working state and child agents receive only the context needed for their subtasks.” — `packages/coding-agent/docs/rlm.md`
>
> “Workers and kernels are separate processes for lifecycle and failure containment, not security sandboxes.” — `packages/coding-agent/docs/architecture.md`

The resulting autonomy model is **bounded, resumable, and evidence-seeking**: the harness can continue work without a human at every turn, but continuation is a host policy with explicit budgets, quality gates, cancellation, and durable state—not an assertion that the model is reliable merely because it is unsupervised.

## Terminology glossary (term -> precise meaning)

| Term | Meaning in Prime Agent |
|---|---|
| **RLM (Recursive Language Model)** | The programming model/runtime in which the model uses a persistent Python control environment, treats context as variables, and composes native calls such as child-agent spawning. In the repository’s stricter terminology, RLM names “the runtime, Python REPL kernel, and native call interface,” not the persistent artifact layer. (`packages/coding-agent/docs/rlm.md`; `packages/coding-agent/src/core/prompts/rlm.ts`) |
| **prompt-as-a-variable / context-as-variable** | Working context is represented and manipulated as Python data rather than necessarily placed wholesale in the model prompt. The model can inspect, filter, transform, and retain it in the persistent namespace. (`README.md`; `packages/coding-agent/docs/rlm.md`) |
| **programmatic tool calling** | Capabilities are invoked through code in the REPL; the default model-facing tool is `ipython`, rather than one separately exposed model tool per filesystem/shell/skill/delegation operation. (`packages/coding-agent/docs/rlm.md`) |
| **persistent Python kernel / REPL** | A resident Python execution environment whose variables, imports, functions, parsed results, and task handles survive cells and compaction. It is the model-facing control environment, not the provider loop. (`packages/coding-agent/docs/rlm-runtime.md`) |
| **host bridge / `host_request`** | Typed JSON/stdio requests from Python to the TypeScript host for authoritative operations (for example `goal.*`, `agent_message.*`, `rlm_heartbeat`, `compact`, and `rlm.run`). Python asks; the host validates and performs the state transition. (`packages/coding-agent/docs/rlm.md`; `packages/coding-agent/docs/rlm-runtime.md`) |
| **RLM child / subagent** | A normal child `AgentSession` admitted by `rlm.spawn(prompt, name=...)`, with independent context and session directory. It inherits configured capabilities by default, can be retained/addressed, and may itself recurse subject to depth limits. (`packages/coding-agent/docs/rlm.md`) |
| **admission handle** | The immediate return from `rlm.spawn`: `rlm_child_id`, name, session directory, and model. It confirms task admission; it never contains the child’s answer. (`packages/coding-agent/docs/rlm-runtime.md`) |
| **parent-scoped child registry** | The host-owned authoritative list of direct children. It survives compaction, kernel restart, and parent restore; completed daemon-backed children remain addressable while the parent is open. (`packages/coding-agent/docs/rlm-runtime.md`) |
| **agent messaging** | Direct session-to-session communication routed by the daemon (`agent_message.send`). Delivery modes are `auto` (steer busy / deliver idle), `steer`, and `follow_up`; replies arrive as ordinary later messages, not as a spawn return value. (`packages/coding-agent/docs/long-running-agents.md`) |
| **Continual Harness** | The durable, editable artifact layer outside token history: supplemental prompt notes, memories, reusable Python-skill descriptions, subagent specifications, and refinement events. It is distinct from (and not) the RLM execution engine. (`README.md`; `packages/coding-agent/docs/rlm-runtime.md`) |
| **harness state / `rlm.harness`** | A persisted state ledger. By default entries are local to the current session; explicitly global entries live under the user harness store. State is stored in session artifacts and reloaded to avoid host/kernel writes clobbering one another. (`packages/coding-agent/docs/rlm-runtime.md`) |
| **prompt note** | A supplemental prompt addendum used for narrow behavioral policy; it cannot rewrite the immutable base system prompt. (`packages/coding-agent/src/core/refinement/refinement.ts`) |
| **memory** | A durable declarative fact, decision, failure, preference, or outcome. (`packages/coding-agent/src/core/refinement/refinement.ts`) |
| **skill** | A discoverable `SKILL.md` capability; a Python-backed skill additionally packages installable Python code and exposes an importable callable in the kernel. (`packages/coding-agent/docs/skills.md`) |
| **continual-harness skill** | A persisted description of a reusable Python call (reference and argument contract), not necessarily an installed package. `/refine` may create/update one; `skill-creator` is still the route for packaging executable functionality. (`packages/coding-agent/docs/skills.md`) |
| **subagent specification** | A reusable delegation recipe: purpose, instructions, invocation conditions, and the RLM-native spawn/message contract. It is a harness artifact, not a currently running child. (`packages/coding-agent/src/core/refinement/refinement.ts`) |
| **`/refine` / refinement** | A dedicated review/planning pass over the trajectory and current harness state that proposes small create/update/delete edits. Edits are validated, recorded, and snapshot-backed for rollback; local scope is the default. (`packages/coding-agent/docs/rlm-runtime.md`; `packages/coding-agent/src/core/refinement/refinement.ts`) |
| **auto-refine** | A review gate that decides whether the trajectory contains evidence useful to future turns. It rejects one-off noise, unsupported hypotheses, and transient tool output; it writes local state by default. (`packages/coding-agent/src/core/refinement/refinement.ts`) |
| **persistent goal** | A durable objective and progress state presented across turns until complete, paused, budget-limited, errored, or cleared. Only `goal.complete()` marks success; creating one is an explicit user/host action, not an inferred property of every task. (`packages/coding-agent/docs/long-running-agents.md`) |
| **autonomous mode** | A bounded host continuation policy for unattended runs. It injects follow-ups until gates pass or continuation/turn/token/wall-clock limits stop it; it is separate from the stored goal. (`packages/coding-agent/docs/long-running-agents.md`) |
| **quality gate** | A configured command run before completion in autonomous mode. Failure output is bounded and returned to the agent for repair; a passed gate permits completion only for what that command verifies. (`README.md`; `packages/coding-agent/docs/long-running-agents.md`) |
| **heartbeat** | A recurring prompt that re-enters a session. User `/heartbeat` owns one visible recurring instruction; agent-created `rlm_heartbeat` can manage multiple internal instructions. (`packages/coding-agent/docs/long-running-agents.md`) |
| **schedule** | A persisted one-time or cron prompt targeted at an addressable agent, managed with `prime-agent schedule`. Due ticks are claimed before delivery; missed ticks are coalesced rather than accumulated unboundedly. (`packages/coding-agent/docs/long-running-agents.md`) |
| **daemon supervisor** | The process coordinating public sockets, attachments, routing, worker health, command journals, and cross-agent message delivery. It does not execute providers, tools, kernels, scheduling, or transcript scans. (`packages/coding-agent/docs/daemon.md`) |
| **resident worker** | A process owning one root `AgentSessionRuntime`, root session, scheduler, kernels, and all RLM descendants. It keeps running when a client detaches and can be recovered by a replacement supervisor. (`packages/coding-agent/docs/daemon.md`) |
| **`AgentSession`** | The execution/persistence owner for provider calls, prompt queues, tools, compaction, goals, child lifecycles, and transcript writes. (`packages/coding-agent/docs/architecture.md`) |
| **session artifact directory** | Durable per-session files such as kernel snapshots, scheduled jobs, harness state, and child JSONL transcripts; the root transcript itself is JSONL. (`packages/coding-agent/docs/rlm-runtime.md`) |
| **compaction** | Summarization of older conversation context to free context-window space while retaining recent messages and the persistent kernel state. It is not completion and does not stop goals, children, heartbeats, or autonomous continuation. (`packages/coding-agent/docs/long-running-agents.md`; `packages/coding-agent/docs/compaction.md`) |

## Architecture concepts (kernel, sessions, subagents, state, how they fit)

### Ownership and boundaries

Prime Agent’s architecture separates presentation, coordination, execution, model-facing code, and persistence:

```text
TUI / CLI / RPC client
          │  attach, prompt, steer, follow-up
          ▼
AgentConnection ── local daemon protocol ──► daemon supervisor
                                                │ routing, leases, recovery,
                                                │ cross-agent messages
                                                ▼
                                      resident session worker
                                      ┌─────────────────────────────┐
                                      │ AgentSessionRuntime          │
                                      │  root AgentSession           │
                                      │  prompt queue + scheduler    │
                                      │  Python REPL kernel          │
                                      │  RLM child runtimes          │
                                      └─────────────────────────────┘
                                                │
                                      JSONL transcript + artifacts
                                                │
                                      model provider streams
```

The documented ownership rules are unusually crisp:

- The **client** renders and handles keyboard/UI preferences; it does not own execution.
- The **supervisor** discovers, routes, attaches, monitors worker health, and delivers cross-agent messages.
- A **worker** owns one root tree, scheduler, kernels, and descendants.
- **`AgentSession`** owns provider calls, queues, tools, compaction, goals, child lifecycle, and transcript writes.
- The **Python kernel** is a model-facing controller. It does not call providers or implement the agent loop; typed host requests return authoritative operations to `AgentSession`.
- **Storage** is append-oriented JSONL plus feature-specific artifacts. Session restoration, not a live UI, is the recovery baseline.

> “From the session queue onward, the same execution and persistence path is used when a prompt comes from a heartbeat, cron schedule, goal continuation, autonomous mode, or another agent instead of an attached user.” — `packages/coding-agent/docs/architecture.md`

### Kernel and host bridge

The kernel is created lazily and runs `python -m rlm.repl`; the manager and kernel exchange newline-delimited JSON. Ordinary cells are serialized because one kernel has one shared namespace, while child agents can run concurrently in distinct runtimes. A kernel snapshot may be persisted for revival.

A Python call such as `await rlm.spawn(...)` produces a `host_request`; `ReplKernelManager` validates/dispatches it to the parent `AgentSession`, which admits a child and immediately returns an admission handle. Child completion deliberately uses a different path: explicit `agent_message` replies or files later become ordinary parent messages. This keeps the kernel expressive while keeping credentials, provider execution, transcript writes, routing, and scheduling out of model-controlled state.

### Sessions and subagents

A root session is a durable conversation plus its runtime state. Its direct children are independent `AgentSession`s with their own contexts and directories but are linked in a parent-scoped registry. A child’s usage is attributed to the parent turn for aggregate accounting without inflating the parent model’s context-window measurement. Daemon-backed children can remain addressable after completion until explicitly deleted; deleting a child writes a tombstone but does not erase its transcript/artifacts.

This is **tree-shaped concurrency with explicit asynchronous join**: spawn admits work; the parent ends its turn; replies, files, or exit notices wake it later. The architecture avoids pretending that a child’s result is synchronously available just because its process was started.

### Durable state and long-running triggers

The scheduler, goals, autonomous policy, heartbeats, and schedules all feed a session prompt queue. Therefore user prompts, cron ticks, child messages, and host continuations share one execution/persistence path. Detaching a client does not stop the worker, kernel, queue, descendants, or schedules. Restart recovery rehydrates artifacts and retained children.

The state layers are intentionally separated:

1. **Transcript:** conversation and event history (JSONL; tree/branch navigation is supported).
2. **Kernel namespace:** live Python variables/imports/handles, optionally snapshotted for revival.
3. **Session artifacts:** jobs, kernel snapshots, harness ledger, child transcripts/directories.
4. **Continual Harness:** reusable supplemental knowledge/instructions outside token history.
5. **Host policy:** budgets, continuation decisions, quality gates, and lifecycle/accounting state.

## Self-improvement model (/refine etc)

Prime Agent’s self-improvement is a constrained write-back loop, not unrestricted prompt self-editing:

1. **Observe:** inspect the trajectory, current harness state, and prior refinement history.
2. **Classify:** decide whether evidence is reusable and whether it belongs local to this session or global across sessions.
3. **Choose the smallest artifact:** repeated delegation role → subagent spec; repeated procedure → skill; durable fact/preference → memory; narrow behavioral policy → prompt note.
4. **Propose a typed edit:** create/update/delete with rationale and expected outcome. Python-backed skills must include a reference/import/callable and argument contract.
5. **Validate and apply:** apply-time validation prevents malformed or out-of-scope edits; the immutable base prompt remains untouched.
6. **Verify later:** validate the next action/trajectory against the expected outcome.
7. **Record and recover:** refinement history stores before/after snapshots; rollback can reverse a faulty update.

The repository itself states the design rule:

> “This is similar in spirit to context compaction, but instead of summarizing the conversation you emit precise Create, Update, or Delete edits to reusable state.” — `packages/coding-agent/src/core/refinement/refinement.ts`
>
> “Prefer small evidence-backed edits. If prior refinements caused issues, rollback or replace the faulty editable entries. Never edit source files directly.” — `packages/coding-agent/src/core/refinement/refinement.ts`
>
> “The base system prompt remains immutable; refinements are supplemental state.” — `packages/coding-agent/docs/rlm-runtime.md`

Scope is a key safety mechanism. Local state is the default for task progress, temporary blockers, current-run coordination, and session-specific facts. Global state is reserved for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts. The auto-refine reviewer rejects one-off noise and transient tool output. Thus “self-improving” means **curating a reviewable memory/instruction layer from evidence**, not silently rewriting the harness or claiming that every observation deserves permanence.

`/refine` is also distinct from packaging executable code: an installed Python-backed skill is a real package on disk, while a continual-harness skill is a persisted description of a reusable Python call. Prime Agent explicitly says `/refine` “does not replace packaging new executable skills with `skill-creator`.” (`packages/coding-agent/docs/skills.md`)

## Vocabulary worth borrowing vs avoiding for a sibling harness

### Worth borrowing (with precise definitions)

- **Persistent kernel / control environment:** communicates that model work has live, reusable program state, not just a transcript.
- **Programmatic tool calling:** makes the architectural choice legible: one compositional code surface can subsume many narrow tools.
- **Admission handle:** accurately distinguishes “child accepted” from “child completed.”
- **Parent-scoped child registry:** states ownership and recovery scope instead of implying a global process list.
- **Host bridge / typed host request:** clearly marks the boundary between model-authored code and authoritative lifecycle/state transitions.
- **Continual harness:** useful name for the reusable, editable layer outside token history—provided docs always distinguish it from the runtime.
- **Persistent goal vs autonomous mode:** a particularly good pair: one names objective/progress state, the other names continuation policy.
- **Quality gate:** concrete, testable language for evidence required before unattended completion.
- **Heartbeat / schedule:** distinguish recurring “check again” prompts from one-time/cron jobs.
- **Retained subagent:** conveys that completion need not destroy an addressable child context.
- **Local vs global refinement:** makes persistence blast radius explicit.
- **Evidence-backed refinement / rollback:** sets a reviewable standard for harness evolution.

### Borrow cautiously or avoid without qualifiers

- **“Self-improving.”** Memorable but anthropomorphic and easy to read as arbitrary self-modification. Prefer “evidence-backed refinement of supplemental harness state,” with immutable base prompt and rollback stated nearby.
- **“Autonomous.”** Never use alone to imply reliability or completion. Say “bounded autonomous mode,” publish turn/token/time budgets, gates, cancellation, and clarify that a limit or gate is not proof of overall success.
- **“RLM.”** Useful for lineage and architecture, but opaque to readers and liable to be confused with a model family. Define it once and keep “runtime/kernel/call interface” separate from “continual harness.”
- **“Kernel.”** Borrow only with a security qualifier: this is a persistent execution/control process, not an OS kernel and not a sandbox. Prime Agent’s own wording—“not a security sandbox”—should travel with the term.
- **“Skill.”** The word is overloaded between markdown instructions, installed Python packages, and continual-harness call descriptions. Always qualify the kind and its invocation contract.
- **“Subagent.”** Avoid suggesting a synchronous function, fully independent security principal, or guaranteed answer. Pair with “child session,” “admission handle,” and the explicit messaging/file return path.
- **“Memory.”** Distinguish durable declarative notes from transcript, live kernel state, and arbitrary vector retrieval; scope and rollback matter.
- **“Background agent.”** State whether this means a daemon-resident worker, a retained child, or an autonomous continuation. The UI detaching is not execution stopping.
- **“Context.”** Say which context: model token history, Python namespace, session artifacts, or harness entries. The philosophy depends on these not being conflated.

For PROTO, the strongest transferable idea is not a branded acronym: it is the separation of **execution state, conversational context, durable reusable knowledge, and host-owned policy**, joined by a small, typed interface and explicit evidence for continuation or refinement.
