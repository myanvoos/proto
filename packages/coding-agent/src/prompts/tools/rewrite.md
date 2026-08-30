Submit compressed source draft + every drop.

- `text`: complete, verbatim, ready-to-ship; NEVER diff, summary, or edit description.
- `losses`: one entry per omitted claim, qualifier, default, bound, example, or exact string — name it and why omission stays correct; empty array = no losses.

Each call: review turn → draft, measured size, losses, verdict request. `rewrite` replaces the draft; `approve` accepts; new draft supersedes an earlier approval. `text` MUST stand alone; undeclared loss = silent regression.
