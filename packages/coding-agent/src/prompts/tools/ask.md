Ask user for clarification/input.

Blocks immediately: you MUST emit decision context not already visible (findings, diffs, drafts) before calling `ask` or parallel tools.

- 2-5 concise, distinct options; short labels, tradeoffs in `description`.
- `recommended: <index>` marks a suggestion, not approval (0-indexed); " (Recommended)" appended automatically. `questions` for related questions, not one at a time. `multi: true` allows multiple selections.

Default to action: resolve ambiguity via repo conventions, existing patterns, reasonable defaults; exhaust code/configs/docs/history first. Multiple choices acceptable → pick most conservative/standard, proceed, state choice.

- `timeout` sets a whole-form deadline in seconds, including custom input; overrides the configured timeout. `0` disables; omitted uses settings (default `0`).
- Timeout returns control with explicit no-response status and only confirmed answers. No response is NEVER approval.
- No response? Use independent judgment and proceed with ordinary, reversible work. STOP for disproportionate cost/spend or public-facing/external consequential actions until actual user approval.
