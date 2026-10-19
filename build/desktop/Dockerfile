# axn-term — Desktop builder image
#
# Contains Node.js, pnpm, Rust and the Tauri Linux system dependencies needed to
# build the Tauri desktop application in a reproducible, isolated container.

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV CARGO_HOME=/cache/cargo
ENV PATH="/cache/cargo/bin:$PATH"

# Tauri Linux prerequisites
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    libssl-dev \
    libgtk-3-dev \
    libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    file \
    rsync \
    xdg-utils \
    libfuse2 \
    zstd \
    && rm -rf /var/lib/apt/lists/*

# Install Rust toolchain (cached outside the image via the compose volume)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path \
    && rustup default stable \
    && rustup target add x86_64-unknown-linux-gnu

# Install pinned pnpm version used by the workspace
RUN npm install -g pnpm@10.5.2

WORKDIR /src
