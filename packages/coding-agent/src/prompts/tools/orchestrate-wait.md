Blocks until ONE watched worker finishes its current turn, the timeout elapses, or you are interrupted — not until all finish. Re-issue to keep waiting.

Turn results normally deliver themselves; you NEVER need this to receive output. Use it only when you are completely blocked and cannot direct any other worker.

A finished turn's full result (activity trace + response) is returned here and will not be re-delivered separately.
