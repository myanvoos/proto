## MCP Tool Routes

{{#if tools.length}}
{{#each tools}}
- {{mcpToolName}} → `{{path}}`
{{/each}}
{{/if}}
{{#if hasOmittedTools}}
Additional mounted MCP tool mappings omitted: prompt bounded. Inspect `xd://` for exact current paths.
{{/if}}
