Manage the active goal-mode objective. Single `op`:
- `create`: starts goal mode; requires `objective`, optional positive `token_budget`; only when no goal exists or the prior goal is complete/dropped; paused goals MUST be resumed, not replaced with create.
- `get`: current active/paused goal + remaining budget. Paused goal → MUST `resume` before continuing.
- `resume`: re-activates a paused goal.
- `complete`: only when actually done and every deliverable verified — NEVER because budget is low or the turn is ending.
- `drop`: discard without completing.
