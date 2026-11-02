using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.IdentityModel.Tokens;

namespace AxnTerm.Gateway;

/// <summary>Pure helpers behind the gateway's JWT validation setup.</summary>
public static class GatewayAuth
{
    public static List<string> ParseValidIssuers(string? single, string? multiple)
    {
        var result = new List<string>();
        if (!string.IsNullOrWhiteSpace(single))
        {
            result.Add(single!);
        }

        if (!string.IsNullOrWhiteSpace(multiple))
        {
            foreach (var item in multiple!.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (!string.IsNullOrWhiteSpace(item))
                {
                    result.Add(item);
                }
            }
        }

        return result;
    }

    /// <summary>
    /// Fail closed: a token is only bound to this deployment by its issuer,
    /// audience or authorized party — without any of them every token the
    /// JWKS signs (any realm client) would be accepted.
    /// </summary>
    public static void RequireTokenBinding(IReadOnlyCollection<string> validIssuers, string? audience, string? clientId)
    {
        if (validIssuers.Count == 0 && string.IsNullOrWhiteSpace(audience) && string.IsNullOrWhiteSpace(clientId))
        {
            throw new InvalidOperationException(
                "Authentication:ValidIssuer(s), Authentication:Audience or Authentication:ClientId is required");
        }
    }

    /// <summary>
    /// Keycloak public-client access tokens carry aud=account, so the client
    /// binding is checked on `azp` (authorized party) instead: with a
    /// configured client id the token must have been issued to that client.
    /// </summary>
    public static bool IsAuthorizedParty(string? azp, string? clientId) =>
        string.IsNullOrWhiteSpace(clientId) || string.Equals(azp, clientId, StringComparison.Ordinal);

    /// <summary>
    /// Clients whose tokens may say hello on /remote: the desktop signs in
    /// with its own client (device flow), the web viewer with the web one, so
    /// RemoteAuthority:ClientIds lists them. Unset, Authentication:ClientId
    /// plus the desktop's built-in client (<see cref="DesktopClientId"/>) are
    /// accepted, so existing deployments keep accepting desktop hellos.
    /// </summary>
    public static List<string> RemoteClientIds(string? configured, string? clientId)
    {
        var ids = ParseValidIssuers(null, configured);
        if (ids.Count == 0 && !string.IsNullOrWhiteSpace(clientId))
        {
            ids.Add(clientId!);
            if (clientId != DesktopClientId)
            {
                ids.Add(DesktopClientId);
            }
        }
        return ids;
    }

    /// <summary>Default OIDC client of the desktop app (apps/desktop remoteAuth.ts).</summary>
    public const string DesktopClientId = "axn-term-desktop";

    /// <summary>
    /// Validate a /remote hello token like the HTTP routes do — signature,
    /// lifetime, issuer/audience from <paramref name="parameters"/>, plus the
    /// azp check against <paramref name="clientIds"/> (empty = no client
    /// binding) — and return its stable subject (sub, falling back to
    /// preferred_username / nameidentifier), or null when it is invalid.
    /// The handler must keep claim names verbatim (MapInboundClaims = false).
    /// </summary>
    public static string? ValidateHelloToken(
        JwtSecurityTokenHandler handler, string? token, TokenValidationParameters parameters,
        IReadOnlyCollection<string> clientIds)
    {
        if (string.IsNullOrEmpty(token))
        {
            return null;
        }
        try
        {
            var principal = handler.ValidateToken(token, parameters, out _);
            var azp = principal.FindFirst("azp")?.Value;
            if (clientIds.Count > 0 && !clientIds.Any(id => IsAuthorizedParty(azp, id)))
            {
                return null;
            }
            return principal.FindFirst("sub")?.Value
                ?? principal.FindFirst("preferred_username")?.Value
                ?? principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        }
        catch
        {
            return null;
        }
    }
}
