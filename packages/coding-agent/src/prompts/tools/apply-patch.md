Edit files via `apply_patch` shell command: stripped-down file-oriented diff.

```
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
```

Headers: `*** Add File: <path>` (every following line `+`), `*** Delete File: <path>`, `*** Update File: <path>` (+ optional `*** Move to:`, then `@@` hunks of ` `/`-`/`+` lines; optional `*** End of File`).

Context: 3 lines around each change; don't duplicate context between nearby changes. Ambiguous target → `@@` anchors (class/function), stacked if needed.

MUST use headers; new-file lines `+`; paths relative, NEVER absolute.
