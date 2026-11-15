namespace AxnTerm.Gateway;

/// <summary>
/// The <c>/.well-known/axn-term</c> document: everything a client needs to
/// talk to this server, so desktop, web and mobile clients only ever need
/// the server address. Clients pick the first endpoint that answers — a
/// server can be reachable on several networks at once (LAN, tailnet,
/// public), each with its own gateway and issuer host.
/// </summary>
public static class ServerDiscovery
{
    public const string Path = "/.well-known/axn-term";

    public sealed record Endpoint(string Label, string Gateway, string Issuer, string? Web);

    public sealed record Clients(string? Web, string? Desktop, string? Mobile);

    public sealed record Features(bool Remote, bool Cloud);

    public sealed record Document(
        string Service,
        int Version,
        string Id,
        string Name,
        IReadOnlyList<Endpoint> Endpoints,
        Clients Clients,
        Features Features);

    /// <summary>
    /// Builds the document from configuration. <c>Discovery:Endpoints:N</c>
    /// (<c>Label</c>, <c>Gateway</c>, <c>Issuer</c>, optional <c>Web</c>)
    /// lists the networks this server is reachable on; without any, one
    /// endpoint is derived from the request's own origin and the first
    /// configured issuer.
    /// </summary>
    public static Document Build(IConfiguration config, string serverId, string requestOrigin)
    {
        var endpoints = config.GetSection("Discovery:Endpoints").GetChildren()
            .Select(s => new Endpoint(
                Label: NonEmpty(s["Label"]) ?? s.Key,
                // ws(s):// accepted too — deployments already carry the
                // socket URL; clients always get the http(s) form.
                Gateway: HttpScheme(TrimSlash(s["Gateway"])),
                Issuer: TrimSlash(s["Issuer"]),
                Web: NonEmpty(s["Web"]) is { } web ? TrimSlash(web) : null))
            // Unset env leaves half-built URLs like "https://:18094" —
            // skip anything that isn't an absolute URL with a host.
            .Where(e => IsAbsolute(e.Gateway) && IsAbsolute(e.Issuer))
            .ToList();

        if (endpoints.Count == 0)
        {
            var issuer = GatewayAuth.ParseValidIssuers(
                    config["Authentication:ValidIssuer"], config["Authentication:ValidIssuers"])
                .FirstOrDefault() ?? config["Authentication:Authority"] ?? "";
            if (issuer.Length > 0)
            {
                endpoints.Add(new Endpoint("default", TrimSlash(requestOrigin), TrimSlash(issuer), null));
            }
        }

        return new Document(
            Service: "axn-term",
            Version: 1,
            Id: serverId,
            Name: NonEmpty(config["Discovery:Name"]) ?? "axn-term",
            Endpoints: endpoints,
            Clients: new Clients(
                Web: NonEmpty(config["Discovery:Clients:Web"]) ?? NonEmpty(config["Authentication:ClientId"]),
                Desktop: NonEmpty(config["Discovery:Clients:Desktop"]),
                Mobile: NonEmpty(config["Discovery:Clients:Mobile"])),
            Features: new Features(
                Remote: config.GetValue("Hub:RemoteEnabled", true),
                Cloud: config.GetValue("Hub:CloudEnabled", true)));
    }

    /// <summary>
    /// The server's stable identity — the same on every endpoint, so a client
    /// that reached it over the LAN and later over the tailnet knows it is one
    /// server (one account, one set of desktops). <c>Discovery:ServerId</c>
    /// wins; otherwise a random id is minted once into the state dir.
    /// </summary>
    public static string ResolveServerId(IConfiguration config, string stateDir)
    {
        if (NonEmpty(config["Discovery:ServerId"]) is { } configured)
        {
            return configured;
        }

        var file = System.IO.Path.Combine(stateDir, "server-id");
        try
        {
            if (File.Exists(file) && NonEmpty(File.ReadAllText(file)) is { } existing)
            {
                return existing;
            }

            Directory.CreateDirectory(stateDir);
            var minted = Guid.NewGuid().ToString("N");
            File.WriteAllText(file, minted);
            return minted;
        }
        catch (IOException)
        {
            // Read-only state dir: still serve a document, but the id will
            // change on restart — clients then treat it as a new server.
            return Guid.NewGuid().ToString("N");
        }
        catch (UnauthorizedAccessException)
        {
            return Guid.NewGuid().ToString("N");
        }
    }

    /// <summary>
    /// The base URL the caller used. Behind a TLS-terminating proxy the
    /// request arrives as plain http, so X-Forwarded-Proto/Host/Prefix win.
    /// </summary>
    public static string RequestOrigin(HttpRequest request)
    {
        var proto = FirstValue(request.Headers["X-Forwarded-Proto"]) ?? request.Scheme;
        var host = FirstValue(request.Headers["X-Forwarded-Host"]) ?? request.Host.Value;
        // Served under a path (single-origin proxies route /gw/* here).
        var prefix = (FirstValue(request.Headers["X-Forwarded-Prefix"]) ?? "").TrimEnd('/');
        if (prefix.Length > 0 && !prefix.StartsWith('/'))
        {
            prefix = "/" + prefix;
        }
        return $"{proto}://{host}{prefix}";
    }

    private static string? FirstValue(string? header) =>
        NonEmpty(header?.Split(',')[0].Trim());

    private static string? NonEmpty(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string TrimSlash(string? value) => (value ?? "").Trim().TrimEnd('/');

    private static bool IsAbsolute(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Host.Length > 0;

    private static string HttpScheme(string url) =>
        url.StartsWith("ws", StringComparison.OrdinalIgnoreCase) ? "http" + url[2..] : url;
}
