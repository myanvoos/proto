# Tool dogfood coverage and verified repairs

## Scope and safety

Worker coverage used the actual mounted tools, real loopback fixtures, a disposable two-turn worker, temporary local files, and isolated contract tests. No dgx_agent MCP tool was invoked; no git command/commit, credential operation, publishing, real-user question, or destructive user-file change was performed. `bun patch --commit` below is Bun's dependency-patch operation, not a git commit. Parent owns changelog and prompt cleanup.

## Complete tool enumeration

Core exposed tools (6): `functions.bash`, `functions.read`, `functions.inspect_media`, `functions.web_search`, `functions.goal`, `functions.yield`. Also exposed: `multi_tool_use.parallel` wrapper (exercised independent reads).

Mounted non-MCP devices (8): `browser`, `orchestrate_spawn`, `orchestrate_send`, `orchestrate_wait`, `orchestrate_kill`, `orchestrate_list`, `fleet`, `recall`.

Additional dispatch-only utility successfully exercised: `xd report_issue` (plain `<tool>: <description>` payload).

Mounted MCP devices deliberately excluded, zero invocations: `mcp__dgx_agent_aperture_web_fetch`, `mcp__dgx_agent_aperture_web_search`, `mcp__dgx_agent_tailnet_provision_node`, `mcp__dgx_agent_tailnetssh_list_machines`, `mcp__dgx_agent_tailnetssh_run_command`.

Not mounted for this worker: `monitor`, `checklist`, `ask`, `write`, `edit`, `grep`, `find`, `fetch`, `notebook`. Each name was attempted only as `xd NAME ?`, producing the explicit unavailable-device roster. No such tool's implementation ran. Parent independently exercised its main-only monitor/checklist tools. Source behavioral tests cover Ask without interrupting the actual user.

## Invocation matrix

| Tool/surface | Real input and observed result | Disposition |
|---|---|---|
| bash | Real shell pipelines, multiple commands, nonzero errors, Python persistent kernel, fresh Bun scripts, ffmpeg fixture creation | Exercised; shell/kernel implementation owned by sibling |
| read: selectors | 5-line fixture; `:2-3:raw`, `:1-2,4-5`, `:2+2`, `:3-`; exact requested text/continuation notice; `:99-100` explicit beyond-EOF message | Passed |
| read: code | Python function full read and bounded `:2-3`; function context retained | Passed |
| read: directory | Temporary fixture directory `:1+3`; bounded listing and continuation notice | Passed |
| read: conflicts | Local conflict marker listing; direct `conflict://1/ours` returned `old`; no resolution/write | Passed |
| read: archives | ZIP root/member and TAR member returned expected lines; gzip root listing and `:lines.txt` member read | Passed |
| read: bz2/xz | Live tool misclassified streams as binary / failed member paths; source corrected to use complete shared archive format registry | Fixed, regression red→green |
| read: SQLite | Root listed items (2 rows), `:items:2` returned beta, SELECT query returned alpha/beta, WHERE+LIMIT returned beta, missing PK reported no row; DELETE rejected readonly | Passed; DB left unchanged |
| read: documents | Minimal valid DOCX extracted `Dogfood document extraction`; scanned PDF correctly reported no extracted text | Passed |
| read: PDF raster | Live `label.pdf:page-1.png` failed file URL isolation. Source ephemeral exact-file loopback transport, actual load readiness, viewport capture now produce readable `DOGFOOD 123` | Fixed with real browser visual proof |
| read: notebook | Real .ipynb markdown/code cells converted to editable cell text | Passed |
| read: image | PNG decoded inline; visible label `DOGFOOD 123` | Passed |
| read: HTTP | Loopback HTML fetched; tiny fixture's unavailable reader backend transparently returned raw HTML | Passed fallback explicitly identified |
| read: artifact | `artifact://83:1-5` recovered captured shell output with continuation notice | Passed |
| read: history/agent | Direct history URI recovered disposable worker's first turn. Direct agent URI after two successful turns then kill incorrectly said Not found | Runtime sibling reproduced/fixed descendant artifact discovery; mounted binary needs reload |
| xd read URI forwarding | `xd://`, `xd://browser`, `history://...`, `conflict://...` corrupted into filesystem paths; `agent://...` rejected as filesystem input | Fixed `scopeXdevReadArgs` to preserve URI schemes; actual mounted-read source regression red→green |
| inspect_media image | Generated label + fixed browser/PDF screenshots returned inline images; directly visually confirmed labels/form output | Exercised successfully via documented image fallback |
| inspect_media audio | Generated 1s/16kHz mono 440Hz WAV submitted | Blocked: configured `openai-codex/gpt-5.6-luna` lacks audio input |
| inspect_media video | Generated 1s MP4 of label submitted | Blocked: same configured model lacks video input |
| web_search | Harmless public query `SQLite official documentation SELECT`; returned primary https://sqlite.org/lang_select.html | Passed; no dgx MCP search |
| goal | Actual `get` returned No active goal; scoped runtime regression 1 pass/4 assertions | Exercised read-only operation; deliberately did not mutate parent goal state |
| yield | Disposable worker yielded both sentinel turns; this worker yields final structured delivery | Exercised |
| multi_tool_use.parallel | Parallel independent image/archive/SQLite/artifact reads and later recovery reads | Passed |
| browser open | Managed hidden headless tab loaded loopback fixture, correct title | Passed |
| browser run read/visual | `page.title`, `tab.observe`, ARIA snapshot, screenshots | Passed |
| browser run interaction | Live `tab.fill` failed Puppeteer missing caller frame; DOM evaluate interaction produced Ada Blue. Patched-source real Chromium used actionable-handle fill/select/click with stackTraceLimit=0 and asserted Ada Blue | Fixed dependency patch + regression red→green + actual surface proof |
| browser close | Closed only `dogfood-158975`, receipt confirmed release | Passed; no user/relay browser touched |
| fleet process lifecycle | Started loopback HTTP server with TCP readiness; describe/ps/logs/cursor; restart; waited ready; stopped; final exited143 | Passed |
| fleet process stdin | Started dedicated `python -u` READY/input echo child with log readiness; sent `dogfood-stdin`; waited exit; logs `ECHO:dogfood-stdin`; exited0 | Passed |
| fleet peers/jobs | list/send to actual peers, inbox peek, jobs; disposable job completion observed | Passed |
| fleet cancel error | Missing job reported `Cancelled (1)` despite not found | UI sibling reproduced/fixed success/failure tally, with real AsyncJobManager tests |
| recall | Text search, pagination, entry expansion, touched-file pages, file-content query | Exercised; kernel touched-path entry did not contain a full-file write snapshot, so drilldown correctly lacked content |
| orchestrate_spawn | Disposable lightbot `worker-1589761094ac16ac`, no file/tool work delegated; first result DOGFOOD_TURN_ONE | Passed |
| orchestrate_send | Started tracked second turn, result DOGFOOD_TURN_TWO | Passed |
| orchestrate_wait | Watched only disposable worker; delivered turn2 result | Passed |
| orchestrate_list | Showed retained worker; final terminal/nonaddressable after explicit kill | Passed |
| orchestrate_kill | Killed only idle disposable worker; terminal receipt | Passed, recovery-path defect routed/fixed by runtime sibling |
| report_issue | Submitted concise actual contract defects; `Noted, thanks!` acknowledgments | Passed |
| xdev CLI | Schema docs via `?`, flags, positionals, raw JSON, piped JSON, `--query -` stdin, usage errors | Passed; argv containing child flags uses documented JSON escape hatch |
| ask source behavior | New tests prove no-UI invocation aborts with actionable error, unavailable creation returns null, simulated interactive dialog returns selected option | Passed without asking actual user |

## Owned permanent fixes and proof

1. `packages/coding-agent/src/tools/read.ts`: archive gate derives from `ARCHIVE_EXTENSION_ALTERNATION`, eliminating divergent narrow tar/zip/gz allowlist. `read-regressions.test.ts` uses real bzip2/xz bytes and selected member lines. Before fix: Path lines.txt.bz2:lines.txt not found; afterward exact beta/gamma selection and no alpha/delta.
2. `packages/coding-agent/src/tools/xdev.ts`: preserve resource URIs with existing `extractUriScheme` before cwd rebasing. Existing `read-xdev.test.ts` extended with actual mounted `xd://` and `xd://read` dispatch, while retaining local cwd + HTTP regressions. Before: isError=true; after: successful catalog/docs and previous local/HTTP behavior intact.
3. Existing `patches/puppeteer-core@25.3.0.patch`: tolerate absent caller stack frame when attaching evaluation source metadata (`site?.toString() ?? "unknown"`). Persisted with Bun patch workflow. `browser/launch.test.ts` now sets/restores stackTraceLimit=0 and checks callback identity/source tagging/prepareStackTrace restoration. Before: TypeError; after 1 pass/3 assertions. Actual source browser smoke also fills/selects/clicks successfully under the same short-stack condition.
4. `read-pdf.ts`: transient loopback serves only a randomized selected-file URL, GET/HEAD only, closes in finally. PDF viewer load state is checked in main world; viewport capture avoids blank PDF plugin full-page captures. `read-pdf.test.ts` verifies content/mime/loopback/isolation/method policy. Real end-to-end `renderPdfPageScreenshot` returned nonblank readable PDF screenshot (below).
5. `ask-render.test.ts`: additional no-user-interruption behavioral coverage, no ask production implementation changes.

No prompt edits by this worker; descriptions and changelogs intentionally delegated to parent. Parent notified of fleet prompt duplicate sentence and contradictory orchestrate_send addressing, and reports fixing both.

## Exact verification

- `bun test packages/coding-agent/src/tools/read-regressions.test.ts packages/coding-agent/src/tools/read-xdev.test.ts packages/coding-agent/src/tools/xdev.test.ts packages/coding-agent/src/tools/xdev-cli.test.ts packages/coding-agent/src/tools/read-streamed.test.ts packages/coding-agent/src/tools/read-pdf.test.ts packages/coding-agent/src/tools/sqlite-reader.test.ts packages/coding-agent/src/tools/browser/tab-supervisor.test.ts packages/coding-agent/src/tools/ask-render.test.ts` → **55 pass, 0 fail, 189 assertions**.
- `bun test packages/coding-agent/src/tools/browser/launch.test.ts --test-name-pattern 'missing caller stack'` → **1 pass, 0 fail, 3 assertions** (8 unrelated tests filtered).
- `bun test packages/coding-agent/src/goals/runtime.test.ts` → **1 pass, 0 fail, 4 assertions**.
- Parent-authorized `bunx biome check --write` on all 8 changed TS paths → checked 8, fixed formatting in 3.
- Fresh Chromium proof: `bun /tmp/proto-browser-dogfood.ts` → `BROWSER_FILL_SELECT_CLICK_PASS Ada Blue with stackTraceLimit=0`; visual screenshot `/tmp/proto-browser-dogfood-fixed.png` shows input Ada, selector Blue, output Ada Blue.
- Fresh PDF helper proof: `bun /tmp/proto-pdf-dogfood.ts` → screenshot `/tmp/proto-sshots-158979e4dbb9da45.webp`, 1024x576, 2760 bytes, visually reads DOGFOOD 123. Earlier blank screenshot was explicitly rejected and fixed, not treated as success.
- Fixture documents/media retained at `/tmp/proto-tool-dogfood-i45j47zn` for reproducibility. No project scaffolds added.

## External prerequisites and limitations

Audio/video analysis requires an inspect-media role backed by a model supporting the respective modality; current role rejects both before analysis. No capability-selection parameter is exposed on inspect_media, and changing shared model-role configuration was not performed. No unsupported retry was attempted. Image analysis works via inline fallback.

The running mounted harness contains already-loaded code, so in-session old read/xdev/Puppeteer defects remain until reload; fixes were verified through fresh source tests and real Chromium executions, not falsely claimed as hot-reloaded.

No remote SSH/relay/desktop app attachment, real user-question interaction, active parent goal mutation, MCP device, credential access, or external publishing was attempted. These are deliberate safety exclusions, not fabricated coverage.

## Cleanup

Actual final fleet ps: dogfood-http-158975 exited143; dogfood-stdin-158975 exited0. Own managed browser tab closed. Disposable worker terminal after two completed turns. All diagnostic local Chromium instances closed; PDF helper loopback server and tab released in finally. Temporary fixture/media/proof files retained only for evidence.
