Single-file string replacement; fuzzy whitespace matching.

`old_string` MUST uniquely identify the change — nonunique → add context or `replace_all: true` (also for renaming a string across the file). SHOULD edit existing files, not create new. MUST read the file at least once first; tool errors otherwise.

Pattern-addressed bulk changes → bash: `sd 'pattern' 'replacement' file` / `**/*.ts`. Content identifies the location → this tool.
