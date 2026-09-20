# Custom Tools Examples

Example custom tools for proto-coding-agent.

## Examples

### hello/

Minimal example showing the basic structure of a custom tool.

Discovery accepts both single `.ts` files and directories containing an `index.ts` (plus a sibling `package.json` when the tool needs its own metadata).

## Usage

```bash
# Test directly (can point to any .ts file or directory)
proto --tools examples/custom-tools/hello/index.ts

# Or copy into a tools directory for persistent use
cp -r hello ~/.proto/agent/tools/
```

## Writing Custom Tools

See [docs/custom-tools.md](../../../docs/custom-tools.md) for full documentation.

### Key Points

**Factory pattern:**

```typescript
import { Text } from "@oh-my-pi/pi-tui";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
	name: "my_tool",
	label: "My Tool",
	description: "Tool description for LLM",
	parameters: pi.zod.object({
		action: pi.zod.enum(["list", "add"]),
	}),

	// Called on session start/switch/branch/clear
	onSession(event) {
		// Reconstruct state from event.entries
	},

	async execute(toolCallId, params) {
		return {
			content: [{ type: "text", text: "Result" }],
			details: {
				/* for rendering and state reconstruction */
			},
		};
	},
});

export default factory;
```
**Custom rendering:**

```typescript
renderCall(args, options, theme) {
  return new Text(
    theme.fg("toolTitle", theme.bold("my_tool ")) + args.action,
    0, 0  // No padding - Box handles it
  );
},

renderResult(result, { expanded, isPartial }, theme) {
  if (isPartial) {
    return new Text(theme.fg("warning", "Working..."), 0, 0);
  }
  return new Text(theme.fg("success", "✓ Done"), 0, 0);
},
```

**Use `z.enum` for discriminated string tool args:**

```typescript
const z = pi.zod;

parameters: z.object({
	action: z.enum(["list", "add"]),
});
```
