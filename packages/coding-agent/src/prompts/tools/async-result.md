<system-notice>
{{#if multiple}}{{jobs.length}} background jobs have finished{{#if anyFailed}} (some FAILED — see each job header){{/if}}. Resume your work using the results below.

{{else}}Background job {{jobs.[0].jobId}} {{#if jobs.[0].failed}}FAILED{{else}}has completed{{/if}}. Resume your work using the result below.
{{/if}}{{#each jobs}}{{#if @root.multiple}}── Job {{this.jobId}}{{#if this.label}} ({{this.label}}){{/if}}{{#if this.failed}} — FAILED{{/if}} ──
{{/if}}{{this.result}}{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>
