Worker roster: immutable id, display label, owner/parent scope, state (`starting`/`running`/`idle`/`dead`), addressability, model, turns, queued messages, latest activity, and terminal recovery details.

Use ids for send/wait/kill. Labels are not addresses and may repeat under different parents. Terminal/non-addressable workers MUST NOT appear as idle.