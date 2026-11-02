using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using AxnTerm.Gateway;
using Microsoft.IdentityModel.Tokens;

namespace AxnTerm.Gateway.Tests;

/// <summary>/remote hello tokens get the same azp binding as the HTTP routes.</summary>
public class HelloTokenTests
{
    private static readonly SymmetricSecurityKey Key = new(Encoding.UTF8.GetBytes("hello-token-test-signing-key-0123456789"));
    private static readonly JwtSecurityTokenHandler Handler = new() { MapInboundClaims = false };

    private static readonly TokenValidationParameters Parameters = new()
    {
        ValidateIssuer = false,
        ValidateAudience = false,
        ValidateLifetime = true,
        IssuerSigningKey = Key,
    };

    [Fact]
    public void TokenOfTheConfiguredClientYieldsItsSubject()
    {
        Assert.Equal("user-1", GatewayAuth.ValidateHelloToken(Handler, Token("axn-term"), Parameters, ["axn-term"]));
    }

    [Fact]
    public void TokenOfAnotherClientIsRejected()
    {
        Assert.Null(GatewayAuth.ValidateHelloToken(Handler, Token("other-client"), Parameters, ["axn-term"]));
        Assert.Null(GatewayAuth.ValidateHelloToken(Handler, Token(null), Parameters, ["axn-term"]));
    }

    [Fact]
    public void WithoutAClientIdIssuerAndAudienceCarryTheBinding()
    {
        Assert.Equal("user-1", GatewayAuth.ValidateHelloToken(Handler, Token("other-client"), Parameters, []));
    }

    [Fact]
    public void InvalidOrMissingTokensAreRejected()
    {
        var foreignKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes("some-other-signing-key-0123456789abcdef"));
        Assert.Null(GatewayAuth.ValidateHelloToken(Handler, Token("axn-term", foreignKey), Parameters, ["axn-term"]));
        Assert.Null(GatewayAuth.ValidateHelloToken(Handler, "not-a-jwt", Parameters, ["axn-term"]));
        Assert.Null(GatewayAuth.ValidateHelloToken(Handler, null, Parameters, ["axn-term"]));
    }

    [Fact]
    public void DesktopAndWebClientsCanBothBeAllowed()
    {
        string[] allowed = ["axn-term", "axn-term-desktop"];
        Assert.Equal("user-1", GatewayAuth.ValidateHelloToken(Handler, Token("axn-term-desktop"), Parameters, allowed));
        Assert.Equal("user-1", GatewayAuth.ValidateHelloToken(Handler, Token("axn-term"), Parameters, allowed));
        Assert.Null(GatewayAuth.ValidateHelloToken(Handler, Token("other-client"), Parameters, allowed));
    }

    [Fact]
    public void RemoteClientIdsDefaultToTheGatewayClient()
    {
        Assert.Equal(["axn-term", "axn-term-desktop"], GatewayAuth.RemoteClientIds(null, "axn-term"));
        Assert.Equal(["axn-term-desktop"], GatewayAuth.RemoteClientIds(null, "axn-term-desktop"));
        Assert.Equal(["axn-term", "axn-term-desktop"], GatewayAuth.RemoteClientIds("axn-term, axn-term-desktop", "axn-term"));
        Assert.Empty(GatewayAuth.RemoteClientIds(" ", null));
    }

    private static string Token(string? azp, SecurityKey? key = null)
    {
        var claims = new List<Claim> { new("sub", "user-1"), new("preferred_username", "alice") };
        if (azp is not null)
        {
            claims.Add(new Claim("azp", azp));
        }
        return Handler.WriteToken(new JwtSecurityToken(
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(5),
            signingCredentials: new SigningCredentials(key ?? Key, SecurityAlgorithms.HmacSha256)));
    }
}
