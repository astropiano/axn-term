using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using AxnTerm.Gateway;
using Microsoft.IdentityModel.Tokens;

namespace AxnTerm.Gateway.Tests;

/// <summary>Denied hellos explain themselves to the account they claim.</summary>
public class RemoteDiagnosticsTests
{
    private static readonly SymmetricSecurityKey Key = new(Encoding.UTF8.GetBytes("diagnostics-test-signing-key-0123456789"));
    private static readonly JwtSecurityTokenHandler Handler = new() { MapInboundClaims = false };

    private static TokenValidationParameters Parameters(params string[] issuers) => new()
    {
        ValidateIssuer = issuers.Length > 0,
        ValidIssuers = issuers,
        ValidateAudience = false,
        ValidateLifetime = true,
        ClockSkew = TimeSpan.Zero,
        IssuerSigningKey = Key,
    };

    private static string Token(string azp = "axn-term", string iss = "https://kc/realms/a",
        DateTime? expires = null, SecurityKey? key = null) =>
        Handler.WriteToken(new JwtSecurityToken(
            issuer: iss,
            claims: [new Claim("sub", "user-1"), new Claim("azp", azp)],
            notBefore: DateTime.UtcNow.AddHours(-2),
            expires: expires ?? DateTime.UtcNow.AddMinutes(5),
            signingCredentials: new SigningCredentials(key ?? Key, SecurityAlgorithms.HmacSha256)));

    [Fact]
    public void ReasonsNameWhatToFix()
    {
        var ok = GatewayAuth.CheckHelloToken(Handler, Token(), Parameters("https://kc/realms/a"), ["axn-term"]);
        Assert.True(ok.Ok);
        Assert.Equal("user-1", ok.Sub);

        Assert.Equal("not signed in (no token)",
            GatewayAuth.CheckHelloToken(Handler, null, Parameters(), ["axn-term"]).Reason);
        Assert.Equal("sign-in expired — sign in again",
            GatewayAuth.CheckHelloToken(Handler, Token(expires: DateTime.UtcNow.AddMinutes(-1)), Parameters(), []).Reason);
        Assert.Equal("signed in at https://old-host/realms/a, which this server does not accept",
            GatewayAuth.CheckHelloToken(Handler, Token(iss: "https://old-host/realms/a"), Parameters("https://kc/realms/a"), []).Reason);
        Assert.Equal("signed in with app 'other', which this server does not accept",
            GatewayAuth.CheckHelloToken(Handler, Token(azp: "other"), Parameters(), ["axn-term"]).Reason);
        Assert.Equal("not a valid token",
            GatewayAuth.CheckHelloToken(Handler, "garbage", Parameters(), []).Reason);
        var foreign = new SymmetricSecurityKey(Encoding.UTF8.GetBytes("some-other-signing-key-0123456789abcdef"));
        Assert.Contains("sign in again",
            GatewayAuth.CheckHelloToken(Handler, Token(key: foreign), Parameters(), []).Reason);
    }

    [Fact]
    public void AttemptsAreKeptPerAccountNewestFirstAndBounded()
    {
        var diagnostics = new RemoteDiagnostics();
        diagnostics.Record("user-1", "Authority", "user-1/host-a", false, "sign-in expired — sign in again");
        diagnostics.Record("user-1", "Authority", "user-1/host-a", true, null);
        diagnostics.Record("user-2", "Controller", "user-2/x", true, null);
        diagnostics.Record(null, "Authority", "x", false, "not signed in (no token)");

        var mine = diagnostics.For("user-1");
        Assert.Equal(2, mine.Count);
        Assert.True(mine[0].Accepted);
        Assert.Equal("sign-in expired — sign in again", mine[1].Reason);
        Assert.Single(diagnostics.For("user-2"));
        Assert.Empty(diagnostics.For("nobody"));

        for (var i = 0; i < 50; i++)
        {
            diagnostics.Record("user-1", "Authority", "s", true, null);
        }
        Assert.Equal(RemoteDiagnostics.PerAccount, diagnostics.For("user-1").Count);
    }

    [Fact]
    public void UnverifiedClaimReadsWithoutValidating()
    {
        var token = Token(iss: "https://anywhere");
        Assert.Equal("user-1", GatewayAuth.UnverifiedClaim(Handler, token, "sub"));
        Assert.Null(GatewayAuth.UnverifiedClaim(Handler, "nope", "sub"));
        Assert.Null(GatewayAuth.UnverifiedClaim(Handler, null, "sub"));
    }
}
