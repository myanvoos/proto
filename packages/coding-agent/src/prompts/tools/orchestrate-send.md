Starts or steers work addressed by canonical worker `id`; `label` is NEVER an address.

`message`: complete follow-up instruction. Running worker → steer accepted into current turn. Idle/parked worker → tracked turn starts. Busy but non-streaming worker → distinct queued turn; receipt reports its turn number. Queue full → explicit rejection with retry guidance.

Receipt semantics: `accepted` = steer/new turn accepted; `queued` = distinct next turn recorded; `delivered` = completion returned by wait/completion; `rejected` = turn could not start; `terminal` = worker no longer addressable.

Normal completion preserves the worker, including parked/cold workers. Terminal errors include reason, last turn, `history://` + `agent://` recovery paths.
