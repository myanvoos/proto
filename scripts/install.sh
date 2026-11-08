
set -e

# PROTO Coding Agent Installer
# Usage: gh api repos/myanvoos/proto/contents/scripts/install.sh -H 'Accept: application/vnd.github.raw' | sh
#
# Options:
#   --binary       Install the prebuilt release binary (default)
#   --source       Build from a clone of the repo (installs bun if needed)
#   --ref <ref>    Release tag for --binary, or branch/tag/commit for --source (default: main)
#   -r <ref>       Shorthand for --ref

REPO="myanvoos/proto"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.4.0"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# Bun's own architecture (x64|arm64), or empty when it can't be determined.
bun_arch() {
    bun -e 'process.stdout.write(process.arch)' 2>/dev/null
}

# True when Bun's architecture matches the host. If Bun's arch can't be read,
# assume a match rather than block the install.
bun_arch_matches_host() {
    ba="$(bun_arch)"
    [ -z "$ba" ] && return 0
    [ "$ba" = "$(host_arch)" ]
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install from a clone of the repository
install_from_source() {
    SOURCE_REF="${REF:-main}"
    echo "Installing from source (${REPO}@${SOURCE_REF})..."
    if ! has_git; then
        echo "git is required to install from source"
        exit 1
    fi

    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    if git clone --depth 1 --branch "$SOURCE_REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
        :
    else
        git clone "https://github.com/${REPO}.git" "$TMP_DIR"
        (cd "$TMP_DIR" && git checkout "$SOURCE_REF")
    fi

    # Pull LFS files
    if has_git_lfs; then
        (cd "$TMP_DIR" && git lfs pull)
    fi

    if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
        echo "Expected package at ${TMP_DIR}/packages/coding-agent"
        exit 1
    fi

    bun install -g "$TMP_DIR/packages/coding-agent" || {
        echo "Failed to install from source"
        exit 1
    }
    echo ""
    echo "✓ Installed proto from source"
    echo "Run 'proto' to get started!"
}

# Install the protofs sidecar beside proto. Older releases do not publish it, so
# a missing or unusable sidecar warns instead of failing the proto install.
install_protofs() {
    PROTOFS_BINARY="protofs-${PLATFORM}-${ARCH}"
    PROTOFS_URL="https://github.com/${REPO}/releases/download/${LATEST}/${PROTOFS_BINARY}"
    echo "Downloading ${PROTOFS_BINARY}..."
    if [ "$AUTH_DOWNLOAD" = true ]; then
        if ! gh release download "$LATEST" --repo "$REPO" --pattern "$PROTOFS_BINARY" --output "${INSTALL_DIR}/protofs" --clobber; then
            echo "  protofs sidecar not available in this release; proto will use a PATH protofs if present."
            rm -f "${INSTALL_DIR}/protofs"
            return
        fi
    else
        if ! curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$PROTOFS_URL" -o "${INSTALL_DIR}/protofs"; then
            echo "  protofs sidecar not available in this release; proto will use a PATH protofs if present."
            rm -f "${INSTALL_DIR}/protofs"
            return
        fi
    fi
    chmod +x "${INSTALL_DIR}/protofs"
    if ! "${INSTALL_DIR}/protofs" version >/dev/null 2>&1; then
        echo "  protofs was downloaded but cannot start; proto will use a PATH protofs if present."
        rm -f "${INSTALL_DIR}/protofs"
        return
    fi
    echo "✓ Installed protofs to ${INSTALL_DIR}/protofs"
}

# Install binary from GitHub releases
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) ;;
        *)         echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    BINARY="proto-${PLATFORM}-${ARCH}"
    # Public releases need only curl. Private releases use gh's existing
    # authentication for both metadata and the asset; never put tokens in URLs.
    RELEASE_API="repos/${REPO}/releases/latest"
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        RELEASE_API="repos/${REPO}/releases/tags/${REF}"
    else
        echo "Fetching latest release..."
    fi
    AUTH_DOWNLOAD=false
    if RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/${RELEASE_API}" 2>/dev/null); then
        :
    elif command -v gh >/dev/null 2>&1 && RELEASE_JSON=$(gh api "$RELEASE_API" 2>/dev/null); then
        AUTH_DOWNLOAD=true
    else
        echo "No accessible published release found for ${REPO}${REF:+ at $REF}."
        echo "For a private repository, run 'gh auth login' with an account that has repository access."
        echo "For branch/commit installs, use --source with --ref."
        exit 1
    fi
    LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    if [ -z "$LATEST" ]; then
        echo "GitHub returned release metadata without a tag for ${REPO}."
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    # Download binary
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    if [ "$AUTH_DOWNLOAD" = true ]; then
        gh release download "$LATEST" --repo "$REPO" --pattern "$BINARY" --output "${INSTALL_DIR}/proto" --clobber
    else
        curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "${INSTALL_DIR}/proto"
    fi
    chmod +x "${INSTALL_DIR}/proto"

    # Verify the freshly installed binary can actually start before reporting
    # success. Bun's musl-target binaries link libstdc++/libgcc dynamically,
    # which stock Alpine/musl systems do not ship, so the download succeeds while
    # the binary exits 127 with relocation errors. Never claim success for a
    # binary that cannot run.
    if ! SMOKE_OUTPUT="$("${INSTALL_DIR}/proto" --version 2>&1)"; then
        echo ""
        echo "✗ proto was downloaded to ${INSTALL_DIR}/proto but cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run 'proto':"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        exit 1
    fi

    install_protofs

    echo ""
    echo "✓ Installed proto to ${INSTALL_DIR}/proto"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'proto' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'proto'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        if ! bun_arch_matches_host; then
            echo "Error: bun reports architecture '$(bun_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this bun would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native bun for your architecture, or re-run without --source to fetch the prebuilt $(host_arch) binary."
            exit 1
        fi
        install_from_source
        ;;
    *)
        # Default: the prebuilt release binary.
        install_binary
        ;;
esac
