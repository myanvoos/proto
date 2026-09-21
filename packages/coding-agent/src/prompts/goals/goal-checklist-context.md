<checklist_context>
Persisted checklist items: live progress state for current goal, not old transcript decoration; goal continuations lack visible user nudge → treat as live state.
Before substantial work: compare next action with checklist items. If item stale, already finished, or no longer active pointer, call `checklist` first: mark done or rewrite list. NEVER leave stale in_progress while working on later phases.

Overall: {{closed}}/{{total}} done, {{open}} open.
{{#each phases}}
- {{name}}
{{#each tasks}}
  - [{{status}}] {{content}}
{{/each}}
{{/each}}
</checklist_context>
