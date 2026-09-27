# Resolution devices runtime

Pending previews do not expose a native `resolve` tool. They finalize through the existing `bash` tool by running `protolens resolve <reason>` or `protolens reject <reason>`; the resolution-device implementation lives in `packages/coding-agent/src/tools/resolve.ts`:

- `protolens://resolve` — apply the pending staged preview; the bash form takes a one-sentence plain-text reason
- `protolens://reject` — discard the pending staged preview; the bash form takes a one-sentence plain-text reason

These are internal URLs, not filesystem paths. `read protolens://resolve` and `read protolens://reject` return a one-line usage hint. Direct device dispatches carry `details.xdev` metadata; `writeDeviceDispatch()` unwraps that dispatch, and `resolveDispatchDetails()` extracts its resolution action and reason.

## Preview flows

Preview producers call `queueResolveHandler(...)` with `apply(reason)` and optional `reject(reason)` callbacks. Each preview receives a unique pending-invoker ID in `ToolChoiceQueue`, so stacked previews do not overwrite one another.

While a preview is pending, `AgentSession.nextToolChoiceDirective()` returns a soft requirement:

- `toolName: "write"`
- `satisfies: isPreviewResolutionToolCall`
- reminder from `resolve-device-reminder.md`

`isPreviewResolutionToolCall` accepts only a `bash` call whose command is one shell segment invoking `protolens resolve` or `protolens reject`. Other tool calls are skipped while the soft requirement is active, then the agent loop escalates to a forced `bash` call on the next turn.

Dispatch invokes the pending queue head through `runResolveInvocation(...)`.

- A successful apply or discard consumes that pending invoker exactly once.
- If apply throws, the same preview is re-registered so the model can reject it or retry after fixing the cause.
- Rejecting with no pending action succeeds with `Nothing to reject; no pending action remains.`
- Resolving with no pending action throws.
- An apply callback's ordinary error becomes `ToolError("Apply failed: ...")`; an existing `ToolError` is preserved.

## Why `write` is guaranteed

Resolution is not a separately enabled tool. `createTools(...)` includes the native `bash` tool when `bash.enabled` and the requested-tool policy allow it; `tools.xdev` must also be enabled for the bash bridge to dispatch `protolens` devices. `BashTool` routes those invocations through `dispatchProtolensArgv(...)`.

## Custom tools

Custom tools stage previews through `pushPendingAction(...)`. During SDK setup, `loadCustomTools(...)` receives a callback that calls `queueResolveHandler(toolSession, action)`; the loader forwards each action and defaults a missing `sourceToolName` to `custom_tool`. Finalization is a `bash` invocation of `protolens resolve <reason>` or `protolens reject <reason>`, not a native `resolve` tool call.
