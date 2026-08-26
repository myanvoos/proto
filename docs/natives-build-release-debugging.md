# Natives Build, Release, and Debugging Runbook

This runbook describes how `@oh-my-pi/pi-natives` produces `.node` addons, generated declarations, and compiled-binary embedded payloads, and how to debug loader/build failures.

Addon **artifacts are built by plain cargo** through `scripts/build-natives.sh` on matching-host CI runners (no cross-compilation toolchains). The cargo workspace is authoritative for everything: local Rust iteration (rust-analyzer, `cargo nextest`), addon production, and napi typedef regeneration. Runtime loading and embedding are unchanged.

It follows the architecture terms from `docs/natives-architecture.md`:

- **build-time artifact production** (`scripts/build-natives.sh <target>` — cargo `--profile ci` per target)
- **embedded addon manifest generation** (`scripts/embed-native.ts`)
- **runtime addon loading** (`native/index.js`, `native/loader-state.js`)

## Implementation files

Build side:

- `scripts/build-natives.sh` — the canonical driver (per-target cargo build + install)
- root `Cargo.toml` `[profile.ci]` — the shipping codegen profile
- `crates/pi-natives/Cargo.toml` + `build.rs`

Runner requirements: rustup/cargo with the pinned nightly (`rust-toolchain.toml`), `bun` for the host path, and `musl-gcc` for the musl targets on glibc hosts.

Package side (unchanged runtime/packaging):

- `packages/natives/scripts/build-bindings.ts` — dev-only typedef regeneration
- `packages/natives/scripts/embed-native.ts`, `gen-enums.ts`, `gen-npm-packages.ts`
- `packages/natives/package.json`
- `packages/natives/native/index.js`, `native/loader-state.js`

## Build architecture

### 1) Targets and output naming

`scripts/build-natives.sh` builds one addon per shipped `(platform, arch, ISA-variant)` target:

| Target                    | Rust triple                    | Variant RUSTFLAGS                              | Installed filename                      |
| ------------------------- | ------------------------------ | ---------------------------------------------- | --------------------------------------- |
| `linux-x64-baseline`      | `x86_64-unknown-linux-gnu`     | `-Ctarget-cpu=x86-64-v2`                       | `pi_natives.linux-x64-baseline.node`    |
| `linux-x64-modern`        | `x86_64-unknown-linux-gnu`     | `-Ctarget-cpu=x86-64-v3`                       | `pi_natives.linux-x64-modern.node`      |
| `linux-arm64`             | `aarch64-unknown-linux-gnu`    | (none)                                         | `pi_natives.linux-arm64.node`           |
| `linux-musl-x64-baseline` | `x86_64-unknown-linux-musl`    | `-Ctarget-cpu=x86-64-v2 -Ctarget-feature=-crt-static` | `pi_natives.linux-x64-baseline.node` |
| `linux-musl-arm64`        | `aarch64-unknown-linux-musl`   | `-Ctarget-feature=-crt-static`                 | `pi_natives.linux-arm64.node`           |
| `darwin-x64-baseline`     | `x86_64-apple-darwin`          | `-Ctarget-cpu=x86-64-v2`                       | `pi_natives.darwin-x64-baseline.node`   |
| `darwin-arm64`            | `aarch64-apple-darwin`         | (none)                                         | `pi_natives.darwin-arm64.node`          |

Notes:

- musl addons **intentionally ship** under the plain `linux-<arch>` filenames — the loader never sees gnu and musl side by side, so one install slot per platform tag suffices. Because two targets can map to the same installed name, the script's flat output dir uses **target-true names** (`pi_natives.<target>.node`) and `.github/actions/native-artifacts` renames back to canonical at install time.
- Non-x64 targets pin no `-Ctarget-cpu`: they keep the target's default CPU features (`native` would bake build-host features into the addon and trips ring 0.17's const assertion on `aarch64-apple`).
- There is **no win32 target**: Windows is unsupported.

### 2) Build flow

Per target the driver runs, from the repo root:

```sh
RUSTFLAGS="$base $variant_flags" \
PCRE2_SYS_STATIC=1 \
cargo build -p pi-natives --profile ci --target <triple>
cp target/<triple>/ci/libpi_natives.{so,dylib} <dest>/pi_natives.<target>.node
```

Release-grade codegen comes from `[profile.ci]` (opt, thin LTO, codegen-units=16, strip=symbols). The napi link args (`-Wl,-undefined,dynamic_lookup` on macOS, `-Wl,-z,nodelete` on Linux) are emitted by the crate's own `build.rs` via `napi_build::setup()`. `PCRE2_SYS_STATIC=1` forces pcre2-sys to build its vendored static copy — shipped addons must never retain host libpcre2 paths (Homebrew leaked into dylibs before). Pre-existing `RUSTFLAGS` are respected: variant flags append on top. Musl targets additionally get `CARGO_TARGET_<TRIPLE>_CC=musl-gcc` so ring/cc-rs compile their C against musl; missing `musl-gcc` fails fast with an install hint (`apt-get install musl-tools` / `apk add gcc musl-dev`).

### 3) Hosts and portability floor

Each target builds on a matching-host runner — no cross toolchains:

| Target family          | Runner                          | Notes                                                                                     |
| ---------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| linux gnu (x64/arm64)  | ubuntu-22.04 / ubuntu-24.04-arm | glibc floor follows the runner image (2.35 on 22.04); musl legs cover older/other hosts    |
| linux musl (x64/arm64) | same runners + `musl-gcc`       | dynamic CRT (`-Ctarget-feature=-crt-static`; static musl emits no cdylib)                  |
| darwin (x64/arm64)     | macos-15-intel / macos-14       | host Xcode; darwin addons build on mac hosts only                                          |

The Rust toolchain is the nightly pinned in `rust-toolchain.toml`; the script installs missing rustup targets on demand.

## Local development

### Building addons

```bash
# Addon for the current host (x64 hosts pick modern vs baseline via AVX2
# detection), installed into packages/natives/native/. The host target builds
# through the local cargo/napi-rs path:
bun --cwd=packages/natives run build          # = sh ../../scripts/build-natives.sh host --dest native
# same, from the repo root:
bun run build:native

# The driver directly — one cargo build per target, sequential:
sh scripts/build-natives.sh <target>... [--dest <dir>]
sh scripts/build-natives.sh linux-x64-baseline linux-x64-modern --dest packages/natives/native
```

For explicit targets the driver runs `cargo build -p pi-natives --profile ci --target <triple>` with the target's variant RUSTFLAGS and copies the cdylib into `--dest` (default `packages/natives/native`) as `pi_natives.<target>.node`. `host` delegates to `packages/natives/scripts/build-bindings.ts` (which also regenerates typedefs) and must be the only target. Builds are strictly sequential: each addon link peaks at several GiB of rustc RSS.

Flat multi-target dest dirs are safe: musl addons land under their musl-explicit names instead of clobbering the gnu addon that shares their canonical filename.

### Typedef regeneration (napi CLI, dev-only)

`native/index.js`/`index.d.ts` are **committed**, so artifact builds never need the napi CLI. Only when the Rust API surface changes its exported typedefs:

```bash
bun --cwd=packages/natives run build:bindings   # = bun scripts/build-bindings.ts
```

This runs the napi CLI (host-only, local cargo profile) against `crates/pi-natives`, installs the regenerated `index.d.ts`, normalizes the addon filename, and re-renders the explicit ESM exports + runtime enum objects via `gen-enums.ts`. Commit the resulting `index.js`/`index.d.ts` changes.


## CI

### Split Rust validation and addon production

`.github/workflows/ci.yml` separates `rust_validate` from `native_addons`; TypeScript jobs depend only on `native_addons`.

**Pull requests never build or validate Rust.** Native-affecting PRs are rare enough that they don't warrant a PR-side addon build: `rust_validate` is skipped entirely (`if: github.event_name != 'pull_request'`), and `native_addons` fetches the latest release's Linux x64 addon pair from the `@oh-my-pi/pi-natives-linux-x64` npm leaf, smoke-loads both, and uploads them as the `native-addons` workflow artifact. The loader skips its version sentinel for workspace loads, so release-versioned addons load fine under a newer checkout. A PR whose TypeScript tests depend on changed native behavior fails visibly (and CI emits a notice on any native-touching PR); the Rust side is validated post-merge on main and again at release.

On non-PR events both jobs run on `proto-kata` pods. `rust_validate` runs plain cargo, with an actions/cache entry over `~/.cargo/registry`, `~/.cargo/git`, and the shared `target/` dir keyed on the `Cargo.lock` hash:

```bash
bun run test:rs                                            # nextest + doctests via scripts/run-rs-task.ts
cargo clippy --workspace --exclude brush-core --no-deps -- -D warnings
cargo fmt --all --check
```

- Cargo reads `[lints]` directly, so the lint policy is automatic per crate: crates with `[lints] workspace = true` get the strict workspace policy, pi-builtins' manifest allowances apply to itself.
- `--exclude brush-core` mirrors `VENDORED_FORK_EXCLUDES` in `scripts/run-rs-task.ts` — the vendored fork is not held to workspace gates.

`native_addons` on main runs `scripts/build-natives.sh linux-arm64 linux-musl-arm64 linux-musl-x64-baseline linux-x64-baseline linux-x64-modern --dest "$RUNNER_TEMP/native-addons"` — strictly sequential inside the script so the heavy links never overlap (concurrent links OOM'd kata pods historically). It uploads `$RUNNER_TEMP/native-addons/*.node` as the `native-addons` artifact; because the glob matches files directly in the directory, they land at the archive root under their target-true names. Downstream jobs use `.github/actions/native-artifacts` to download that artifact and copy the requested targets into place (renaming musl addons back to canonical filenames) without rebuilding.

Musl legs need `musl-gcc` on the runner image (`apt-get install musl-tools`); the script fails fast with that hint when absent.

### Native artifact action

`.github/actions/native-artifacts` is the no-build consumer: download the `native-addons` artifact into `$RUNNER_TEMP/proto-native-artifacts`, then a small POSIX loop copies each requested target's file into the destination (default `packages/natives/native`) under its canonical loader filename. It resolves `pi_natives.<target>.node` first (artifact layout) and falls back to the canonical name (sources already laid out canonically, e.g. `packages/natives/native` or npm tarballs).

### Release binary builds and publishing

Binary builds are build-only and run in parallel with the test fan-out. `release_binary` (Linux matrix) needs only `native_addons`, whose workflow artifact supplies their addons. `release_binary_darwin` needs only `release_metadata` and starts the moment a release run is detected: darwin artifacts cannot be cross-built on Linux, so each macOS leg runs `scripts/build-natives.sh <native_targets> --dest packages/natives/native` itself (cold cargo builds accepted; no cache wiring), then `bun run ci:release:build-binaries` embeds and compiles the executable. Publishing is held behind `release_gate` (the aggregate of every validation job): `release_native_leaves` downloads all built addons and publishes the four `@oh-my-pi/pi-natives-<tag>` leaf packages (linux-x64, linux-arm64, darwin-x64, darwin-arm64).

## Debugging playbook

### Where things land / how to inspect

```bash
# Output cdylib per target (profile dir under the triple):
ls target/x86_64-unknown-linux-gnu/ci/libpi_natives.so

# What rustc command a build runs (add the same --target/--profile):
cargo build -p pi-natives --profile ci --target <triple> -v

# Confirm which RUSTFLAGS the driver would use for a target:
sh -x scripts/build-natives.sh linux-x64-baseline --dest /tmp/natives-probe

# Inspect a built addon's exports without loading it:
nm -D target/<triple>/ci/libpi_natives.so | grep __piNativesV
```

The driver streams cargo output live; on failure it exits with cargo's status and prints the offending target/triple/flags line so the exact `cargo build` can be re-run by hand.

### Common failure classes

| Symptom                                                    | Cause                                                                     | Fix (in tree)                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| musl build "succeeds" but emits no `.node`                 | musl defaults to `+crt-static`; rustc silently emits no cdylib            | `-Ctarget-feature=-crt-static` variant flag in `scripts/build-natives.sh`             |
| musl target fails compiling ring/pcre2 C code              | cc-rs compiled against glibc headers                                      | `CARGO_TARGET_<TRIPLE>_CC=musl-gcc` set by the script; install `musl-tools` if absent |
| `error: target was not found` from rustup                  | cross triple not installed on this host                                   | the script runs `rustup target add` automatically when rustup is present              |
| gnu addon overwritten by musl (or vice versa) in one dest  | both targets share canonical basenames                                    | artifact layout stores musl under target-true names; installs rename back             |

### Cache behavior

- **rust_validate:** one actions/cache entry over `~/.cargo/registry`, `~/.cargo/git`, and the workspace `target/` dir, keyed on the `Cargo.lock` hash with an OS-level prefix fallback. Only non-PR runs execute the job, so main/release pushes are the producers.
- **Addon builds:** no cache wiring — matching-host runners rebuild natively; cold darwin release builds are accepted.

## Target/variant model and naming conventions

## Platform tag

Both build and runtime use platform tag:

`<platform>-<arch>` (example: `darwin-arm64`, `linux-x64`).

## Variant model (x64 only)

x64 supports CPU variants, encoded as per-target RUSTFLAGS in `scripts/build-natives.sh` (baseline → `-Ctarget-cpu=x86-64-v2`, modern → `x86-64-v3`):

- `modern` (AVX2-capable path)
- `baseline` (fallback)

Non-x64 uses a single default artifact with no variant suffix. There is no build-time variant _switch_: each variant is its own target, and the `host` pseudo-target picks modern vs baseline via AVX2 detection.

### Output filenames

- x64: `pi_natives.<platform>-<arch>-modern.node` or `...-baseline.node`
- non-x64: `pi_natives.<platform>-<arch>.node`

Runtime x64 candidate order also includes the unsuffixed default filename after the selected variant candidates.

## Runtime flags

- `PI_NATIVE_VARIANT`: x64 runtime override; valid values are `modern` and `baseline`. Invalid values are ignored and normal detection runs.
- `PI_DEBUG_STARTUP`: writes synchronous `[startup] native:…` markers to stderr around loader entry, embedded extraction, candidate loads, and native Tokio runtime installation; use it to localize startup hangs.
- `PI_COMPILED`: compiled-mode signal. Release compilation constant-folds `process.env.PI_COMPILED` to `"true"`; a populated embedded-addon manifest and Bun embedded URL markers also signal compiled mode.

## Embed lifecycle (`embed-native.ts`)

1. **Init**: compute the platform tag (host values, overridable by the release packaging script for cross-target archives).
2. **Candidate set**:
   - x64 looks for `modern` and `baseline` files;
   - non-x64 looks for one default file.
3. **Validate availability**: at least one expected file must exist in `packages/natives/native`.
4. **Generate archive + manifest**: write `native/embedded-addons.<platform>-<arch>.tar.gz` containing all available target addon files and `native/embedded-addon.js` with package version, archive metadata, and file sizes.
5. **Runtime extraction ready** for compiled mode.

`--reset` writes the null manifest stub (`embeddedAddon = null`) without validating addon availability, and deletes any existing `embedded-addons.*.tar.gz` archives from `native/`.

## Dev workflow vs shipped/compiled behavior

## Local development workflow

Typical local loop:

1. Build addon: `bun --cwd=packages/natives run build`.
2. Loader resolves platform npm leaf-package candidates (`@oh-my-pi/pi-natives-<platform>-<arch>`, when resolvable), then package-local `native/` and executable-dir fallback candidates.
3. Generated declarations in `native/index.d.ts` describe the public TS API (regenerate with `build:bindings` only when the Rust API surface changes).
4. On Windows package installs, the loader first copies a `node_modules` addon into the versioned cache so a running process does not lock the file Bun must replace during a later global update.
5. After a successful load, older semver-shaped version cache directories are removed best-effort; cleanup failures never abort startup.

## Shipped/compiled binary workflow

In compiled mode (`PI_COMPILED`, Bun embedded URL markers, or populated embedded manifest):

1. Loader computes versioned cache dir: `<getNativesDir()>/<packageVersion>`.
2. If embedded manifest matches current platform+version, loader extracts the selected file from `embedded-addons.<tag>.tar.gz` into that versioned dir when the cached file is absent or has the wrong size.
3. Runtime candidate order includes:
   - extracted versioned cache path, if available,
   - versioned cache dir,
   - legacy compiled-binary dir (`%LOCALAPPDATA%/proto` on Windows, `~/.local/bin` elsewhere),
   - package/executable directories.
4. First successfully loaded addon with the expected version sentinel is returned.

This is why packaging + runtime loader expectations must align: filenames, platform tags, CPU variants, and embedded manifest version must match what `native/loader-state.js` probes.

## JS API ↔ Rust export mapping (build sanity subset)

Generated declarations currently include exports from these Rust modules:

| Area                   | Representative JS exports                                                                                                               | Rust source                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Search/workspace       | `grep`, `search`, `hasMatch`, `fuzzyFind`, `glob`, `listWorkspace`, `invalidateFsScanCache`                                             | `grep.rs`, `fd.rs`, `glob.rs`, `workspace.rs`, `iofs.rs`                     |
| AST/block/summary      | `astGrep`, `astEdit`, `blockRangeAt`, `summarizeCode`                                                                                   | `ast.rs`, `block.rs`, `summary.rs`                                           |
| Text/highlight/tokens  | `visibleWidth`, `truncateToWidth`, `highlightCode`, `countTokens`                                                                       | `text.rs`, `highlight.rs`, `tokens.rs`                                       |
| Shell/PTY/process/keys | `executeShell`, `Shell`, `PtySession`, `Process`, `parseKey`                                                                            | `shell.rs`, `pty.rs`, `ps.rs`, `keys.rs`                                     |
| Media/system/iso       | `encodeSixel`, `copyToClipboard`, `detectMacOSAppearance`, `MacOSPowerAssertion`, `getWorkProfile`, `isoBackend`, `isoStart`, `isoDiff` | `sixel.rs`, `clipboard.rs`, `appearance.rs`, `power.rs`, `prof.rs`, `iso.rs` |

## Failure behavior and diagnostics

## Build-time failures

- Cargo compile failure: the driver exits with cargo's status; re-run the printed `cargo build -p pi-natives --profile ci --target <triple>` line directly (add `-v`) to iterate.
- Unknown target name: the driver errors with the full known-target list (`linux-*`/`darwin-*` targets + `host`).
- `host` combined with explicit targets: refused — `host` delegates to the napi-rs path and must be alone.
- Missing cdylib after a "successful" build: driver exits 1 naming the expected path (check for the musl static-CRT case above).
- `build:bindings` (napi) failure: script surfaces non-zero exit and stderr; artifact builds are unaffected (the driver never runs the napi CLI).

## Runtime loader failures (`native/loader-state.js`)

- Unsupported platform tag: throws with supported platform list after probing fails.
- No candidate could load: throws with full candidate error list and mode-specific remediation hints.
- Embedded extraction and Windows staging problems: archive/mkdir/write/copy errors are recorded and included in final diagnostics if load fails.
- Version mismatch: install/compiled loads that lack the package-version sentinel are rejected during candidate probing.

## Troubleshooting matrix

| Symptom                                                                | Likely cause                                                                                | Verify                                                            | Fix                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Cannot find module` or dynamic library load error for every candidate | Missing release artifact, wrong platform tag, or stale compiled cache                       | Inspect loader error list and `packages/natives/native` filenames | Build correct target (`sh scripts/build-natives.sh <t> --dest packages/natives/native`); delete stale cache for the package version |
| Export is missing at runtime but present in TypeScript                 | Stale `.node` loaded, generated declarations newer than binary, or Rust export not compiled | Require the actual candidate and inspect `Object.keys(mod)`       | Rebuild native package and remove stale candidate/cache paths                                                                        |
| x64 machine loads baseline when modern expected                        | `PI_NATIVE_VARIANT=baseline`, no AVX2 detected, or modern file unavailable                  | Check env and filenames in `native/`                              | Build and ship the modern target (`sh scripts/build-natives.sh linux-x64-modern --dest packages/natives/native`)                    |
| gnu addon overwritten by musl (or vice versa)                          | A dest mixed canonical filenames across libcs (pre target-true artifact names)              | Compare artifact sources vs installed file                        | Rebuild with the current script/action — flat dirs use musl-explicit names and installs rename back                                 |
| Compiled binary fails after upgrade                                    | Stale extracted cache, embedded archive mismatch, or embedded manifest version mismatch     | Inspect `<getNativesDir()>/<version>` and loader error list       | Delete versioned cache for the package version; regenerate embedded archive/manifest during packaging                                |
| `gen:native` fails with `No native addons found`                       | Required platform artifact was not built before embedding                                   | Check expected list in error text                                 | Build at least one expected artifact for the target, then rerun `gen:native`                                                         |

## Operational commands

```bash
# Addon for the current host, installed into packages/natives/native/
bun --cwd=packages/natives run build

# Explicit targets (x64 variants are separate targets, not env switches)
sh scripts/build-natives.sh linux-x64-modern linux-x64-baseline --dest packages/natives/native

# Regenerate TS typedefs + enum exports (napi CLI, only on Rust API changes)
bun --cwd=packages/natives run build:bindings

# Generate embedded addon manifest from built native files
bun run gen:native
# Output archive: packages/natives/native/embedded-addons.<platform>-<arch>.tar.gz

# Reset embedded manifest to null stub
bun run gen:native:reset
```

