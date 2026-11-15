# syntax=docker/dockerfile:1

# Build the axn-term session host — the .NET WebSocket PTY server that
# replaced the old node session-server (server.mjs).

# Optional sibling ramphastos checkout — see the stage chain below. Must
# be declared before the first FROM to be usable in a FROM expression.
ARG RAMPHASTOS_LOCAL_DEPS=""

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS dotnet-src

WORKDIR /build
COPY --from=axn-term Directory.Build.props ./
COPY --from=axn-term nuget.config ./
COPY --from=axn-term apps/session-host ./apps/session-host

# Optional sibling ramphastos checkout: only with
#   --build-arg RAMPHASTOS_LOCAL_DEPS=1 --build-context libraries=<dir holding the sibling checkouts>
# does the tree land at / (siblings of the build root: /ramphastos),
# where MSBuild swaps the published Ramphastos.* packages for
# ProjectReferences into it (same env-var mechanism as the ramphastos
# repo itself; its own totalserializer/reflectiontools siblings land
# beside it when the context holds them). Default builds restore the
# published NuGet packages — the empty stage keeps the COPY a no-op and
# no `libraries` context is needed.
FROM scratch AS ramphastos-deps
FROM libraries AS ramphastos-deps-local
FROM ramphastos-deps${RAMPHASTOS_LOCAL_DEPS:+-local} AS ramphastos-source

FROM dotnet-src AS sessionhost-builder
ARG RAMPHASTOS_LOCAL_DEPS
ENV RAMPHASTOS_LOCAL_DEPS=$RAMPHASTOS_LOCAL_DEPS
# .git must come along: sibling projects use GitVersion during build.
COPY --from=ramphastos-source --exclude='**/node_modules' . /

RUN dotnet publish apps/session-host/AxnTerm.SessionHost.csproj \
    -c Release \
    -f net10.0 \
    -o /publish

# Demo agent stub: dev-workflow steps launch devin/claude/vibe — real CLIs
# don't exist here, so a tiny self-contained binary stands in. It stays in
# the foreground (ReadLine loop), so the session sees a running process.
COPY demo-agents /build-stub
RUN rid="$(uname -m)"; \
    [ "$rid" = aarch64 ] && rid=linux-arm64 || rid=linux-x64; \
    dotnet publish /build-stub -c Release -r "$rid" -o /stub

# Runtime image: ASP.NET Core session host plus bash.
FROM mcr.microsoft.com/dotnet/aspnet:10.0

WORKDIR /app

# bash for the PTY; ncurses/terminfo + ICU for the session host; git so
# seeded demo repos (and anything the user works on) have repo metadata.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash libncurses6 ncurses-term libicu74 git \
    && rm -rf /var/lib/apt/lists/*

# dockerd + compose inside the session host — lets users run docker
# scenarios inside their session. Safe only under a VM runtime (pair
# with SESSION_HOST_RUNTIME=kata and SESSION_HOST_DIND=1 on the
# gateway); dockerd auto-starts when the container runs as root.
RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io docker-compose-v2 iptables fuse-overlayfs \
    && rm -rf /var/lib/apt/lists/*

# Inner dockerd storage: overlayfs cannot stack on the virtiofs-backed
# container rootfs (kata shares it into the guest), and docker.io 29
# defaults to the containerd snapshotter — disable it and use vfs,
# which needs no special filesystem support.
RUN printf '{"storage-driver":"vfs","features":{"containerd-snapshotter":false}}\n' \
    > /etc/docker/daemon.json

# Nix seed: a complete single-user nix installation parked at /opt/nix-seed.
# The entrypoint copies it into a fresh per-user /nix volume on first boot,
# so no network is needed at spawn time. Only baked into the image when the
# gateway mounts a SESSION_HOST_NIX_VOLUME — a container started without the
# /nix mount simply never sees the seed.
ARG NIX_VERSION=2.28.5
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl xz-utils ca-certificates \
    # The installer insists on sudo to create /nix — pre-create it instead.
    && mkdir -m 0755 /nix \
    && curl -fsSL "https://releases.nixos.org/nix/nix-${NIX_VERSION}/install" \
       | NIX_CONFIG="build-users-group =" sh -s -- --no-daemon --no-modify-profile \
    && mv /nix /opt/nix-seed \
    && ln -sfn /nix/var/nix/profiles/per-user/root/profile \
       /opt/nix-seed/var/nix/profiles/default \
    && rm -f /root/.nix-profile /root/.nix-channels \
    && rm -rf /root/.nix-defexpr /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/axn-term-entrypoint.sh
RUN chmod +x /usr/local/bin/axn-term-entrypoint.sh

# Demo repos seeded into each session user's home on first spawn
# (SEED_DEMO_REPOS=0 disables); see entrypoint.sh.
COPY demo-seed /opt/demo-seed

# Demo agent CLIs for the dev-workflow plugin: one stub binary hardlinked
# to devin/claude/vibe — hardlinks keep each invoked dentry name, so the
# process comm is `devin`/`claude`/`vibe` (a symlink would resolve to
# axn-agent-stub).
COPY --from=sessionhost-builder /stub/axn-agent-stub /usr/local/bin/axn-agent-stub
RUN ln /usr/local/bin/axn-agent-stub /usr/local/bin/devin \
    && ln /usr/local/bin/axn-agent-stub /usr/local/bin/claude \
    && ln /usr/local/bin/axn-agent-stub /usr/local/bin/vibe

COPY --from=sessionhost-builder /publish /app

ENV SESSION_HOST_PORT=7682
ENV TERM=xterm-256color
ENV PTY_CMD=/bin/bash
ENV PTY_CWD=/tmp
ENV HOME=/tmp
ENV AXN_STATE_DIR=/tmp/axn-term

EXPOSE 7682

ENTRYPOINT ["axn-term-entrypoint.sh"]
CMD ["dotnet", "AxnTerm.SessionHost.dll"]
