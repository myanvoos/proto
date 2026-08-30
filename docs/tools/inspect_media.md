# inspect_media

> Send a local media file (image, audio, or video) or a current-turn image attachment to a capable model and return text analysis.

## Source
- Entry: `packages/coding-agent/src/tools/inspect-media.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/inspect-media.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/inspect-media-renderer.ts` — TUI call/result rendering.
  - `packages/coding-agent/src/utils/image-loading.ts` — image path resolution, type detection, size gate, optional resize.
  - `packages/coding-agent/src/utils/media-loading.ts` — audio/video loading with magic-byte detection and size gate.
  - `packages/coding-agent/src/utils/image-resize.ts` — downscale and recompress oversized images (images only).
  - `packages/coding-agent/src/tools/path-utils.ts` — resolve input path relative to session cwd.
  - `packages/utils/src/mime.ts` — detect supported image, audio, and video formats from file bytes.
  - `packages/ai/src/providers/vision-guard.ts` — shared media-support gating and omission placeholders.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Local media path (resolved relative to `session.cwd`), current-turn `Image #N` label, or `attachment://N` / `image://N` URI. Attachment indexes are 1-based and are always image attachments. |
| `question` | `string` | Yes | User prompt sent as a text content block alongside the media. |

## Outputs
The tool returns a single `AgentToolResult`:

- `content`: one text block, `[{ type: "text", text }]`, where `text` is the concatenated assistant text content from the model response.
- `details`:
  - `model`: `<provider>/<id>` of the selected model.
  - `mediaPath`: resolved filesystem path for a file input, or the canonical attachment URI for an attachment input.
  - `mimeType`: MIME type actually sent to the model after optional resize/re-encode.

Model-visible output is single-shot, not streamed by this tool.

TUI rendering adds presentation-only truncation from `packages/coding-agent/src/tools/inspect-media-renderer.ts`:

- call preview truncates `question` to 100 columns,
- result view shows 4 lines collapsed or 16 lines expanded,
- each rendered output line is truncated to 120 columns,
- footer metadata shows `model · mimeType` when present.

## Flow
1. `InspectMediaTool.execute(...)` reads `session.modelRegistry`; missing registry, empty registry, missing API key, or unresolved model each raise `ToolError` from `packages/coding-agent/src/tools/inspect-media.ts`.
2. Model selection collects candidates in order — `@vision`, `@default`, the active model string from the session, then `availableModels[0]` as fallback — via `expandRoleAlias(...)` and `resolveModelFromString(...)`.
3. The media kind is detected before the model call: attachment references are always images; file inputs are sniffed with `readImageMetadata(...)` first, then `readMediaMetadata(...)`. Unrecognized files raise `ToolError` with the supported-format list.
4. `images.blockImages` blocks image inspection only; audio and video are not governed by that setting.
5. Among the resolved candidates, the tool prefers the first model whose `input` includes the detected kind (`image`, `audio`, or `video`); if none support it, the first candidate is used and execution fails with an actionable capability error.
6. File bytes are loaded by kind: `loadImageInput(...)` for images (WebP exclusion, optional `images.autoResize` resize, 20 MiB cap via `MAX_IMAGE_INPUT_BYTES`), `loadMediaFileInput(...)` for audio/video (no resize, 20 MiB cap via `MAX_MEDIA_INPUT_BYTES`).
7. The tool calls `instrumentedCompleteSimple(...)` with one user message containing two content parts in order:
   - `{ type: "image" | "audio" | "video", data, mimeType }`
   - `{ type: "text", text: params.question }`
8. `systemPrompt` is a one-element array rendered from `packages/coding-agent/src/prompts/tools/inspect-media-system.md`; telemetry is tagged with oneshot kind `inspect_media`. The request carries the thinking effort selected on the resolved model role.
9. The model call uses the caller signal plus `inspect_media.timeoutMs` (default 300,000 ms); `0` disables this timeout. Provider errors, aborts, and timeouts become `ToolError`s.
10. `extractTextContent(...)` from `packages/coding-agent/src/commit/utils.ts` concatenates only `text` content blocks from the assistant message, trims the result, and the tool fails if nothing remains.
11. Success returns the text plus `details`; `inspectMediaToolRenderer` formats the result for the TUI.

## Provider support
Whether a provider transmits audio/video depends on the model advertising the modality in `input` and the provider wire format:

- Google (`inlineData` parts): images plus native audio (`audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/flac`, `audio/mp4`, `audio/aac`, `audio/aiff`) and video (`video/mp4`, `video/webm`, `video/quicktime`, `video/mpeg`).
- OpenAI chat completions (`input_audio` parts): audio as `wav` or `mp3` only.
- Responses/Anthropic/Cursor/Ollama/Bedrock/Devin/Codex wire formats: images only; audio and video content is demoted to a text omission note (`[audio omitted: ...]`) so history replay never crashes.

## Modes / Variants
- **Original image path**: `images.autoResize` disabled. The original file bytes are base64-encoded and sent with the detected MIME type.
- **Auto-resized path**: `images.autoResize` enabled. `resizeImage(...)` may downscale and re-encode the image before upload. Audio/video are never resized.
- **Unsupported format path**: file exists but header sniffing does not identify a supported format. The tool returns a `ToolError` before any model call.
- **Oversize path**: file size exceeds 20 MiB before upload. The tool returns a `ToolError` before any model call.
- **Attachment path**: resolve a current-turn pasted/uploaded image by its `Image #N` label or attachment URI without reading a filesystem path.
- **Unsupported modality path**: the selected model does not advertise the detected kind in `input`. The tool returns a `ToolError` naming the model and the missing modality.

## Side Effects
- Filesystem
  - For file inputs, resolves and reads the target media from disk.
  - Attachment inputs are loaded from the current turn's in-memory image attachment list.
- Network
  - Sends the final base64 media payload plus question text to the selected model through `instrumentedCompleteSimple(...)` / the configured simple completion implementation.
- Session state
  - Reads session settings, active model preferences, cwd, and model registry.
- Background work / cancellation
  - Passes the caller `AbortSignal` into `instrumentedCompleteSimple(...)` and the configured simple completion implementation.
  - Media preprocessing is local and not cancellation-aware.

## Limits & Caps
- Supported detected formats (`packages/utils/src/mime.ts`):
  - images: `image/png`, `image/jpeg`, `image/gif`, `image/webp` (`SUPPORTED_IMAGE_MIME_TYPES`)
  - audio: `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/flac`, `audio/mp4`, `audio/aac`, `audio/aiff` (`SUPPORTED_AUDIO_MIME_TYPES`)
  - video: `video/mp4`, `video/webm`, `video/quicktime`, `video/mpeg` (`SUPPORTED_VIDEO_MIME_TYPES`)
- Metadata sniff cap: `DEFAULT_IMAGE_METADATA_HEADER_BYTES = 256 * 1024` bytes for both image and media detection.
- Upload input cap: 20 MiB for both `MAX_IMAGE_INPUT_BYTES` and `MAX_MEDIA_INPUT_BYTES`.
- Request timeout: `inspect_media.timeoutMs` defaults to `300_000` ms; `0` disables.
- Availability is gated by `inspect_media.mode` (`auto`|`on`|`off`, default `auto`) in `packages/coding-agent/src/config/settings-schema.ts`, resolved with the session-scoped `/vision` override and the active model's image capability in `packages/coding-agent/src/utils/inspect-media-mode.ts` / `packages/coding-agent/src/tools/index.ts`. `auto` registers the tool only when the active model lacks native image input; the legacy `inspect_image.enabled` boolean migrates to `mode` (`true`→`on`, `false`→`off`).
- Image auto-resize defaults in `packages/coding-agent/src/utils/image-resize.ts`: `maxWidth`/`maxHeight` 1568, `maxBytes` 500 KiB target, `jpegQuality` 80, quality ladder `[70, 60, 50, 40]`, dimension ladder `[1.0, 0.75, 0.5, 0.35, 0.25]` (min dimension 100 px).
- Renderer caps: `INSPECT_QUESTION_PREVIEW_WIDTH = 100`, `INSPECT_OUTPUT_COLLAPSED_LINES = 4`, `INSPECT_OUTPUT_EXPANDED_LINES = 16`, `INSPECT_OUTPUT_LINE_WIDTH = 120`.

## Errors
- Model resolution / capability:
  - `Model registry is unavailable for inspect_media.`
  - `No models available for inspect_media.`
  - `Unable to resolve a model for inspect_media.`
  - `Resolved model <provider>/<id> does not support image input. Configure a vision-capable model for modelRoles.vision.`
  - `Resolved model <provider>/<id> does not support <audio|video> input. Configure a model with <audio|video> input support (e.g. via modelRoles) and retry.`
  - `No API key available for <provider>/<id>. Configure credentials for this provider or choose another <kind>-capable model.`
- Input file:
  - `Image file too large: ...` / `Media file too large: ...` remapped to `ToolError`.
  - `inspect_media supports images, audio, and video detected by file content. Supported formats: ...` when header sniffing fails.
  - `inspect_media could not decode the file as a supported image (PNG, JPEG, GIF, or WEBP detected by file content).` when an image-classified file fails to load.
  - `No image attachments are available in this turn...` when a reference is used without current-turn image attachments.
  - `Could not resolve image attachment ... Available image attachments: ...` when the 1-based reference is out of range.
- Model call:
  - `inspect_media request failed.` if the response stop reason is `error` without a provider message.
  - Provider `errorMessage` is passed through when present.
  - `inspect_media request aborted.` on aborted responses.
  - `inspect_media request timed out after <seconds>s...` when `inspect_media.timeoutMs` expires.
  - `inspect_media model returned no text output.` when the assistant message contains no text blocks after filtering.

Failures surface as thrown `ToolError`s from `execute(...)`; the normal success return shape is not used for error reporting.

## Notes
- Although the `AgentTool.strict` transport hint is `false`, the ArkType schema explicitly rejects unknown parameters; only `path` and `question` are accepted.
- The model-facing prompt path on disk is `packages/coding-agent/src/prompts/tools/inspect-media.md`; the underscore form does not exist.
- Format support is based on file content, not filename extension. Renaming a non-media file to `.mp3` does not make it valid.
- `resolveReadPath(...)` tries macOS-specific path variants: shell-unescaped spaces, AM/PM narrow no-break-space filenames, NFD normalization, and curly-quote variants.
- `loadImageInput(...)` also computes `textNote`, `dimensionNote`, and final `bytes`, but `inspect_media` does not include those in tool output.
- Auto-resize can change the MIME type sent to the model. A JPEG or GIF input may be uploaded as PNG, JPEG, or WebP depending on which encoder output is smallest.
- If `resizeImage(...)` throws or cannot decode the image, `loadImageInput(...)` silently keeps the original base64 payload instead of failing.
