# syntax=docker/dockerfile:1
# Preloaded proto-kata runner image.
#
# Stock GitHub Actions runner (Ubuntu 24.04) with the dependencies CI installs
# on every job baked in, so each ephemeral Kata microVM boots with them already
# present instead of re-fetching them per job:
#   - APT system deps (canvas/cairo stack + fd/ripgrep/imagemagick) + fd/magick shims
#   - GitHub CLI (gh) — present on GitHub-hosted runners; the coding-agent github
#     tool and release workflows expect it
#   - C/build toolchain the native + canvas builds need
#   - bun (system-wide, on PATH)
#   - cmake/ninja + musl/aarch64 cross tools for the host-native addon builds
#   - rust nightly (pinned) + clippy/rustfmt/rust-analyzer + linux-arm64 target
#
# Rebuild + reimport (see /root/proto-kata-runner.md) after bumping the ARGs below
# or the apt set. Keep the apt set in sync with .github/actions/setup-system-deps.
FROM ghcr.io/actions/actions-runner:latest

ARG RUST_NIGHTLY=nightly-2026-04-29
ARG BUN_VERSION=1.4.0
ARG CMAKE_VERSION=4.1.2
ARG NINJA_VERSION=1.13.1

USER root
ENV DEBIAN_FRONTEND=noninteractive
# Mirrors the "Install system deps" block in .github/actions/setup-system-deps
# plus the native-build toolchain (aarch64 gnu cross gcc + musl-gcc for the
# addon targets, clang/lld/llvm as a generic C toolchain) and the GitHub CLI.
# The gh apt repo is added first so `gh` installs in the same apt transaction.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y \
      build-essential pkg-config curl ca-certificates git unzip xz-utils zstd gh \
      clang lld llvm \
      gcc-aarch64-linux-gnu musl-tools \
      fd-find ripgrep imagemagick \
 && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
 && ln -sf /usr/bin/convert /usr/local/bin/magick \
 && rm -rf /var/lib/apt/lists/*

# bun, system-wide (BUN_INSTALL/bin == /usr/local/bin, already on PATH).
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && bun --version

# cmake + ninja for native C deps (audiopus_sys builds bundled libopus via
# CMake). Pinned to the same versions as .github/actions/ensure-cmake, which
# no-ops when these are present.
RUN curl -fsSL "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz" -o /tmp/cmake.tar.gz \
 && tar -xzf /tmp/cmake.tar.gz -C /opt \
 && ln -sf "/opt/cmake-${CMAKE_VERSION}-linux-x86_64/bin/cmake" /usr/local/bin/cmake \
 && ln -sf "/opt/cmake-${CMAKE_VERSION}-linux-x86_64/bin/ctest" /usr/local/bin/ctest \
 && rm -f /tmp/cmake.tar.gz
RUN curl -fsSL "https://github.com/ninja-build/ninja/releases/download/v${NINJA_VERSION}/ninja-linux.zip" -o /tmp/ninja.zip \
 && unzip -o /tmp/ninja.zip -d /usr/local/bin \
 && chmod +x /usr/local/bin/ninja \
 && rm -f /tmp/ninja.zip

# Pre-own ~/.cache for the runner user: kubelet otherwise creates it root-owned
# when it materializes parent dirs of subPath mountpoints, breaking sibling
# cache dirs.
RUN install -d -o 1001 -g 1001 -m 0755 /home/runner/.cache

# Cross-linker wiring for the addon targets scripts/build-natives.sh may build
# from this amd64 image: aarch64 gnu links via the Debian cross gcc; musl-gcc
# covers x86_64 musl. NOTE: aarch64-musl has no apt-shippable cross toolchain —
# that leg must run on an arm64 host (ubuntu-24.04-arm), where the script's
# CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_CC=musl-gcc resolves natively.
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_CC=aarch64-linux-gnu-gcc \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_AR=aarch64-linux-gnu-ar

# rust toolchain + cargo helpers for the runner user; rustup default == pinned
# nightly so Rust setup becomes a no-op on the preloaded image.
USER runner
ENV RUSTUP_HOME=/home/runner/.rustup \
    CARGO_HOME=/home/runner/.cargo \
    PATH=/home/runner/.cargo/bin:/usr/local/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain "${RUST_NIGHTLY}" --profile minimal \
 && rustup component add clippy rustfmt rust-analyzer \
 && rustup target add aarch64-unknown-linux-gnu \
 && cargo install --locked cargo-nextest \
 && cargo --version \
 && rustc --version \
 && cargo-nextest --version
