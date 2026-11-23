using System.Security.Claims;
using System.Text.RegularExpressions;
using AxnTerm.Gateway;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;

namespace AxnTerm.Gateway.Tests;

public class UserIdentityTests
{
    // What the session-host entrypoint accepts as an account name.
    private static readonly Regex LinuxUserName = new("^[a-z_][a-z0-9_-]{0,31}$");

    [Theory]
    [InlineData("alice")]
    [InlineData("bob_smith")]
    [InlineData("dev-1")]
    [InlineData("rooter")]
    [InlineData("a2345678901234567890123456789012")]
    public void CleanNamesStayUnchanged(string name)
    {
        Assert.Equal(name, UserIdentity.ToUserId(name));
    }

    [Theory]
    [InlineData("john.doe", "johndoe")]
    [InlineData("Alice", "alice")]
    [InlineData("-bob", "bob")]
    [InlineData("jürgen", "jrgen")]
    [InlineData("a b", "ab")]
    public void LossyNamesNeverCollideWithTheirSanitizedForm(string lossy, string clean)
    {
        var lossyId = UserIdentity.ToUserId(lossy);

        Assert.Equal(clean, UserIdentity.ToUserId(clean));
        Assert.NotEqual(clean, lossyId);
        Assert.StartsWith(clean + "-", lossyId);
        Assert.Matches("-[0-9a-f]{8}$", lossyId);
    }

    [Fact]
    public void DistinctLossyNamesGetDistinctIds()
    {
        Assert.NotEqual(UserIdentity.ToUserId("john.doe"), UserIdentity.ToUserId("john_doe."));
        Assert.NotEqual(UserIdentity.ToUserId("Jürgen"), UserIdentity.ToUserId("jürgen"));
        Assert.Equal(UserIdentity.ToUserId("john.doe"), UserIdentity.ToUserId("john.doe"));
    }

    [Theory]
    [InlineData("john.doe")]
    [InlineData("Alice")]
    [InlineData("a.very.long.user.name.that.goes.on.and.on@example.com")]
    [InlineData("123.abc")]
    public void ANameEqualToAnotherUsersHashedIdGetsADifferentId(string lossy)
    {
        var victim = UserIdentity.ToUserId(lossy);

        var squatter = UserIdentity.ToUserId(victim);

        Assert.NotEqual(victim, squatter);
        Assert.Matches(LinuxUserName, squatter);
        // Hashing the squatter's name again does not land on either.
        Assert.NotEqual(squatter, UserIdentity.ToUserId(squatter));
    }

    [Theory]
    [InlineData("release-2024")]
    [InlineData("build-1234567")]
    [InlineData("build-123456789")]
    [InlineData("abc-1234567g")]
    [InlineData("abc_30f69670")]
    public void CleanNamesOutsideTheHashedShapeKeepTheirId(string name)
    {
        Assert.Equal(name, UserIdentity.ToUserId(name));
    }

    [Theory]
    // Clean, but not a Linux user name: leading digit, longer than 32.
    [InlineData("2fa-tester")]
    [InlineData("1abc-30f69670")]
    [InlineData("a23456789012345678901234567890123")]
    [InlineData("averyveryveryverylongname1-30f69670")]
    [InlineData("3f2c9a1e-8b7d-4c6e-9f00-1a2b3c4d5e6f")]
    // Clean, but an existing account or group in the session-host image.
    [InlineData("root")]
    [InlineData("daemon")]
    [InlineData("nobody")]
    [InlineData("ubuntu")]
    [InlineData("sudo")]
    [InlineData("docker")]
    public void InvalidOrReservedCleanNamesAreHashed(string name)
    {
        var id = UserIdentity.ToUserId(name);

        Assert.NotEqual(name, id);
        Assert.Matches(LinuxUserName, id);
        Assert.Matches("-[0-9a-f]{8}$", id);
        Assert.Equal(id, UserIdentity.ToUserId(name));
        // Picking the hashed id as a name does not land on it either.
        Assert.NotEqual(id, UserIdentity.ToUserId(id));
    }

    [Theory]
    [InlineData("john.doe")]
    [InlineData("Ünïcødé")]
    [InlineData("...")]
    [InlineData("123.abc")]
    [InlineData("kelvinK")]
    [InlineData("a.very.long.user.name.that.goes.on.and.on@example.com")]
    public void HashedIdsAreAsciiLinuxUserNames(string name)
    {
        var id = UserIdentity.ToUserId(name);

        Assert.Matches(LinuxUserName, id);
        Assert.All(id, c => Assert.True(char.IsAscii(c)));
    }

    [Fact]
    public void ResolvesPreferredUsername()
    {
        var user = Principal(new Claim("preferred_username", "alice"));

        Assert.Equal("alice", UserIdentity.Resolve(user));
    }

    [Fact]
    public void FallsBackToSub()
    {
        const string sub = "3f2c9a1e-8b7d-4c6e-9f00-1a2b3c4d5e6f";
        var user = Principal(new Claim("sub", sub));

        // A UUID sub is 36 chars — too long for a Linux user name, so it
        // goes through the hashing branch.
        var id = UserIdentity.Resolve(user);
        Assert.Equal(UserIdentity.ToUserId(sub), id);
        Assert.Matches(LinuxUserName, id!);
    }

    [Fact]
    public void MissingIdentityClaimsAreRejected()
    {
        Assert.Null(UserIdentity.Resolve(Principal()));
        Assert.Null(UserIdentity.Resolve(Principal(new Claim("preferred_username", "  "))));
    }

    [Fact]
    public void UserQueryParameterIsNeverForwardedOrUsed()
    {
        // The `?user=` fallback is gone: identity comes from claims only, and
        // the query the session host sees carries just cmd/cwd.
        var query = new QueryCollection(new Dictionary<string, StringValues>
        {
            ["user"] = "bob",
            ["access_token"] = "secret-token",
            ["cmd"] = "ls -la",
            ["cwd"] = "/tmp",
        });

        Assert.Null(UserIdentity.Resolve(Principal()));
        var forwarded = WebSocketProxy.ForwardedQuery(query);
        Assert.Equal("?cmd=ls%20-la&cwd=%2Ftmp", forwarded);
        Assert.Equal("", WebSocketProxy.ForwardedQuery(new QueryCollection(new Dictionary<string, StringValues>
        {
            ["access_token"] = "secret-token",
        })));
    }

    private static ClaimsPrincipal Principal(params Claim[] claims) =>
        new(new ClaimsIdentity(claims, "test", "preferred_username", "roles"));
}
