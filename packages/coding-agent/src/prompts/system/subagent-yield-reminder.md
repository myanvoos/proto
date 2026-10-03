{{#if budgetStop}}
<system-reminder>
Budget crossed; turn stopped → forced wrap-up. MUST `yield` NOW with the best final report from completed work.
Consolidate value; mark gaps incomplete; NEVER investigate, tool-call, or resume.
Terminal `yield` now: omit `type`, full result in `result.data`. Data-less `type: string` ONLY when your prior turn already wrote the report as prose.
</system-reminder>
{{else}}
<system-reminder>
Idle: no tool call ({{retryCount}}/{{maxRetries}}). MUST call tool.
Incomplete/no partial → next tool; reminder NEVER forces stop.
Useful partial → `yield` non-empty `type: string[]`; continue.
Done → `yield`: omit `type`, report in `result.data`. Data-less `type: string` ONLY when your prior turn already wrote the report as prose.
Blocked → terminal error naming concrete blocker. NEVER text-only/fake forced-stop reason.
</system-reminder>
{{/if}}
