Patches files given diff hunks. Primary tool for existing-file edits.

Input `{ path, edits: Entry[] }`; `path` applies to every entry. Entries: `{ op: "update", diff }` (hunks), `{ op: "create", diff }` (full content, no prefixes), `{ op: "delete" }`, `{ op: "update", rename, diff }`.

Diff: hunks start `@@` — bare when context lines alone are unique; else `@@ $ANCHOR` copied verbatim (function signature, class declaration, unique literal; stack anchors if still ambiguous). Body lines start `' '`/`'+'`/'-', ≥1 change per hunk; usually 2–8 context lines; structured blocks include opening+closing lines.

<critical>
- MUST read the target file first; copy anchors/context verbatim including whitespace.
- NEVER use anchors as comments (no line numbers, labels, placeholders like `@@ @@`); NEVER place new lines outside the intended block.
- Failed or structure-breaking edit → re-read file, new patch from current content; NEVER retry the same diff.
- NEVER use edits to fix indentation/whitespace — one formatter run at the end (`bun fmt`, `cargo fmt`, …).
</critical>

Avoid: generic anchors (`import`, `export`, `describe`, `function`, `const`); same addition repeated across hunks; full-file overwrite for minor changes.
