Terminates the worker addressed by canonical `id`: aborts its in-flight turn, discards queued messages. Terminal receipt includes reason, last turn, `history://` + `agent://` recovery paths.

Route by `id`, NEVER `label`. Shape: `{"id":"<worker id>"}`.
