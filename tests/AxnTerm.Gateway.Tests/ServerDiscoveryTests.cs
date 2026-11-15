using AxnTerm.Gateway;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace AxnTerm.Gateway.Tests;

public class ServerDiscoveryTests
{
    private static IConfiguration Config(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    [Fact]
    public void ListsConfiguredEndpointsInOrder()
    {
        var doc = ServerDiscovery.Build(Config(new()
        {
            ["Discovery:Name"] = "home",
            ["Discovery:Endpoints:0:Label"] = "lan",
            ["Discovery:Endpoints:0:Gateway"] = "https://fedora.local:18094/",
            ["Discovery:Endpoints:0:Issuer"] = "https://fedora.local:18093/realms/axn-term",
            ["Discovery:Endpoints:1:Label"] = "tailnet",
            ["Discovery:Endpoints:1:Gateway"] = "wss://fedora.tail1234.ts.net:8443",
            ["Discovery:Endpoints:1:Issuer"] = "https://fedora.tail1234.ts.net/realms/axn-term",
            ["Discovery:Endpoints:1:Web"] = "https://fedora.tail1234.ts.net:10000/",
            // Incomplete entries are skipped, not served half-built.
            ["Discovery:Endpoints:2:Gateway"] = "https://broken",
            // Unset host env → no host: skipped too.
            ["Discovery:Endpoints:3:Gateway"] = "https://:18094",
            ["Discovery:Endpoints:3:Issuer"] = "https://:18093/realms/axn-term",
            ["Discovery:Clients:Desktop"] = "axn-term-desktop",
            ["Discovery:Clients:Mobile"] = "axn-term-mobile",
            ["Authentication:ClientId"] = "axn-term",
            ["Hub:CloudEnabled"] = "false",
        }), "srv-1", "http://ignored");

        Assert.Equal("axn-term", doc.Service);
        Assert.Equal(1, doc.Version);
        Assert.Equal("srv-1", doc.Id);
        Assert.Equal("home", doc.Name);
        Assert.Equal(
            [
                new ServerDiscovery.Endpoint("lan", "https://fedora.local:18094",
                    "https://fedora.local:18093/realms/axn-term", null),
                new ServerDiscovery.Endpoint("tailnet", "https://fedora.tail1234.ts.net:8443",
                    "https://fedora.tail1234.ts.net/realms/axn-term", "https://fedora.tail1234.ts.net:10000"),
            ],
            doc.Endpoints);
        Assert.Equal(new ServerDiscovery.Clients("axn-term", "axn-term-desktop", "axn-term-mobile"), doc.Clients);
        Assert.Equal(new ServerDiscovery.Features(Remote: true, Cloud: false), doc.Features);
    }

    [Fact]
    public void WithoutEndpointsFallsBackToTheRequestOriginAndFirstIssuer()
    {
        var doc = ServerDiscovery.Build(Config(new()
        {
            ["Authentication:Authority"] = "http://keycloak:8082/realms/axn-term",
            ["Authentication:ValidIssuer"] = "https://kc.example.com/realms/axn-term",
            ["Authentication:ValidIssuers"] = "http://localhost:18096/realms/axn-term",
        }), "srv-1", "https://gw.example.com/");

        var endpoint = Assert.Single(doc.Endpoints);
        Assert.Equal(new ServerDiscovery.Endpoint("default", "https://gw.example.com",
            "https://kc.example.com/realms/axn-term", null), endpoint);
        Assert.Null(doc.Clients.Web);
    }

    [Fact]
    public void RequestOriginHonoursForwardedHeaders()
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "http";
        context.Request.Host = new HostString("gateway:8080");
        Assert.Equal("http://gateway:8080", ServerDiscovery.RequestOrigin(context.Request));

        context.Request.Headers["X-Forwarded-Proto"] = "https, http";
        context.Request.Headers["X-Forwarded-Host"] = "fedora.local:18094";
        Assert.Equal("https://fedora.local:18094", ServerDiscovery.RequestOrigin(context.Request));

        context.Request.Headers["X-Forwarded-Prefix"] = "/gw/";
        Assert.Equal("https://fedora.local:18094/gw", ServerDiscovery.RequestOrigin(context.Request));
    }

    [Fact]
    public void ServerIdIsMintedOnceAndConfigWins()
    {
        var dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "axn-sid-" + Guid.NewGuid().ToString("N"));
        try
        {
            var empty = Config(new());
            var first = ServerDiscovery.ResolveServerId(empty, dir);
            Assert.Matches("^[0-9a-f]{32}$", first);
            Assert.Equal(first, ServerDiscovery.ResolveServerId(empty, dir));
            Assert.Equal("fixed", ServerDiscovery.ResolveServerId(
                Config(new() { ["Discovery:ServerId"] = "fixed" }), dir));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }
}
