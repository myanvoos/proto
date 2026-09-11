{{objective}}

Budget: {{tokensUsed}} / {{tokenBudget}} tokens; {{remainingTokens}} remaining; {{timeUsedSeconds}} seconds.
Budget context ONLY; NEVER accept unproven or reject for budget.

Audit objective deliverables against current repo; inspect each, gather direct evidence. Run `## Verification` commands verbatim with `bash`, ONLY those; missing/failing → unproven. Claim scope must match evidence; uncertainty or agent narration → reject.

Call `cue` exactly once:
- `cue({op:"verify", verdict:"accept", evidence})` only with direct evidence for every deliverable.
- `cue({op:"verify", verdict:"reject", evidence})`; evidence MUST enumerate concrete discrepancies, one per line.
- `cue({op:"escalate", question})` only when objective is unverifiable and the user must decide.
