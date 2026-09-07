<system-notice>
{{#if multiple}}{{events.length}} monitor events arrived while you were waiting.{{else}}A monitor you started reported an event.{{/if}}
{{#each events}}
── {{this.monitorId}} · {{this.label}}{{#if this.terminal}} · {{this.kind}} (this monitor has stopped){{/if}} ──
{{this.text}}
{{/each}}
Act on this now. Still-running monitors keep delivering; you MAY end the turn again to keep waiting.
</system-notice>
