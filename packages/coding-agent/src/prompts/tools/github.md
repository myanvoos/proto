`gh` op wrapper: repos/files, PRs, search, checkout, push, Actions watch. Read issue/PR via `issue://<N>`/`pr://<N>`; PR diffs `pr://<N>/diff` (files), `/diff/<i>` (1-indexed slice), `/diff/all`.

- `repo_view`/`file_read`: omit `repo` → current checkout; `file_read` `branch` → default branch.
- `pr_create`: `head` defaults current branch. `pr_checkout`: PR(s) → dedicated worktrees, never the working tree; array batches. `pr_push`: requires prior `pr_checkout`.
- `search_*`: `search_code` needs `query`, rejects `since`/`until`; others take optional `query` + `since`/`until`. `repo` defaults current checkout — elsewhere via `repo:`/`org:`/`user:` in `query`; `search_repos` ignores `repo` (scope via `org:`/`language:`).
- `since`/`until`: `<n>m/h/d/w/mo/y`, `YYYY-MM-DD`, or ISO datetime. `dateField: "updated"`: issues/PRs update time, repos push time, never creation.
- `run_watch`: omit `run` → every run for current HEAD; `branch` defaults current; fast-fails first job failure.

GitHub-hosted file: MUST use `file_read`; NEVER `curl`/`wget`.
