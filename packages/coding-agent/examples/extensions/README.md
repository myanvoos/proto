# Extension Examples

Example extensions for the proto coding agent.

## Usage

```bash
# Load an extension with --extension flag
proto --extension examples/extensions/hello.ts

# Or copy to extensions directory for auto-discovery
cp hello.ts ~/.proto/agent/extensions/
```

## Examples

| Extension          | Description                                                                     |
| ------------------ | ------------------------------------------------------------------------------- |
| `api-demo.ts`      | Tour of the `ExtensionAPI` surface: commands, events, tools, model access       |
| `hello.ts`         | Minimal custom tool example                                                     |
| `pirate.ts`        | Demonstrates `systemPromptAppend` to dynamically modify the system prompt       |
| `thinking-note.ts` | Adds display-only supplemental UI below assistant thinking blocks               |
| `tools.ts`         | Interactive `/tools` command to enable/disable tools with session persistence   |
| `reload-runtime.ts`| Reloads extension code without restarting the session                           |
| `chalk-logger.ts`  | Logs through `@oh-my-pi/pi-utils/chalk` (demonstrates host module resolution)   |
| `with-deps/`       | Extension with its own package.json and dependencies                            |

## Writing Extensions

See [docs/extensions.md](../../../docs/extensions.md) for full documentation.
