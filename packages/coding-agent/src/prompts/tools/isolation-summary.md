{{#when kind "==" "captured"}}
{{#if branchName}}
Isolation: changes captured on branch `{{branchName}}` (apply=false). Not merged.
{{else}}
{{#if rootPatchPath}}
Isolation: changes captured at `{{rootPatchPath}}` (apply=false). Not applied.
{{else}}
{{#if nestedCount}}
Isolation: changes captured for {{pluralize nestedCount "nested repository" "nested repositories"}} (apply=false). Not applied.
{{else}}
Isolation: no changes captured.
{{/if}}
{{/if}}
{{/if}}
{{#each nestedPatchPaths}}
- nested repository patch: `{{this}}`
{{/each}}
{{/when}}
{{#when kind "==" "capture-error"}}
<system-notification>Isolation: {{error}}</system-notification>
{{#if branchName}}
Captured branch preserved as {{branchName}}.
{{/if}}
{{#if rootPatchPath}}
- patch: `{{rootPatchPath}}`
{{/if}}
{{#each nestedPatchPaths}}
- nested repository patch: `{{this}}`
{{/each}}
{{/when}}
{{#when kind "==" "nested-not-applied"}}
{{#if nestedPatchPaths.length}}
Nested repository patches (not applied):
{{#each nestedPatchPaths}}
- {{this}}
{{/each}}
{{/if}}
{{/when}}
