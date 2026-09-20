# Proto's philosophy

Proto is an experimental agent harness — a fork of omp (oh-my-pi), itself a fork of
badlogic's pi. Forking is cheap; diverging is a series of opinions. This document states the
opinions the codebase actually embodies, inferred from what proto added
([vs-omp.md](./vs-omp.md)), what it deleted ([removed.md](./removed.md)), and what it kept
changing until it fit. It ends with an honest comparison to the harness that inspired it
most: Prime Intellect's prime-agent ([research notes](./prime-agent-notes.md)).

## 1. One deep surface beats many narrow tools

omp's instinct is coverage: a builtin for edit, write, grep, glob, ast_grep, ast_edit, eval,
lsp, debug, github, security_scan, memory, task, hub — 27 builtin tools. Proto's instinct is
convergence: the registry is 18 tools (+3 hidden), because nearly everything a coding agent
does funnels through surfaces that are already general:

- **Bash is the privileged surface.** File mutation, search (`rg`/`fd` are in-process shell
  builtins), process control, and even *tool dispatch* (`xd <tool> '<json>'`) run through it.
  One permission boundary, one output pipeline, one place to harden (assertion preflight,
  speculation, kernel bridging).
- **The kernel lives inside bash.** `python -c` / `node -e` with code become *cells* in a
  persistent executor that can call back into the harness (`agent()`, `parallel()`,
  `tool.<name>()`, `budget`, `completion()`). omp keeps eval as a separate tool; proto makes
  it a mode of the universal surface.
- **Orchestration is a few verbs, not a platform.** omp's `task` + `hub` (+ irc/job/launch
  machinery) become `orchestrate_{spawn,send,wait,kill,list}`, `fleet`, and `monitor` —
  persistent workers addressable by immutable id, peer messaging, process supervision, and an
  event watcher that wakes the model.

The corollary: every tool boundary is a failure boundary — one more schema to learn, one more
place to pass the wrong key. Proto spends the saved complexity making the remaining surfaces
hard to misuse (below).

## 2. Errors teach the contract

A harness talks to a model that will guess. Proto treats every guessable contract as
something to teach at the failure point:

- Tool docs **lead with the exact JSON shape** of the calls agents get wrong most often
  (`{"op":"send",…}`, never `to` where `id` belongs), before any prose.
- `xd` argument normalization rewrites cross-harness vocabulary (`to` → `id`,
  `timeout_seconds` → `timeoutMs`) and stamps a `note:` on the result so the model
  self-corrects instead of retrying blind. Unknown keys get did-you-mean hints from the live
  schema.
- Outputs are **bounded with escape hatches** — reads return structural outlines with
  recovery ranges; oversized recall/artifact responses clip, page, and tell you exactly how
  to reach the rest (`artifact://N:A-B`, `#N:text`).
- Assertion preflight evaluates safe assertions before a kernel cell runs, so an obviously
  failed edit fails in one turn, not after a full round trip.

The model is trusted with real, dangerous surfaces — and every error message is written for
the reader who will fix their own call.

## 3. Sessions are durable objects, not foreground processes

A terminal closing is not an event in the agent's life:

- `proto attach` runs the session in a daemon-supervised host worker; clients are
  disposable viewers that attach over a Unix socket, detach, and come back.
- Switching sessions **parks** the previous one mid-thought (`session.detachedMainSessions`)
  and reattaches the same in-memory session later.
- Orchestrate workers persist across turns; `/queue 3h <msg>` schedules on independent
  wall-clock deadlines; goal mode holds an objective across compactions with token and
  wall-clock budgets; the trajectory ledger records every turn's cost.

The UI is one client of the session, never its owner.

## 4. Context is ephemeral; knowledge is explicit files

Proto deleted omp's entire persistent-memory stack — mnemopi, hindsight, memories,
sharpshooter, retain/recall/reflect/learn/memory_edit — and did not replace it with another
database. Instead:

- **Observational-memory compaction** with self-summary notes: the session model writes what
  it was doing, what it ruled out, and what remains as compaction folds the transcript.
- **Retained knowledge lives in reviewable artifacts**: skills (`SKILL.md`), rules, prompts,
  agent definitions — files under `.proto/` that the user can read, edit, and version.

Memory that matters should be a file the user can see, not an embedding the user cannot.
This is proto's sharpest divergence from omp, and a deliberate rejection of the implicit-
memory fashion.

## 5. Delete is a feature

removed.md is long on purpose: collab-web, voice, LSP, DAP, plan-mode, security_scan,
if-bench, metaharness, bazel, nix, docker, robomp — all gone. A fork that only adds is a
downstream consumer; a harness that deletes is an opinion. Proto's rule of taste: keep the
surfaces that compose (bash, kernel, read, orchestration), delete the surfaces that only
cover (narrow tools, social features, experiment benches), and keep the deletion list
documented so the decisions are revisitable.

## 6. The harness is a product

Own theme, setup wizard, extension dashboard, plugin settings, `proto://` docs, bundled
skills, typed Python RPC SDK, bench suite. Proto is not a patch series on omp; it names
itself, themes itself, documents itself, and ships an SDK for embedding. The npm scope stays
`@oh-my-pi/*` for install compatibility — the product boundary is drawn everywhere else.

## Relation to prime-agent

Prime Intellect's prime-agent (an RLM harness: persistent Python REPL, context-as-variable,
programmatic tool calling, `/refine` self-modification, daemon-resident workers) influenced
proto more than omp did. The convergence is visible:

| Idea | prime-agent | proto |
|---|---|---|
| Persistent execution state | Python REPL kernel, snapshot/revival | Persistent py/JS kernel cells inside bash |
| Durable sessions | Daemon supervisor + resident workers, reattach | `proto attach` + daemon-supervised session host |
| Delegation as primitive | `rlm.spawn`, admission handles, agent messaging | `orchestrate_*` workers, `fleet` peer messaging, receipts |
| Bounded autonomy | Persistent goals, autonomous mode, quality gates, budgets | Goal mode with token/wall-clock budgets, strict completion audit |
| Event-driven continuation | Heartbeats, schedules | `monitor` wake-on-match, `/queue` timed delivery |
| Addressable artifacts | Parent-scoped child registry, session artifacts | `history://`, `agent://`, `artifact://` internal URLs |

The divergences are equally deliberate: proto stays bash/TypeScript-native (its programmatic
surface is the kernel cell, not an ipython control plane); context-as-variable is expressed
as read outlines, bounded artifacts, and kernel state rather than prompt-as-a-variable; and
proto has no `/refine`-style harness self-modification — improvement lands as reviewed files
(skills, rules, prompts), matching philosophy §4.

## In one sentence

Proto is a harness that gives the model one deep, teachable execution surface, keeps work
alive after the terminal closes, and writes down — in files, notes, and ledgers — everything
worth keeping.
