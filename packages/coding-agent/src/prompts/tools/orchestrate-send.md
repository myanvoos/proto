Starts or steers the worker addressed by its canonical `id` passed as `to`; `label` is NEVER an address. Shape: `{"to":"<worker id>","message":"…"}` — NEVER `id`/`worker`/`workerId`/`session`.

`message`: complete follow-up instruction. Shape: `{"to":"<worker id>","message":"…"}`. Running worker → steer accepted into current turn. Idle/parked worker → tracked turn starts. Busy but non-streaming worker → distinct queued turn; receipt reports its turn number. Queue full → explicit rejection with retry guidance.

`model`: optional model switch with the message. Idle/parked → the resumed turn runs on it; queued turn → that turn runs on it; streaming worker → the running turn's next request already uses it (steer-and-switch). Validates like spawn: unknown role alias or unmatched id is rejected with nothing changed; role model bank enforced. The switch persists for all later turns of this worker.

Receipt semantics: `accepted` = steer/new turn accepted; `queued` = distinct next turn recorded; `delivered` = completion returned by wait/completion; `rejected` = turn could not start; `terminal` = worker no longer addressable.

Normal completion preserves the worker, including parked/cold workers. Terminal errors include reason, last turn, `history://` + `agent://` recovery paths.
