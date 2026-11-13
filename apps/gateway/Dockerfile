# Dockerfile for the axn-term gateway
# Build context: axn-term repo root

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build

WORKDIR /src

COPY Directory.Build.props ./
COPY nuget.config ./
COPY apps/gateway/*.csproj ./apps/gateway/

# Sibling checkout of ramphastos (the `libraries` build context is the
# directory holding axn-term and its siblings). The ProjectReference
# ../../../ramphastos resolves to /ramphastos from the build root.
# Central package versions live at the ramphastos repo root.
COPY --from=libraries ramphastos/Directory.Packages.props /ramphastos/Directory.Packages.props
COPY --from=libraries ramphastos/nuget.config /ramphastos/nuget.config
COPY --from=libraries ramphastos/src /ramphastos/src

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

ENV DOTNET_ENTRYPOINT="AxnTerm.Gateway.dll"
ENTRYPOINT ["/bin/sh", "-c", "exec dotnet $DOTNET_ENTRYPOINT"]
