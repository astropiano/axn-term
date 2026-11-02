using AxnTerm.Gateway;

namespace AxnTerm.Gateway.Tests;

public class GatewayConfigTests
{
    [Fact]
    public void AuthorizedPartyMustMatchTheConfiguredClient()
    {
        Assert.True(GatewayAuth.IsAuthorizedParty("axn-term", "axn-term"));
        Assert.False(GatewayAuth.IsAuthorizedParty("other-client", "axn-term"));
        Assert.False(GatewayAuth.IsAuthorizedParty(null, "axn-term"));
        // No client id configured: issuer/audience validation carries it.
        Assert.True(GatewayAuth.IsAuthorizedParty("other-client", null));
    }

    [Fact]
    public void TokenValidationWithoutAnyBindingRefusesToStart()
    {
        Assert.Throws<InvalidOperationException>(() => GatewayAuth.RequireTokenBinding([], null, " "));
        GatewayAuth.RequireTokenBinding(["http://issuer"], null, null);
        GatewayAuth.RequireTokenBinding([], "aud", null);
        GatewayAuth.RequireTokenBinding([], null, "axn-term");
    }

    [Fact]
    public void ParsesSingleAndListedIssuers()
    {
        Assert.Equal(["a", "b", "c"], GatewayAuth.ParseValidIssuers("a", "b, c,,"));
        Assert.Empty(GatewayAuth.ParseValidIssuers(null, " "));
    }

    [Fact]
    public void GeneratedSecretsAreRandomBase64Url()
    {
        var first = SessionHostSecret.Generate();
        var second = SessionHostSecret.Generate();

        Assert.Equal(43, first.Length); // 32 bytes, unpadded
        Assert.Matches("^[A-Za-z0-9_-]+$", first);
        Assert.NotEqual(first, second);
    }

    [Fact]
    public void ReadsTheSecretBackFromContainerEnv()
    {
        Assert.Equal("s3cr=t", SessionHostSecret.FromEnv(["PATH=/bin", "AXN_SESSION_HOST_SECRET=s3cr=t"]));
        Assert.Null(SessionHostSecret.FromEnv(["PATH=/bin"]));
        Assert.Null(SessionHostSecret.FromEnv(["AXN_SESSION_HOST_SECRET="]));
        Assert.Null(SessionHostSecret.FromEnv(null));
    }

    [Theory]
    [InlineData(null, 4L << 30)]
    [InlineData("4g", 4L << 30)]
    [InlineData("512m", 512L << 20)]
    [InlineData("1.5G", 3L << 29)]
    [InlineData("2048kb", 2L << 20)]
    [InlineData("1000000", 1000000L)]
    [InlineData("0", 0L)]
    public void ParsesMemoryLimits(string? value, long expected)
    {
        Assert.Equal(expected, SessionHostResources.ParseMemory(value));
    }

    [Fact]
    public void ParsesPidAndCpuLimits()
    {
        Assert.Equal(4096L, SessionHostResources.ParsePids(null));
        Assert.Equal(100L, SessionHostResources.ParsePids("100"));
        Assert.Null(SessionHostResources.ParsePids("0"));
        Assert.Equal(2_000_000_000L, SessionHostResources.ParseNanoCpus(null));
        Assert.Equal(1_500_000_000L, SessionHostResources.ParseNanoCpus("1.5"));
        Assert.Throws<InvalidOperationException>(() => SessionHostResources.ParseMemory("lots"));
        Assert.Throws<InvalidOperationException>(() => SessionHostResources.ParsePids("-1"));
    }

    [Fact]
    public void DindAndPrivilegedNeedKataOrAnExplicitOverride()
    {
        Assert.Null(SessionHostResources.ValidateIsolation(false, false, null, false));
        Assert.Null(SessionHostResources.ValidateIsolation(true, false, "kata", false));
        Assert.Null(SessionHostResources.ValidateIsolation(false, true, "io.containerd.kata.v2", false));
        Assert.Throws<InvalidOperationException>(() => SessionHostResources.ValidateIsolation(true, false, null, false));
        Assert.Throws<InvalidOperationException>(() => SessionHostResources.ValidateIsolation(false, true, "runc", false));
        Assert.NotNull(SessionHostResources.ValidateIsolation(true, true, null, true));
    }
}
