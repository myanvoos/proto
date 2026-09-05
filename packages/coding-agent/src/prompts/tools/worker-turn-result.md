<worker-turn id="{{id}}" label="{{label}}" agent="{{agent}}" owner="{{owner}}" parent="{{parent}}" turn="{{turn}}" status="{{status}}" duration="{{duration}}"{{#if model}} model="{{model}}"{{/if}}>
<activity tool-calls="{{toolCount}}" requests="{{requests}}">
{{#each trace}}
- {{this}}
{{/each}}
{{#if traceOverflow}}
- … {{traceOverflow}} earlier tool call(s) not shown
{{/if}}
</activity>
<response{{#if responseTruncated}} truncated="true" full-output="agent://{{id}}"{{/if}}>
{{response}}
</response>
{{#if error}}
<error>{{error}}</error>
{{/if}}
{{#if alive}}
<receipt status="delivered" worker="{{id}}" turn="{{turn}}" />
Worker `{{id}}` (label `{{label}}`) is idle and retains this conversation — continue it with orchestrate_send using the immutable worker id. Transcript: history://{{id}}
{{else}}
<receipt status="terminal" worker="{{id}}" turn="{{turn}}" />
Worker `{{id}}` is terminal; recover context from history://{{id}} or output agent://{{id}} before spawning a replacement.
{{/if}}
</worker-turn>