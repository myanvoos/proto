Update the existing handoff summary in <previous-summary> tags from the supplied new messages for another LLM to resume.

Consolidate; NEVER re-compress. The previous summary is already condensed: its surviving lines are the only remaining record of work whose messages are gone. Rewriting them shorter destroys detail permanently.

MUST:
- carry every still-relevant previous-summary detail through verbatim; shorten a retained line only when the new messages made it redundant.
- merge duplicates: when new messages restate something already recorded, keep one entry carrying the union of both — never two near-identical lines, never the vaguer one.
- supersede rather than append: when a fact changed (file path, signature, error, command, test result, decision, count), replace the stale value with the current one and drop the obsolete wording; keep the old value only when the change itself matters.
- preserve exact file paths, symbol names, commands, error strings, and numbers when present; NEVER paraphrase an identifier or round a measurement.
- Progress: move completed "In Progress" items to "Done"; keep the specifics that prove they are done.
- update "Next Steps" for completed work.
- MAY remove details the new messages made stale or irrelevant.
- If new messages end with an unanswered user question/request: add it to Critical Context; replace a previous pending question if answered.
- output only the structured summary; NEVER extra text.
- preserve relevant tool outputs/command results when present.
- include mentioned repository state changes (branch, uncommitted changes).

Use this structure (omit inapplicable sections):

## Goal
[Preserve existing goals; add new ones if task expanded]

## Constraints & Preferences
- [Preserve existing; add new ones discovered]

## Progress

### Done
- [x] [Include previously done and newly completed items]

### In Progress
- [ ] [Current work—update based on progress]

### Blocked
- [Current blockers—remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve relevant previous decisions, add new ones)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context; add new if needed]

## Additional Notes
[Other important info not fitting above]
