Managed skills: `SKILL.md` in isolated `~/.proto/agent/managed-skills`, surfaced as normal skills in future sessions. For repeatable procedures worth codifying — setups, recipes, workflows. User-authored skills are NEVER touched.

`action`: `create` (fails if exists), `update` (overwrites body; fails if absent), `delete` (fails if absent). `name`: kebab-case. `description`: specific — drives discovery. `body`: no frontmatter (generated).
