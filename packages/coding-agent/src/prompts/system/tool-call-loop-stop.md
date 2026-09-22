<system-interrupt reason="tool_call_loop_stopped">
The run was stopped: `{{tool_name}}` was called {{count}} consecutive times with identical arguments:
`{{arguments_summary}}`

Last result (truncated): `{{result_summary}}`

The loop guard reached its hard limit of {{hard_limit}} identical calls, so no further model requests were made. Answer the user with what is already known, or wait for new instructions.
</system-interrupt>
