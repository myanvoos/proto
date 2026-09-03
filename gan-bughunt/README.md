# gan-bughunt — adversarial bug & dead-code hunt artifacts

Produced by the overnight GAN-style hunt stretch (2026-09-04). The tracked source tree is
the audit subject, never the patch target: all stretch-owned files live in this directory,
and planted defects may exist only in throwaway copies under gitignored `.wt/` or the OS
temp dir.

| Artifact | Purpose |
| --- | --- |
| `baseline.json` | HEAD + `git diff --name-only` recorded before round 1; proves the tracked tree was untouched by the loop. |
| `rounds.jsonl` | One JSON record per adversarial round (implementor plant + judge hunt + scores). |
| `findings.json` / `findings.md` | Genuine bug / dead-code findings anchored to exact file:line evidence in the pristine tree, plus the `## Halt` section. |
| `round.test.ts` | Milestone 1 checkpoint: round-record schema, plant isolation, excerpt-vs-pristine divergence, hit/score consistency. |
| `rounds.test.ts` | Milestone 2 checkpoint: ≥ 12 sequential ordered rounds, kind/package diversity, hit-rate ≥ 25 %, hit geometry both directions, 06:30 wall. |
| `findings.test.ts` | Milestone 3 checkpoint: finding counts, spread, dedupe, verbatim line anchors, findings.md mirror + `## Halt`. |
| `isolation.test.ts` | Milestone 4 checkpoint: current `git diff --name-only` equals the recorded baseline; HEAD unchanged. |

Rerun from the repo root:

    bun test gan-bughunt/round.test.ts
    bun test gan-bughunt/rounds.test.ts
    bun test gan-bughunt/findings.test.ts
    bun test gan-bughunt/isolation.test.ts
    bun run check:ts

Outcome: the stretch started at 06:40 NZST, after the objective's 06:30
last-round-start gate, so no round could be run; see the `## Halt` section of
`findings.md` for the full account. The isolation/integrity proofs pass; the volume
milestones record their honest failing state.
