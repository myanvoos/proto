Worker roster: immutable id, display label, owner/parent scope, state (`starting`/`running`/`idle`/`dead`), addressability, model, turns, queued messages, latest activity, and terminal recovery details.

Use immutable worker id; NEVER label. Terminal/non-addressable workers NEVER appear as idle.
