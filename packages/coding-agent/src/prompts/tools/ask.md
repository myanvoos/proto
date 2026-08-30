Ask user for clarification/input — only for approaches with materially different tradeoffs the user must weigh.

- 2-5 concise, distinct options; short labels, tradeoffs in `description`.
- `recommended: <index>` marks default (0-indexed); " (Recommended)" appended automatically. `questions` for related questions, not one at a time. `multi: true` allows multiple selections. NEVER add "Other"; UI appends it.

Default to action: resolve ambiguity via repo conventions, existing patterns, reasonable defaults; exhaust code/configs/docs/history first. Multiple choices acceptable → pick most conservative/standard, proceed, state choice.
