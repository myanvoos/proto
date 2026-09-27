# User-Facing Packages

This page indexes package-local user-facing CLIs and features that need root docs coverage beyond package-local manifests and implementation docs.

## Root-docs policy

- **Include** root docs coverage for package-local CLIs, extension features, dashboards, and benchmark runners that users can run directly or through `proto`.
- **Exclude explicitly** when a package/crate is internal implementation only; point to the architecture doc that owns it.
- Package manifests, READMEs when present, and package-local setup sources remain the source of truth for setup and flags; root docs make the feature discoverable and link to exact source paths.
- Internal Rust crates remain covered by native architecture docs unless promoted as standalone user-facing commands or APIs. The contributor-facing map lives at [`native-crates.md`](./native-crates.md); today every `crates/*` entry is internal to `@oh-my-pi/pi-natives` and the embedded shell, so [`natives-architecture.md`](./natives-architecture.md) and the surrounding native docs own them.

## Package CLIs and features

### `packages/omptype` — schema validation library

Sources: [`packages/omptype/package.json`](../packages/omptype/package.json) and the repository [omptype authoring guide](./omptype-guide.md).

- Package: public `@oh-my-pi/omptype`; install with `bun add @oh-my-pi/omptype`; requires Bun 1.3.14 or newer.
- Feature: callable ArkType-compatible schemas with cheap interpreted startup, lazy hot-path compilation, validation errors, defaults and morphs, and JSON Schema emission.
- Public surfaces: `@oh-my-pi/omptype` for native authoring, `/typebox` and `/zod` for compatibility builders, and `/ark` for the alias-free ArkType compatibility facade.
- Runtime behavior: schema calls return the validated value or `type.errors`; `.assert()` returns the value or throws; `.allows()` performs a boolean check.
- Limits: this is an intentionally focused compatibility surface rather than a complete implementation of every ArkType, TypeBox, or Zod API.

### `packages/browser-relay` — drive existing Chrome tabs

Sources: [`packages/browser-relay/package.json`](../packages/browser-relay/package.json), [`browser-relay-cli.ts`](../packages/coding-agent/src/cli/browser-relay-cli.ts), and [`packages/coding-agent/src/tools/browser/relay/`](../packages/coding-agent/src/tools/browser/relay/).

- Package: private `@oh-my-pi/browser-relay`; user command: `proto browser-relay`.
- Setup: run `proto browser-relay install`, load the unpacked extension from
  `~/.proto/browser-relay/extension`, then set `browser.relay` or use `app.relay: true`.
- Behavior: the relay auto-starts through the global daemon broker; `app.target` selects a tab by
  URL/title substring, otherwise the visible tab is adopted.
- Security/limits: it binds to `127.0.0.1`. `--token` authenticates the extension WebSocket only; the local `/cdp` endpoint remains loopback-scoped. Chrome
  internal/extension URL schemes are excluded, and tabs whose debugger attach fails are hidden.

