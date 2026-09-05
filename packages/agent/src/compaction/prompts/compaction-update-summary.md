Update the existing handoff summary in <previous-summary> tags from the supplied new messages for another LLM to resume.

MUST:
- retain relevant previous-summary information; update it with new supplied messages.
- Progress: move completed "In Progress" items to "Done".
- update "Next Steps" for completed work.
- preserve exact file paths, function names, error messages, and unanswered requests when present.
- MAY remove stale or irrelevant details.
- If new messages end with an unanswered user question/request: add it to Critical Context; replace a previous pending question if answered.
- output only the structured summary; NEVER extra text.
- keep sections concise.
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
