<rough-ask>
{{ask}}
</rough-ask>

MUST preserve all ask constraints, criteria, exclusions, budgets.
Draft `objective`: exactly five ordered top-level sections, no others:

## Objective
Ask-scoped end-state, reached through stages.

## Success criteria
Ordered machine-checkable milestones; each MUST prove stage; last = final state.

## Verification
Exact repo-root commands, one per nonempty line in backticks; map every criterion.

## Boundaries
In-scope files/directories/operations; explicit NEVER-touched denylist.

## Stop conditions
Per-milestone + overall attempt caps; halt on ambiguity, risk, cap, unverifiable verification.

Investigate tooling via manifests/CI before listing commands. NEVER prescribe implementation (design, algorithm, file recipe).
Call `program` ONLY once: `program({op:"create", objective, token_budget?})`; include `token_budget` only if rough ask states one.
