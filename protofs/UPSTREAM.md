# protofs upstream

`protofs` is vendored from the OVN filesystem daemon (`ovnfs`).

| | |
|---|---|
| Source | https://github.com/stencil-hq/ovnfs |
| Commit | `e1f145a96f81af2a2bf622496b07ac880ae46cfc` |
| Commit date | 2026-11-08 |
| License | MIT (see `LICENSE`) |
| Go | 1.27.3 (see `go.mod`) |

The daemon is built from this directory by `scripts/build-protofs.ts`; proto does not download or
install a separate `protofs` binary at runtime.

## Local rebrand changes

- Go module path: `github.com/stencil-hq/ovnfs` → `github.com/myanvoos/proto/protofs`.
- Binary, CLI, usage and version strings: `ovnfs` → `protofs`, `Ovnfs` → `Protofs`,
  `OVNFS` → `PROTOFS`.
- State directory: `~/.local/state/ovnfs` (or `$XDG_STATE_HOME/ovnfs`) → `~/.local/state/protofs`
  (or `$XDG_STATE_HOME/protofs`); Windows `%LOCALAPPDATA%\ovnfs` → `%LOCALAPPDATA%\protofs`;
  temp fallback unchanged.
- Environment variables: `OVNFS_STATE`, `OVNFS_MOUNT`, `OVNFS_CHECKOUT`, `OVNFS_MEMORY`,
  `OVNFS_BLOB_CACHE`, `OVNFS_RELAY_SRC`, `OVNFS_RELAY_LIVE` → `PROTOFS_*`.
- Manifests: `.o2/ovnfs.yml` → `.proto/protofs.yml`; `~/.o2/ovnfs.yml` → `~/.proto/protofs.yml`.
- Admin socket, mount, share, NFS export, ref and temp names: `ovnfs` → `protofs`.
- Docs, comments and test expectations: `ovnfs` → `protofs`.
- Excluded upstream files: `.git`, `.github`, `.goreleaser.yaml`, `bench.sh`.
- Added this file and a `THIRD-PARTY-NOTICES.txt` entry at the proto repository root.

The checkout record file used by the TypeScript client remains `.protofs-checkout.json`.

## Syncing upstream

1. Clone `https://github.com/stencil-hq/ovnfs` and check out the target commit.
2. Copy the source tree over `protofs/`, excluding `.git`, `.github`, `.goreleaser.yaml`, and
   `bench.sh`.
3. Reapply the rebrand in this order (module path first):
   ```sh
   perl -pi -e 's{github\.com/stencil-hq/ovnfs}{github.com/myanvoos/proto/protofs}g; s{\.o2/ovnfs\.yml}{.proto/protofs.yml}g; s{OVNFS}{PROTOFS}g; s{Ovnfs}{Protofs}g; s{ovnfs}{protofs}g; s{\.o2}{.proto}g' $(grep -rIl 'ovnfs\|OVNFS\|Ovnfs\|\.o2' protofs)
   gofmt -w $(find protofs -name '*.go')
   ```
4. Update the table above, `go.mod`/`go.sum`, and the notices entry if the license changes.
5. Run `go build ./...` and `go test ./...` in `protofs/`, then `bun run build:protofs`.
