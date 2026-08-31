# Conductor (`/conduct`)

> **Status: v0 design. Not implemented.** This document is the agreed spec for the
> conductor subsystem. It composes three shipped subsystems —
> [goal mode](../packages/coding-agent/src/goals/runtime.ts), loop mode
> ([`src/modes/loop-limit.ts`](../packages/coding-agent/src/modes/loop-limit.ts)),
> and the [advisor](./advisor-watchdog.md) — and reuses the advisor transport
> rather than inventing a parallel one. Read `advisor-watchdog.md` first; the
> conductor is defined largely by contrast with it.

The conductor is a session-scoped strategic agent on a frontier model. It designs
an autonomous stretch of work (the **program**), sets the primary agent's tempo
(iteration prompts, context policy, budgets), and manages the advisor roster
(**personnel**) — including hiring advisors of its own. It reviews the session in
**epochs** of several primary turns, not per-turn deltas, and it almost never
speaks to the primary directly.

Metaphor, held strictly: the primary is the soloist, advisors are section
leaders, the conductor sets program, tempo, and personnel. **The conductor does
not play an instrument** — it never mutates the repo, never fixes anything
itself, and never steers mid-turn. If it wants hands, it hires an advisor with
mutating grants and reads the result.

## Tempo hierarchy

The ratios in this table are **heuristic, for illustration only** — nothing in
the implementation enforces them. Actual conductor cadence is event-driven with
a minimum spacing (see [Cadence](#cadence-event-driven-epochs)); advisor cadence
is backlog-driven. The table exists to fix intuitions about layer roles, not to
specify scheduler constants.

| Layer     | Cadence (invocations vs primary) | Model class          | Input diet                    | Authority                          |
| --------- | -------------------------------- | -------------------- | ----------------------------- | ---------------------------------- |
| Primary   | 1x — every turn                  | working model        | full session context          | executes                           |
| Advisors  | ~0.5x — per-delta, backlog-batched | mid/cheap, specialized | raw transcript deltas       | advise; bounded interrupts         |
| Conductor | 0.10–0.25x — epochs of 4–10 turns | **frontier**         | **digest, never raw deltas**  | program, tempo, personnel, verdicts |

The advisor layer stays tactical — it is already tuned for that (delta
fidelity, emission guard, `immuneTurns`). The conductor is strategic, and every
design decision below follows from refusing to let it do tactical work.

## Planned implementation files

```
src/conductor/
  runtime.ts          ConductorRuntime — epoch state machine, wake conditions, gates
  digest.ts           mechanical epoch-digest assembler
  contract.ts         ConductorContract (superset of Goal)
  tools/program.ts    contract ops (create/amend/show)
  tools/roster.ts     personnel ops (spawn/retire/reinstruct/list)
  tools/cue.ts        epoch rulings (next/verify/escalate/stop)
src/prompts/conductor/
  system.md commission.md epoch.md verify.md
```

Touched existing code:

- `src/session/session-advisors.ts` — extract a shared `ReviewerTransport`
  (recorder, isolated `ToolSession`, quarantine, context maintenance); add a
  dynamic roster add/retire/reinstruct API; add note `audience` routing
- `src/advisor/*` — `audience: primary | conductor | both` on roster entries and
  accepted notes
- `src/goals/runtime.ts`, `src/goals/state.ts` — `"verifying"` status; external
  completion authority (completion pends until a verdict)
- `src/modes/interactive-mode.ts` — one `#scheduleConductorTick` replaces the
  parallel loop/goal timers; `/loop` and `/goal` become facades (zero behavior
  change)
- `src/slash-commands/builtin-modes.ts` — `/conduct` command
- `src/config/settings-schema.ts` — `conductor.*` settings, `modelRoles.conductor`
- `src/advisor/config.ts` — optional `conductor:` block in `WATCHDOG.yml`

## Strict superset of `/goal` and `/loop`

Both existing commands become degenerate configurations of the conductor
runtime. They keep their surfaces and exact behavior; they just gain a caller.

| Capability                                | `/loop` today          | `/goal` today                    | `/conduct`                                    |
| ----------------------------------------- | ---------------------- | -------------------------------- | --------------------------------------------- |
| Re-submit on yield                        | fixed prompt, 800ms    | hidden continuation steer        | conductor-authored per-epoch prompt (or fixed) |
| Iteration/duration caps                   | hard (`LoopLimitRuntime`) | soft (text in objective)      | hard, from the contract                        |
| compact/reset between iterations          | static `loop.mode`     | —                                | conductor-decided per epoch                    |
| Objective, budgets, pause/resume/drop     | —                      | `GoalRuntime`                    | `GoalRuntime`, unchanged accounting            |
| Objective design                          | —                      | primary interviews the user      | conductor investigates repo, drafts; user approves once |
| Completion gate                           | —                      | primary audits itself            | **pends until independent verification**       |
| Mid-turn intervention                     | —                      | budget-limit steer only          | delegated to advisors (existing guard rules)   |
| Advisor roster                            | —                      | —                                | static `WATCHDOG.yml` **plus dynamic hires**   |

Degenerate mappings: `/loop 10m <prompt>` ≡ conductor with
`{iteration: {promptTemplate, contextPolicy: loop.mode}, budgets: {wallClock: 10m}, conductor: off}`;
`/goal` ≡ contract-from-interview with `conductor: off`. The facades delete the
duplicated `#scheduleLoopAutoSubmit` / `#scheduleGoalContinuation` timers.

The two failure modes this exists to fix:

1. **`/goal` self-grades.** `goal({op:"complete"})` trusts the primary's own
   audit; the model that hallucinated "done" grades the claim.
2. **`/loop` is blind.** It re-fires an identical prompt regardless of what
   happened, with a static compact/reset policy.

## Channel rule: the conductor (almost) never speaks to the primary

**Invariant:** every mid-turn interruption of the primary passes through an
advisor's emission guard; every conductor utterance to the primary is a
turn-boundary prompt.

- The conductor's **only channel into the primary's context** is the next
  epoch's iteration prompt — a user-role message at a yield boundary, exactly
  where a human babysitting the session would speak.
- It never steers mid-turn. When mid-turn intervention is warranted, it
  **re-instructs or spawns an advisor**; that advisor's next delta review
  raises the point through the existing guarded channel (emission guard,
  `immuneTurns`, severity rules, terminal-answer/interrupt delivery
  constraints all apply unchanged).
- Bypasses of both channels are non-speech: `escalate` (a visible card to the
  **user**, not the primary) and `stop` (a control action).

Rejected alternatives, recorded: a pure puppeteer (never authors prompts)
throws away the main advantage over `/loop`; a full voice (conductor steers
like an advisor) collapses the layering, doubles the interrupt-policy surface,
and burns frontier tokens on tactical prose.

## The contract

Same five fields the guided-goal interview pins down, plus an iteration plan.
Authored by the conductor at commissioning after investigating the repo with
its own `read`/`grep`/`glob` — replacing the primary-run interview for the
conducted path (the interview remains for plain `/goal`).

```yaml
objective: |            # the /goal markdown structure, unchanged
  ## Objective
  ## Success criteria    # each machine-checkable
  ## Verification        # exact commands — doubles as the verification bash whitelist
  ## Boundaries
  ## Stop conditions
budgets: { tokens, wallClockSeconds, iterations }   # subsumes LoopLimitConfig; outer walls
iteration:
  promptTemplate: ...    # fallback prompt when the conductor is degraded/off
  contextPolicy: continue | compact | reset          # subsumes loop.mode; per-epoch overridable
  checkpoints: [...]     # milestones; hitting one is a wake condition
```

`program({op:"amend"})` is **monotone without approval**: the conductor may
narrow scope or lower budgets unilaterally; widening scope or raising any
budget emits a user approval card. Budgets are enforced by `GoalRuntime`
accounting exactly as today — the conductor cannot raise its own walls.

## Conductor tools

Investigative grant: `read`, `grep`, `glob`. During a verification turn only,
`bash` is exposed, with the contract's `## Verification` commands as the
whitelist (prompt-enforced in v0; a command matcher is a later hardening).
No mutating grants, ever — that is what hired `Fixer`-style advisors are for.

| Tool call                                                       | Effect                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `cue({op:"next", prompt?, context?})`                           | End-of-epoch ruling: author next iteration prompt; set continue/compact/reset. Omitted prompt → contract template. |
| `cue({op:"verify", verdict:"accept"\|"reject", evidence})`      | Rule on a pended completion claim.                                     |
| `cue({op:"escalate", question})`                                | Pause the stretch; visible card to the user.                           |
| `cue({op:"stop", reason})`                                      | End the stretch.                                                       |
| `program({op:"create"\|"amend"\|"show"})`                       | Contract lifecycle; amend is monotone-narrowing without approval.      |
| `roster({op:"spawn", name, model, tools, instructions, audience})` | Hire a session-scoped advisor (see Personnel).                      |
| `roster({op:"retire"\|"reinstruct"\|"list"})`                   | Manage hires; static `WATCHDOG.yml` entries are listable, not retirable. |

Any non-`next` cue requires a concrete reason; identical repeated rulings are
deduped (inverted emission-guard: `continue` is free, deviation must be
justified).

## Personnel: an advisor that spawns advisors

`roster.spawn` creates a dynamic roster entry using the **existing**
`AdvisorRuntime` machinery unchanged: same isolation, same emission guard,
same `__advisor.<slug>.jsonl` recorder, same quarantine. Hires are
session-scoped and auto-retire when the stretch ends. Static `WATCHDOG.yml`
entries are untouched and outrank hires on slug collision.

Bounds: `conductor.maxHires` (default 3 concurrent), `conductor.hireableModels`
allowlist, `conductor.spendCeiling` across all hires. A hire request that would
grant mutating tools beyond the allowlisted set emits a user approval card.

**`audience` routing** is the one new advisor capability:

| `audience`  | Notes flow to                                            | Use                                                             |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `primary`   | primary transcript (today's behavior; the default)       | ordinary reviewers                                              |
| `conductor` | next conductor digest only — **silent watcher**          | cheap tactical eyes ("did any test invocation fail this epoch?") without touching primary context or spending frontier tokens on deltas |
| `both`      | both                                                     | escalation-capable reviewers                                    |

An urgent `audience: conductor` note (blocker severity) is a conductor wake
condition; it still cannot interrupt the primary directly.

## Cadence: event-driven epochs

0.10–0.25x is not a turn divider. The conductor wakes on **conditions with a
minimum spacing** (`conductor.minEpochTurns`, default 4):

- iteration boundary with ≥ N primary turns since last wake
- contract checkpoint hit
- escalation routed up: a roster advisor's `blocker`, or an urgent
  `audience: conductor` note
- completion claim (always wakes; see Verification)
- budget threshold crossings (50 / 80 / 100%)
- contract stop-condition trigger

Between wakes the tactical layer runs unattended: template continuation fires,
static and hired advisors review, `GoalRuntime` enforces budgets. There is no
syncBacklog-style wait for ordinary epochs — the primary never blocks on the
conductor except at the verification gate.

### Degradation ladder

Conductor failure must never strand the session. Because goal, loop, and
advisor are each self-sufficient, degradation is structural:

1. Conductor healthy → full behavior.
2. Conductor slow/erroring (advisor-style retry policy, quarantine rules
   apply to its output turns) → epochs are skipped; iteration prompts fall
   back to the contract template; roster stays as last configured. This **is**
   today's `/goal` + `/advisor` behavior.
3. Conductor halted (three dropped epochs, or quota pause) → same as 2, plus a
   one-line host warning; `/conduct` rebuilds it, mirroring `/advisor`.
4. `conductor.fallback: pause` (opt-in) → instead of 2, the stretch pauses and
   surfaces a card.

## Verification: killing self-grading

`goal({op:"complete"})` no longer completes. It transitions the goal to
`"verifying"`; the turn ends naturally (auto-continuation and the `goal` tool
are gated off while verifying, and the budget freezes), and the conductor
wakes:

1. The conductor (or, cheaper, a one-shot verifier advisor it spawns on a
   mid-tier model) audits **current repo state**: reads files, runs the
   contract's `## Verification` commands, matches verification scope to claim
   scope — the same audit discipline `goal-continuation.md` demands, executed
   by a fresh context that did not do the work.
2. `cue({op:"verify", verdict:"accept"})` → goal completes, budget report to
   the user, hires retire, mode exits.
3. `verdict:"reject"` → the discrepancy list becomes the next epoch's
   iteration prompt; the goal returns to `active`.
4. `conductor.maxRejections` (default 3) consecutive rejections → forced
   `escalate`. A soloist/conductor disagreement loop cannot burn the budget.

The verification gate is the only place the primary waits on the conductor:
generous timeout (`conductor.gateTimeoutSeconds`, default 300), timeout →
`escalate`, never silent acceptance. The manual escape hatch for a pended goal
whose verdict source has died is `/goal resume` — `resumeGoal` forces the goal
back to `active`, doubling as a user-driven reject.

## Token efficiency

Conductors are frontier models; the design pays for that three ways:

1. **Digest, not deltas.** Each wake receives a mechanically assembled brief
   (`src/conductor/digest.ts`): turn headlines (the delta renderer's
   tool-intent lines, bodies elided), `git diff --stat` since last wake,
   goal/budget state diff, every advisor note from the epoch (advisors are the
   compression layer), verifier reports, pending wake reasons. Target 3–8k
   tokens per epoch. A model-summarizer stage is explicitly v2; mechanical
   assembly plus advisors-as-compressors ships first.
2. **Append-only cached context.** Same maintenance path as the advisor
   (promotion → compaction → re-prime from a bounded digest replay). Stable
   system prompt + append-only digests keep each wake nearly fully
   prompt-cached; the slow cadence stays within cache TTL. A frontier
   conductor waking every ~5 turns on cached context is plausibly cheaper than
   one always-on mid-tier advisor.
3. **Decision journal.** Each wake ends with a compact ruling record — tempo,
   roster changes, rationale, watch-items — appended to its context and
   persisted. This is the conductor's working memory across re-primes, and
   what `/conduct status` renders. Frontier reasoning is spent once, then
   referenced.

## Safety rails

Inherited unchanged from the advisor/goal machinery:

- **Outer walls.** `GoalRuntime` token/wall-clock/iteration budgets; the
  conductor cannot raise them (`program` monotonicity).
- **Quarantine.** Conductor output turns pass through the same output-hazard
  quarantine as advisor turns; a quarantined turn is discarded whole,
  including its cues.
- **Interrupts.** User Esc pauses all three layers and suppresses auto-resume
  (goal `onTaskAborted` semantics); pending cues become visible cards that
  re-enter on resume (advisor card semantics).
- **Never a peer.** A `conductor`-kind registry ref, excluded from the fleet
  roster, broadcast targets, subagent peer prompt, and `history://`; not
  messageable, revivable, or killable as a peer regardless of grants.
- **Attribution.** Conductor usage/cost is separate model usage; epoch prompts
  persist as synthetic agent-attributed messages so they never inflate
  user-message metrics.

New for this subsystem: hire caps, hireable-model allowlist, hire spend
ceiling; approval cards for scope-widening amendments and mutating-tool hires;
forced escalation after repeated verification rejections; verification-gate
timeout that escalates rather than accepts.

## Transcript persistence

Mirrors the advisor recorder:

- conductor: `<session>/__conductor.jsonl`
- hired advisors: `<session>/__advisor.<slug>.jsonl` (existing scheme; hires
  are flagged `hired: true` in the entry header)

Append-only, independent of in-memory context, follows session
switch/branch/drop with the same detach-and-drain rules. Agent Fleet shows the
conductor as a read-only `conductor`-kind transcript under its owning session.

## Command surface

| Command                    | Effect                                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| `/conduct <rough ask>`     | Commission: conductor investigates → contract + roster + tempo plan → approval card → performing. |
| `/conduct status`          | Journal tail, epoch count, budgets, roster (static vs hired), per-layer cost.   |
| `/conduct plan`            | Show contract; open amend flow.                                                 |
| `/conduct roster`          | Inspect hires; retire manually.                                                 |
| `/conduct tempo <n>`       | Set `minEpochTurns` for this stretch.                                           |
| `/conduct pause \| resume \| drop` | Whole-stretch lifecycle; cascades to goal state and hires.              |
| `/conduct dump raw`        | Full conductor dump (system prompt, digests, cues), mirroring `/advisor dump raw`. |

Headless: `proto -p --conduct "ask"` with `--advisor`-style semantics —
contract approval skipped (`conductor.approveContract: false` implied), final
verification honored within the existing drain budget, abandoned work logged.

## Settings

| Setting                        | Default | Notes                                                        |
| ------------------------------ | ------- | ------------------------------------------------------------ |
| `conductor.enabled`            | `false` | Master switch.                                               |
| `modelRoles.conductor`         | —       | **No fallback to `modelRoles.advisor`** — deliberately frontier; unresolvable → `no_model`, degradation ladder step 2. |
| `conductor.minEpochTurns`      | `4`     | Minimum primary turns between ordinary wakes.                |
| `conductor.gateTimeoutSeconds` | `300`   | Verification gate wait before forced escalate.               |
| `conductor.maxRejections`      | `3`     | Consecutive verification rejections before forced escalate.  |
| `conductor.maxHires`           | `3`     | Concurrent dynamic advisors.                                 |
| `conductor.hireableModels`     | `[]`    | Model allowlist for hires; empty → `modelRoles.advisor` only. |
| `conductor.spendCeiling`       | —       | Cost cap across hires.                                       |
| `conductor.approveContract`    | `true`  | Contract approval card before performing.                    |
| `conductor.fallback`           | `"loop"` | `loop` (template continuation) or `pause` on conductor failure. |

`WATCHDOG.yml` gains an optional `conductor:` block (`instructions`, `tools`)
with the same discovery/specificity rules; the conductor also reads
`WATCHDOG.md` — review priorities apply doubly to whoever writes the program.

## Build order

1. **Transport extraction.** Lift `ReviewerTransport` out of
   `session-advisors.ts` (recorder, isolated `ToolSession`, quarantine,
   context maintenance, reset semantics), parameterized by injected tool and
   feed. Advisor behavior must be byte-identical after this refactor.
2. **Runtime unification.** `ConductorRuntime` owning contract + limits;
   `/loop` and `/goal` become facades over it (existing tests as the
   regression net); `GoalRuntime` gains `"verifying"` + external completion
   authority.
3. **Verification-only conductor.** `conductor.review: completion-only`
   equivalent — the smallest slice that kills self-grading; highest value per
   line.
4. **Epochs.** Digest assembler, wake conditions, `cue({op:"next"})`,
   decision journal.
5. **Personnel.** Dynamic roster API in `session-advisors.ts`, `audience`
   routing, hire bounds and approval cards.
6. **Commissioning + headless.** `/conduct <ask>` investigation flow, approval
   card, `--conduct`.

Each step lands independently useful; steps 1–3 change no default behavior for
sessions that never enable `conductor.enabled`.
