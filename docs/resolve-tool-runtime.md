# Resolution devices runtime

Pending previews do not expose a native `resolve` tool. They finalize through the existing `bash` tool by running `protolens resolve <reason>` or `protolens reject <reason>`; the resolution-device implementation lives in `packages/coding-agent/src/tools/resolve.ts`:

- `protolens://resolve` — apply the pending staged preview; the bash form takes a one-sentence plain-text reason
- `protolens://reject` — discard the pending staged preview; the bash form takes a one-sentence plain-text reason

These are internal URLs, not filesystem paths. `read protolens://resolve` and `read protolens://reject` return a one-line usage hint. Direct device dispatches carry `details.xdev` metadata; `writeDeviceDispatch()` unwraps that dispatch, and `resolveDispatchDetails()` extracts its resolution action and reason.

## Preview flows

Preview producers call `queueResolveHandler(...)` with `apply(reason, signal?)` and an optional `reject(reason, signal?)` callback. Each preview receives a unique pending-invoker ID in `ToolChoiceQueue`, so stacked previews remain separate.

While a preview is pending, `AgentSession.nextToolChoiceDirective()` returns a soft requirement:

- `soft: true`
- `toolName: "bash"`
- `satisfies: isPreviewResolutionToolCall`
- reminder built from `resolve-device-reminder.md`

`isPreviewResolutionToolCall` accepts only a `bash` call whose command is one shell segment invoking `protolens resolve` or `protolens reject`. Other tool calls are skipped while the soft requirement is active, then the agent loop escalates to a forced `bash` call on the next turn.

Resolution dispatch selects the in-flight queue invoker first, otherwise the newest pending invoker, and invokes it through `runResolveInvocation(...)`.

- A completed apply or discard consumes that pending invoker exactly once.
- A non-abort apply failure re-registers the same preview so the model can reject it or retry after fixing the cause.
- Rejecting with no pending action succeeds with `Nothing to reject; no pending action remains.`
- Resolving with no pending action throws.
- An apply callback's ordinary error becomes `ToolError("Apply failed: ...")`; an existing `ToolError` is preserved.

## Bash transport

Resolution is not a separately enabled tool. `createTools(...)` includes the native `bash` tool when `bash.enabled` and the requested-tool policy allow it; `tools.xdev` must also be enabled for the bash bridge to dispatch `protolens` devices. `BashTool` routes those invocations through `dispatchProtolensArgv(...)`.

## Custom tools

Custom tools stage previews through `pushPendingAction(...)`. During SDK setup, `loadCustomTools(...)` receives a callback that calls `queueResolveHandler(toolSession, action)`; the loader forwards each action and defaults a missing `sourceToolName` to `custom_tool`. Finalization is a `bash` invocation of `protolens resolve <reason>` or `protolens reject <reason>`, not a native `resolve` tool call.
