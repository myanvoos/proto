Drives real Chromium tabs; full puppeteer access via JS. Static content → `read` the URL; browser only for JS execution, auth, interactive actions.

- MUST `open` before `run`; tabs survive calls and subagents — open once, reuse.
- `run` scope: `page`, `browser`, `tab`, `display`, `assert`, `wait`; `wait(fn)` polls until truthy — never poll inside `tab.evaluate`. `code` runs with full Node access — not sandboxed. `tab` mirrors puppeteer; drop to raw `page` for anything uncovered.
- Handles: `tab.ref("e5")`/`tab.id(n)` → call methods directly — `(await tab.id(n)).click()`. Handles are NOT selectors; string-selector helpers take selectors only. Snapshot refs work in any selector slot: `tab.click("e5")` ≡ `tab.click("aria-ref=e5")`.
- Default `tab.observe()` → accessibility tree; `ariaSnapshot()` → ARIA YAML with `[ref=eN]`; screenshot only for appearance. `tab.screenshot({ selector?, fullPage?, silent? })` saves to `browser.screenshotDir` (else OS temp), returns path; NEVER accepts a path.
- Gotchas: `tab.fill` NEVER works for `<select>` — use `tab.select`. `waitForNavigation` must start BEFORE the trigger click. Navigation/re-renders invalidate ids/refs — re-observe, act in same cell. Request interception is run-scoped: run end removes handlers, releases held requests.
- `app.path` → NEVER tamper with a real desktop app. `app.relay: true` → drive the user's own Chrome via the proto relay (needs extension); `app.target` picks a tab by URL/title substring, else visible tab adopted without stealing focus.
- `close` releases the session: tool-owned headless pages and cmux surfaces only — NEVER CDP-connected/relay pages; spawned pages stay open unless `kill: true`.
- Selectors: CSS + `aria/…`, `text/…`, `xpath/…`, `pierce/…`; Playwright-only pseudos (`:has-text()`, `:visible`) REJECTED.
