# Adversarial Bug & Dead-Code Hunt — Findings Report

Overnight GAN-style bug-and-dead-code hunt over the proto codebase: an implementor role
plants one subtle defect (logic bug or dead code) per round into an isolated throwaway copy
of the repo, a judge role hunts it from the copy alone, and the roles score against each
other; the same hunting discipline then collects genuine findings from the pristine tree.

Status: **HALTED — see [`## Halt`](#halt) below.**

## Findings

None were recorded. The stretch never entered the round phase (see `## Halt`), and the
milestone-ordering rule ("the loop moves to the next only when the previous checkpoint
command passes") meant findings collection over the pristine tree never started.
`gan-bughunt/findings.json` holds `[]` — the honest zero-state.

## Halt

- **Stop reason:** Hard time wall. The stretch began at 2026-09-04 06:40 local time
  (NZST, +12:00) — already past the objective's 06:30 last-round-start gate — so the stop
  conditions ("No new round may start after 06:30; finalize the `## Halt` section of
  findings.md by 07:00") required ending the stretch with whatever milestones passed, and
  no round could be started without violating that boundary. Timestamps were never going
  to be fabricated to satisfy the milestone-2 wall check; the honest zero-round state was
  recorded instead.
- **Rounds completed:** 0 (required: ≥ 12; hard cap: ≤ 45)
- **Hit rate:** n/a — 0 rounds played, judge/implementor never scored
- **Findings by kind:** bug 0, dead-code 0 (required: ≥ 12 total, ≥ 3 per kind)
- **Repo integrity:** `gan-bughunt/baseline.json` (recorded 2026-09-04T06:52:44+12:00, before
  any round) pins HEAD `967f15b96d419febab21ad0f006b34027b152857` and the 7 tracked files that
  were already modified before the stretch started (pre-existing, untouched user work). The
  tracked tree was not modified, created, or deleted by this stretch; no revert was needed.
  Verified: `bun test gan-bughunt/isolation.test.ts` — 3 pass / 0 fail.
- **Milestone status:**
  1. Round harness — NOT PASSED: `bun test gan-bughunt/round.test.ts` fails with
     "rounds.jsonl holds at least one complete round record" (0 records — the 06:30 gate
     made any compliant round impossible).
  2. Sustained loop — NOT PASSED: blocked by the same gate (milestone ordering).
  3. Findings report — NOT PASSED: `bun test gan-bughunt/findings.test.ts` fails on the
     ≥ 12-findings volume bar (0 findings collected).
  4. Integrity gate — isolation test PASSED; `bun run check:ts` outcome recorded below.
- **check:ts outcome:** `bun run check:ts` exited 0 (biome: 2 warnings / 5 infos, all
  pre-existing in files this stretch never touched; per-workspace tsgo: exit 0). Combined
  with the isolation test, the stretch introduced no new gate failures and left the
  tracked tree exactly as recorded in the baseline.

Final tallies — Rounds completed: 0. Hit rate: n/a (0 rounds). Findings by kind: bug 0, dead-code 0.
