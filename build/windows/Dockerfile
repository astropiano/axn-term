# axn-term — Windows desktop builder image
#
# Cross-compiles the Tauri desktop app for x86_64-pc-windows-msvc on Linux and
# bundles an NSIS installer. cargo-xwin downloads the MSVC CRT and Windows SDK
# headers/libs on first use (cached in the xwin compose volume).
# See https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
# Toolchain lives in the image; the compose volume at /cache/cargo (runtime
# CARGO_HOME) only holds the registry and target dir, so it cannot shadow it.
ENV RUSTUP_HOME=/opt/rustup
ENV PATH="/opt/cargo/bin:$PATH"

# clang-cl/lld-link/llvm-lib/llvm-rc for the MSVC target, NSIS for the installer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    clang \
    lld \
    llvm \
    nsis \
    rsync \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | CARGO_HOME=/opt/cargo sh -s -- -y --no-modify-path --default-toolchain stable \
    && CARGO_HOME=/opt/cargo rustup target add x86_64-pc-windows-msvc \
    && CARGO_HOME=/opt/cargo cargo install --locked cargo-xwin \
    && rm -rf /opt/cargo/registry

RUN npm install -g pnpm@10.5.2

ENV CARGO_HOME=/cache/cargo

WORKDIR /src
