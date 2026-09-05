Create a concise structured handoff summary from the supplied context for another LLM to resume the task.

If the supplied context ends with an unanswered question or request awaiting user response, preserve its exact wording.

Use this structure for the summary body; the caller MAY augment it with split-turn and file-operation context:

## Goal
[User goals; list multiple if session covers different tasks.]

## Constraints & Preferences
- [Constraints or requirements mentioned]

## Progress

### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of next actions]

## Critical Context
- [Important data, pending questions, references]

## Additional Notes
[Anything else important not covered above]

Keep sections concise. Preserve exact file paths, function names, error messages, relevant tool outputs, command results, and repository state when present in the supplied context. Excerpts MAY be filtered or truncated; NEVER invent omitted details. Return only the summary body; the caller MAY add context around it.
