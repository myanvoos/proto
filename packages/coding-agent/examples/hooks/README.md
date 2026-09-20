# Hooks Examples

Example hooks for proto-coding-agent.

## Usage

```bash
# Load a hook with --hook flag
proto --hook examples/hooks/permission-gate.ts

# Or copy into a hooks directory for auto-discovery
# (hooks load from hooks/pre/<tool>.ts or hooks/post/<tool>.ts in the config dir;
#  the base filename selects the tool it gates, or * for all tools)
mkdir -p ~/.proto/agent/hooks/pre
cp permission-gate.ts ~/.proto/agent/hooks/pre/bash.ts
```

## Examples

| Hook                     | Description                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ |
| `permission-gate.ts`     | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, etc.)   |
| `git-checkpoint.ts`      | Creates git stash checkpoints at each turn for code restoration on branch      |
| `protected-paths.ts`     | Blocks writes to protected paths (.env, .git/, node_modules/)                  |
| `file-trigger.ts`        | Watches a trigger file and injects contents into conversation                  |
| `confirm-destructive.ts` | Confirms before destructive session actions (clear, switch, branch)            |
| `dirty-repo-guard.ts`    | Prevents session changes with uncommitted git changes                          |
| `auto-commit-on-exit.ts` | Auto-commits on exit using last assistant message for commit message           |
| `custom-compaction.ts`   | Custom compaction that summarizes entire conversation                          |
| `qna.ts`                 | Extracts questions from last response into editor via `ctx.ui.setEditorText()` |
| `status-line.ts`         | Shows turn progress in footer via `ctx.ui.setStatus()` with themed colors      |
| `handoff.ts`             | Transfer context to a new focused session via `/handoff <goal>`                |

## Writing Hooks

See [docs/hooks.md](../../../docs/hooks.md) for full documentation.

```typescript
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI) {
	// Subscribe to events
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
			const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
	});

	// Register custom commands
	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (args, ctx) => {
			ctx.ui.notify("Hello!", "info");
		},
	});
}
```
