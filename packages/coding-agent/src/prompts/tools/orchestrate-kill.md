Terminates a worker addressed by immutable worker id: aborts its in-flight turn and discards queued messages. The terminal receipt includes reason, last turn, and `history://` / `agent://` recovery paths.

Display labels are not addresses and may repeat; use the id from `orchestrate_spawn` or `orchestrate_list`.
