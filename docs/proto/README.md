# docs/proto — proto as its own harness

Proto forked omp (oh-my-pi) and diverged into its own harness. These documents define the
divergence: everything proto adds, everything it removed, and the philosophy the result
embodies.

| Document | Contents |
|---|---|
| [philosophy.md](./philosophy.md) | The opinions proto's code embodies, and the comparison to prime-agent |
| [vs-omp.md](./vs-omp.md) | Every proto capability absent from omp upstream, by domain |
| [removed.md](./removed.md) | Everything omp upstream has that proto deliberately removed |
| [prime-agent-notes.md](./prime-agent-notes.md) | Research notes on Prime Intellect's prime-agent — terminology and philosophy of the strongest inspiration |

The one-paragraph version: proto converges the model's world onto a few deep surfaces —
bash (with a persistent Python/JS kernel and `xd` device dispatch inside it), `read` with
selectors and outlines, and a small orchestration family (`orchestrate_*`, `fleet`,
`monitor`) — keeps sessions alive after the terminal closes (`proto attach`, parked
sessions, goals with budgets, scheduled queues), teaches the model the exact contract at
every failure point (shape-first tool docs, argument normalization with repair notes,
bounded outputs with escape hatches), keeps knowledge in reviewable files instead of a
memory database, and treats deletion as a first-class decision.
