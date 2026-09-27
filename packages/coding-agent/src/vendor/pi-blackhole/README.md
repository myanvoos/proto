# pi-blackhole vendor bundle

This directory contains the compiled ESM bundle from
[`pi-blackhole` 0.4.10](https://github.com/k0valik/pi-blackhole/tree/270aa0912800b2b7ce64414ef4247be84106d8f8),
licensed under the adjacent MIT `LICENSE`.

Proto's host API diverged after the package's release. The vendored bundle carries
only the compatibility adaptations required to run against Proto:

- host imports and package-identity checks use `@oh-my-pi/pi-*`;
- token estimation uses Proto's `Tokenizer`;
- `StringEnum` uses the package's bundled TypeBox-compatible schema shape;
- the widened `session_compact_failed` listener preserves its `pi` receiver.

Proto also carries local compaction and recall fixes. The agent-facing `recall`
tool is registered natively in `tools/recall.ts`; this bundle exports its existing
search, expansion, file drill-down, and observation-source behavior for that tool
and retains the `/recall` command. Model-assisted recall runs through the native
kernel bridge rather than registering a second extension tool.

The bundle stays under `vendor/` so repository formatters and linters do not
rewrite third-party code.
