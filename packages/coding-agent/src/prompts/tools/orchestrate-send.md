Message a worker by immutable id from `orchestrate_spawn` or `orchestrate_list`.

Receipt semantics: `accepted` = steer/new turn accepted; `queued` = next turn recorded; `delivered` = completion result delivered by wait/completion; `rejected` = message could not start; `terminal` = worker is no longer addressable. Labels are display-only and may repeat; NEVER route by label.

Normal completion preserves the worker handle, including idle and parked/cold workers. Terminal errors include the reason, last turn, and `history://` / `agent://` recovery paths.