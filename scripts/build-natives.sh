
#
# Build the shipping pi_natives N-API addons with plain cargo on the host
# toolchain (matching-host runners; no cross-compilation toolchains).
#
# Replaces the former Bazel pipeline. Release-grade codegen comes from the
# workspace [profile.ci] (opt, thin LTO, codegen-units=16, strip=symbols --
# the exact settings the old bazel/defs.bzl transition pinned), and the
# per-target ISA variants ride in RUSTFLAGS the way bazel/variants selected
# them before:
#
#   *-baseline (x64)  -> -Ctarget-cpu=x86-64-v2 (x86-64-v2 reproducible floor)
#   *-modern   (x64)  -> -Ctarget-cpu=x86-64-v3 (AVX2)
#   non-x64           -> no -Ctarget-cpu pin: keep the target's default CPU
#                        features (-Ctarget-cpu=native would bake the build
#                        host's features into the addon and trips ring 0.17's
#                        const assertion on aarch64-apple)
#   musl              -> additionally -Ctarget-feature=-crt-static (musl
#                        defaults to +crt-static, under which rustc silently
#                        emits no cdylib at all)
#
# The napi link args (-Wl,-undefined,dynamic_lookup on macOS,
# -Wl,-z,nodelete on Linux) are emitted by the crate's build.rs via
# napi_build::setup(); no manual wiring needed on the cargo path.
#
# PCRE2_SYS_STATIC=1 is always forced: pcre2-sys prefers a system libpcre2
# when pkg-config finds one, and shipped addons must never retain host
# libpcre2 paths (Homebrew leaked into dylibs before).
#
# Output naming: each addon lands as pi_natives.<target>.node. For every
# non-musl target this equals the loader-canonical
# pi_natives.<platform>-<arch>[-<variant>].node name. Musl addons SHIP under
# the plain linux-<arch> canonical filenames (the runtime loader never sees
# gnu and musl side by side), so a flat artifact directory holding both
# libcs needs disambiguated names -- hence target-true names here;
# .github/actions/native-artifacts renames back to canonical names at
# install time.
#
# Requirements:
#   - rustup/cargo with the pinned nightly (rust-toolchain.toml); missing
#     rust targets are installed on demand via `rustup target add`.
#   - musl targets on a glibc host need musl-gcc (debian/ubuntu:
#     `apt-get install musl-tools`, alpine: `apk add gcc musl-dev`); it is
#     wired in as CARGO_TARGET_<triple>_CC for ring/cc-rs.
#
# Usage: scripts/build-natives.sh [--dest DIR] <target>...
# Targets:
#   linux-x64-baseline  linux-x64-modern  linux-arm64
#   linux-musl-x64-baseline  linux-musl-arm64
#   darwin-x64-baseline  darwin-arm64
#   host                build just the current machine through the local
#                       napi-rs path (packages/natives/scripts/
#                       build-bindings.ts; AVX2 detection picks the x64
#                       variant). Must be the only target; --dest is ignored.
#
# Default --dest: packages/natives/native.
#
# Builds run strictly sequentially: each addon link peaks at several GiB of
# rustc RSS, and concurrent links OOM'd CI pods back in the bazel era.

set -eu

SUPPORTED_TARGETS="linux-x64-baseline linux-x64-modern linux-arm64 linux-musl-x64-baseline linux-musl-arm64 darwin-x64-baseline darwin-arm64"

usage() {
	echo "Usage: scripts/build-natives.sh [--dest DIR] <target>..."
	echo "Targets: ${SUPPORTED_TARGETS} host"
}

die() {
	echo "build-natives: error: $1" >&2
	exit 1
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname -- "$script_dir")
DEST="$ROOT/packages/natives/native"

args=""
while [ $# -gt 0 ]; do
	case $1 in
	--dest)
		[ $# -ge 2 ] || die "--dest requires an argument"
		DEST=$2
		shift 2
		;;
	--dest=*)
		DEST=${1#*=}
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	-*)
		die "unknown option: $1 (see --help)"
		;;
	*)
		args="$args $1"
		shift
		;;
	esac
done

[ -n "$args" ] || die "no targets given

$(usage)"

# Validate up front so a typo never surfaces after minutes of building.
host_requested=0
target_count=0
for target in $args; do
	if [ "$target" = host ]; then
		host_requested=1
	else
		ok=0
		for known in $SUPPORTED_TARGETS; do
			[ "$target" = "$known" ] && ok=1
		done
		[ "$ok" = 1 ] || die "unknown target '$target'

Supported targets: ${SUPPORTED_TARGETS} host"
	fi
	target_count=$((target_count + 1))
done

if [ "$host_requested" = 1 ]; then
	[ "$target_count" = 1 ] ||
		die "'host' delegates to the local napi-rs build and cannot be combined with other targets"
	echo "[build-natives] building host addon via packages/natives/scripts/build-bindings.ts"
	cd "$ROOT"
	exec bun packages/natives/scripts/build-bindings.ts
fi

mkdir -p -- "$DEST"
# Resolve while the caller's cwd still applies: the build loop cds to the
# repo root, and a relative --dest (e.g. `--dest native` from
# packages/natives) must survive that.
case $DEST in
/*) ;;
*) DEST=$(CDPATH='' cd -- "$DEST" && pwd) ;;
esac

# Vendored static pcre2 for every shipped addon: never the host libpcre2.
PCRE2_SYS_STATIC=1
export PCRE2_SYS_STATIC

# Base RUSTFLAGS from the caller are respected; per-target variant flags are
# appended on top (recomputed from the pristine value each iteration).
base_rustflags=${RUSTFLAGS:-}

require_musl_gcc() {
	command -v musl-gcc >/dev/null 2>&1 && return 0
	die "building $1 on this host requires 'musl-gcc' (the C dependencies -- ring, pcre2, opus -- must compile against musl, not glibc)
  debian/ubuntu: apt-get install musl-tools
  alpine:        apk add gcc musl-dev"
}

build_target() {
	_target=$1
	triple=
	variant_flags=

	case $_target in
	linux-x64-baseline)
		triple=x86_64-unknown-linux-gnu
		variant_flags="-Ctarget-cpu=x86-64-v2"
		;;
	linux-x64-modern)
		triple=x86_64-unknown-linux-gnu
		variant_flags="-Ctarget-cpu=x86-64-v3"
		;;
	linux-arm64)
		triple=aarch64-unknown-linux-gnu
		;;
	linux-musl-x64-baseline)
		triple=x86_64-unknown-linux-musl
		require_musl_gcc "$_target"
		CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_CC=musl-gcc
		export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_CC
		variant_flags="-Ctarget-cpu=x86-64-v2 -Ctarget-feature=-crt-static"
		;;
	linux-musl-arm64)
		triple=aarch64-unknown-linux-musl
		require_musl_gcc "$_target"
		CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_CC=musl-gcc
		export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_CC
		variant_flags="-Ctarget-feature=-crt-static"
		;;
	darwin-x64-baseline)
		triple=x86_64-apple-darwin
		variant_flags="-Ctarget-cpu=x86-64-v2"
		;;
	darwin-arm64)
		triple=aarch64-apple-darwin
		;;
	esac

	# Install the rust target on demand (idempotent; no-op once present).
	if command -v rustup >/dev/null 2>&1; then
		rustup target list --installed 2>/dev/null | grep -qxF -- "$triple" ||
			rustup target add "$triple"
	fi

	RUSTFLAGS=$base_rustflags
	if [ -n "$variant_flags" ]; then
		if [ -n "$RUSTFLAGS" ]; then
			RUSTFLAGS="$RUSTFLAGS $variant_flags"
		else
			RUSTFLAGS=$variant_flags
		fi
	fi
	if [ -n "$RUSTFLAGS" ]; then
		export RUSTFLAGS
	else
		unset RUSTFLAGS
	fi

	echo "[build-natives] building $_target (rust target: $triple${RUSTFLAGS:+, RUSTFLAGS: $RUSTFLAGS})"
	cargo build -p pi-natives --profile ci --target "$triple"

	case $triple in
	*apple-darwin)
		lib_ext=dylib
		;;
	*)
		lib_ext=so
		;;
	esac
	built_lib="$ROOT/target/$triple/ci/libpi_natives.$lib_ext"
	[ -f "$built_lib" ] ||
		die "cargo reported success but $built_lib is missing (did the cdylib actually link?)"

	out_file="$DEST/pi_natives.$_target.node"
	cp -- "$built_lib" "$out_file"
	echo "[build-natives] installed $out_file"
}

cd "$ROOT"
echo "[build-natives] destination: $DEST"
for target in $args; do
	build_target "$target"
done
echo "[build-natives] done"
