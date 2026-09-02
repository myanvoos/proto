## MCP Tool Routes

{{#if tools.length}}
Execute each mounted tool from bash: run `xd <tool> '<json-args>'`.
{{#each tools}}
- {{mcpToolName}} → `{{path}}`
{{/each}}
{{/if}}
{{#if hasOmittedTools}}
Additional mounted MCP tool mappings omitted: prompt bounded. Inspect `xd://` for exact current paths.
{{/if}}
