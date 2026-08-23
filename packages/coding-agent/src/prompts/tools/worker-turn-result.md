<worker-turn id="{{id}}" agent="{{agent}}" turn="{{turn}}" status="{{status}}" duration="{{duration}}"{{#if model}} model="{{model}}"{{/if}}>
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
Worker `{{id}}` is idle and retains this conversation — continue it with orchestrate_send. Transcript: history://{{id}}
{{/if}}
</worker-turn>
