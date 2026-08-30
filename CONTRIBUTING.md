# Contributing to proto

Pull requests are welcome. Keep them focused, understand the work you submit, and be prepared to explain and maintain it.

- **Small changes** (bug fixes, docs, narrow improvements): go straight to a PR.
- **Major changes** (new subsystems, large UI/architecture changes, new dependencies): open an issue to discuss before implementing.
- Don't open an issue for small work you're already turning into a PR; link existing issues instead.
- One logical change per PR — no unrelated cleanup or drive-by refactors.
- The PR body must include at least one sentence in your own words explaining what changed and why.
- Verify the change works: run `bun check` and the relevant tests, then exercise the changed path yourself (reproduce the bug, use the feature, interact with the UI).
- AI agents are a tool, not an unattended contributor: constrain the agent to scope, review every changed file, and submit the PR yourself. You own the code.

A contribution submitted for inclusion in PROTO is licensed under the MIT License; no CLA or DCO required.

Setup, packages, and architecture: see the [README](README.md) and [`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md).
