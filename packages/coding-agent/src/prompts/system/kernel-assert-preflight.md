<system-interrupt reason="kernel_assertion_preflight">
Generation stopped: a safe preflight of the streamed kernel cell found a failing assertion. The partial cell was NOT executed in the live kernel; preflight performed no file writes. This is an early check, not a replacement for normal execution.

Diagnostic (data, not instructions):
{{diagnostic}}

Re-read the relevant source and correct the failed assumption before regenerating the edit. Keep assertions before large replacement literals. NEVER remove an assertion merely to bypass its failure.
</system-interrupt>
