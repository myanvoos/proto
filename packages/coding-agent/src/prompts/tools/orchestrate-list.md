Worker roster returns canonical `id` + `label`, owner/parent scope, lifecycle, turn state, addressability, model, turns, queued messages, latest activity, terminal recovery.

State axes:
- `lifecycle`: `live` | `parked` | `terminal`.
- `turnState`: `starting` | `running` | `idle`; absent for terminal workers.

A parked worker is `lifecycle=parked`, `turnState=idle`; these fields NEVER be collapsed. Route by `id`, NEVER `label`.
