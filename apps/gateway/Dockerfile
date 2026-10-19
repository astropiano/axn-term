# Dockerfile for the axn-term gateway
# Build context: axn-term repo root

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build

WORKDIR /src

COPY Directory.Build.props ./
COPY nuget.config ./
COPY apps/gateway/*.csproj ./apps/gateway/

# Sibling repos under a `libraries` build context (sibling checkouts
# locally): ramphastos sources for the ProjectReference, plus its package
# feeds — the nuget.config paths (../<repo>) resolve to /<repo> here.
# NuGet finds configs by walking up from each project's directory, so the
# feed config sits beside the referenced projects too.
COPY --from=libraries ramphastos/Directory.Packages.props /ramphastos/Directory.Packages.props
COPY nuget.config /ramphastos/nuget.config
COPY --from=libraries ramphastos/src /ramphastos/src
COPY --from=libraries reflectiontools/src/packages /reflectiontools/src/packages
COPY --from=libraries totalserializer/src/packages-local /totalserializer/src/packages-local

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
COPY --from=build /app/publish .

EXPOSE 8080

ENV DOTNET_ENTRYPOINT="Astropiano.AxnTerm.Gateway.dll"
ENTRYPOINT ["/bin/sh", "-c", "exec dotnet $DOTNET_ENTRYPOINT"]
