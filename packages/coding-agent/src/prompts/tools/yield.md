Submit subagent output. ALWAYS wrap the payload: `result: { data: <output> }` or `result: { error: "message" }` — top-level `data`/`error` or a bare payload is invalid.

Omit `type` for the usual single terminal structured result. Pass `type: ["section"]` for an incremental non-terminal section that accumulates.
{{#if hasOutputSchema}}
This task declares an output schema: terminal `result.data` MUST be the full object matching it. A data-less `type: "result"` finalizes previously submitted sections; invalid when none were submitted — prose can never satisfy the schema.
{{else}}
Pass `type: "result"` to finalize; with `data` omitted, your last assistant turn becomes the raw final result.
{{/if}}
