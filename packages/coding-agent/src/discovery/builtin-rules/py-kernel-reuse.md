---
description: "In the Python kernel, reuse prelude primitives and already-defined functions instead of hand-rolling file, shell, and search helpers"
scope: "tool:kernel"
interruptMode: never
astCondition:
  - "def $F($$$P):\n    return open($X).read()"
  - "def $F($$$P):\n    $$$A\n    return open($X).read()"
  - "def $F($$$P):\n    return Path($X).read_text()"
  - "def $F($$$P):\n    $$$A\n    return Path($X).read_text()"
  - "def $F($$$P):\n    return subprocess.run($$$A)"
---

The kernel namespace persists across calls, and the prelude already ships the common primitives.

## Before defining a helper

- Run `defs()` — functions and classes defined in earlier cells are still bound; reuse them, and only re-define to change them.
- Reach for the prelude API instead of raw file/process plumbing: `bash()`, `read()`, `write()`, `edit()`, `edit_block()`, `block_range()`, `replace()`, `symbols()`, `display()`, `env()`, `output()`, `tool.<name>()`, `agent()`, `completion()`, `parallel()`/`pipeline()`.

## Never shadow prelude names

```python
# Bad — silently replaces the prelude primitive for every later cell
def read(path):
    return open(path).read()

# Good — give helpers distinct names
def read_config(path):
    ...
```

## Hand-rolled patterns to drop

- `open(...).read()` / `Path(...).read_text()` loops → `read(path)`.
- Ad-hoc subprocess wrappers → `await bash(command)`.
- Manual find-and-replace over file text → `replace(path, old, new, count=1)`.
- Scanning files for declarations → `symbols(path)`.
