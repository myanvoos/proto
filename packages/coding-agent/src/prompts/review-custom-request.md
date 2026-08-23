## Code Review Request

Mode: custom instructions.

## Distribution

Use `orchestrate_spawn` with `agent: "reviewer"`. Create exactly **1 reviewer worker**; assignment MUST include custom instructions.

## Reviewer Instructions

Reviewer MUST:
1. Follow custom instructions.
2. Read referenced files/workspace context needed to evaluate them.
3. Use incremental `yield` sections for findings and verdict fields; do NOT call a separate finding tool.

## Custom Instructions

{{instructions}}
