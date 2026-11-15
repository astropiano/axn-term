# syntax=docker/dockerfile:1

# Dockerfile for the axn-term gateway
# Build context: axn-term repo root

# Optional sibling ramphastos checkout — see the stage chain below. Must
# be declared before the first FROM to be usable in a FROM expression.
ARG RAMPHASTOS_LOCAL_DEPS=""

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build

WORKDIR /src

COPY Directory.Build.props ./
COPY nuget.config ./
COPY apps/gateway/*.csproj ./apps/gateway/

# Optional sibling ramphastos checkout: only with
#   --build-arg RAMPHASTOS_LOCAL_DEPS=1 --build-context libraries=<dir holding the sibling checkouts>
# does the tree land at / (siblings of the build root: /ramphastos),
# where MSBuild swaps the published Ramphastos.* packages for
# ProjectReferences into it (same env-var mechanism as the ramphastos
# repo itself). Default builds restore the published NuGet packages —
# the empty stage keeps the COPY a no-op and no `libraries` context is
# needed.
FROM scratch AS ramphastos-deps
FROM libraries AS ramphastos-deps-local
FROM ramphastos-deps${RAMPHASTOS_LOCAL_DEPS:+-local} AS ramphastos-source

FROM build AS app
ARG RAMPHASTOS_LOCAL_DEPS
ENV RAMPHASTOS_LOCAL_DEPS=$RAMPHASTOS_LOCAL_DEPS
# .git must come along: sibling projects use GitVersion during build.
COPY --from=ramphastos-source --exclude='**/node_modules' . /

RUN dotnet restore ./apps/gateway/AxnTerm.Gateway.csproj -p:TargetFramework=net10.0

COPY apps/gateway/. ./apps/gateway/
RUN dotnet publish ./apps/gateway/AxnTerm.Gateway.csproj \
    -c Release \
    -f net10.0 \
    -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime

# Install curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=app /app/publish .

EXPOSE 8080

ENV DOTNET_ENTRYPOINT="AxnTerm.Gateway.dll"
ENTRYPOINT ["/bin/sh", "-c", "exec dotnet $DOTNET_ENTRYPOINT"]
