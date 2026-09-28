---
description: "Use Proto's Python kernel instead of an environment runner for inline Python work"
scope: "tool:bash"
interruptMode: never
match:
  shell: { language: python, kernel: false }
---

This inline Python program runs in a fresh process, bypassing Proto's persistent kernel, prelude helpers, and guarded file edits. Environment runners (`uv run python`, `pixi run python`, Poetry/Pipenv/Conda equivalents), `env`, and `sudo` do not route to the kernel.

- For inline Python work, SHOULD use bare `python -c ...`, `python - ...`, or a quoted heredoc through `bash`.
- Need project dependencies? MUST preserve the project interpreter: invoke `.venv/bin/python` directly, activate the environment first, or select its executable with `protolens context --resource kernel --op start --language python --interpreter /path/to/python`. Then run cells in the same lane. Changing an existing kernel's configuration requires `--op reset` and loses its bindings.
- Ordinary scripts, `python -m ...`, tests, and deliberate process isolation MAY remain fresh processes. NEVER replace a required environment with an unrelated system Python.
- This reminder does not stop the command. NEVER rerun completed work merely to move it into the kernel; continue subsequent work there.
