Creates or overwrites a file. Use for new files the task requires, or full replacement when editing would be more complex.

Also: archive entries `archive.ext:path/inside/archive` (`.zip` + `.jar`/`.war`/`.ear`/`.apk`, `.tar` + `.gz`/`.zst`, `.asar`; others read-only). SQLite rows: `db.sqlite:table` insert, `db.sqlite:table:key` update (JSON content) / delete (empty content).

<critical>
- SHOULD use Edit for modifying existing files.
- NEVER create documentation files (*.md, README) or use emojis unless requested.
</critical>
