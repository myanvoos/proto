# @oh-my-pi/browser-relay

Chrome extension that lets the proto `browser` tool drive **your existing Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway).

The companion relay server lives in the proto CLI (`proto browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream puppeteer connections (proto opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `proto browser-relay install` — writes the bundled extension to the configured browser-relay data dir (`~/.proto/browser-relay/extension` by default; XDG/profile overrides apply), then load it via `chrome://extensions` → Developer mode → *Load unpacked*. (Or grab `proto-browser-relay-extension.zip` from GitHub releases.)
2. `proto config set browser.relay true` — routes the browser tool through the relay. Per-call `app.relay: true` works without the setting.

That's it: when proto runs as a compiled binary or worker host, the relay server auto-starts under proto's profile-independent global daemon broker the first time the browser tool needs it (other entry points may need `proto browser-relay` started manually). Every relay consumer holds a broker lease, so one project exiting cannot interrupt another; the server stops after the last consumer across all projects exits. The extension badge turns **on** when connected. Run `proto browser-relay` manually only for `--token`, `--no-group`, `--dir <project>`, or a non-default port — a relay already serving the port is adopted, never fought over.

`app.target` picks a specific tab by URL/title substring; without it, proto adopts the visible tab without stealing focus. Tabs proto is **actively driving** are gathered into a per-window **"proto" tab group** (cyan) — released when proto lets go of the tab and dissolved on disconnect; the rest of your tabs, pinned tabs, tabs in your own groups, and tabs you drag out are left alone. Disable with `proto browser-relay --no-group`.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).

## Limitations

- `chrome://`, DevTools, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Anything that can reach the relay port can drive your logged-in browser. The relay binds loopback only; use `proto browser-relay --token <secret>` (mirrored in the extension options) if untrusted local processes are a concern.
