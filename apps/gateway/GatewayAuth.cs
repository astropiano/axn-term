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
    /// Fail closed: a token is only bound to this gateway by its audience or
    /// authorized party. The issuer alone is not enough — every client in the
    /// realm shares it, so a token minted for any other app in the realm would
    /// be accepted.
    /// </summary>
    public static void RequireTokenBinding(IReadOnlyCollection<string> validIssuers, string? audience, string? clientId)
    {
        if (string.IsNullOrWhiteSpace(audience) && string.IsNullOrWhiteSpace(clientId))
        {
            throw new InvalidOperationException(validIssuers.Count == 0
                ? "Authentication:Audience or Authentication:ClientId is required"
                : "Authentication:Audience or Authentication:ClientId is required — Authentication:ValidIssuer(s) alone accepts tokens of every client in the realm");
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
        IReadOnlyCollection<string> clientIds) =>
        CheckHelloToken(handler, token, parameters, clientIds).Sub;

    /// <summary>Outcome of a hello/remote token check: the subject, or why not.</summary>
    public readonly record struct TokenCheck(string? Sub, string? Reason)
    {
        public bool Ok => Sub is not null;
    }

    /// <summary>
    /// Validate a remote-surface token (hub hello, /remote/*) and say why it
    /// failed in words a user can act on — the reason is shown back to the
    /// account's own clients by /remote/status, so a desktop that "just
    /// doesn't show up" explains itself.
    /// </summary>
    public static TokenCheck CheckHelloToken(
        JwtSecurityTokenHandler handler, string? token, TokenValidationParameters parameters,
        IReadOnlyCollection<string> clientIds)
    {
        if (string.IsNullOrEmpty(token))
        {
            return new(null, "not signed in (no token)");
        }
        try
        {
            var principal = handler.ValidateToken(token, parameters, out _);
            var azp = principal.FindFirst("azp")?.Value;
            if (clientIds.Count > 0 && !clientIds.Any(id => IsAuthorizedParty(azp, id)))
            {
                return new(null, $"signed in with app '{azp}', which this server does not accept");
            }
            var sub = principal.FindFirst("sub")?.Value
                ?? principal.FindFirst("preferred_username")?.Value
                ?? principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            return sub is null ? new(null, "token has no subject") : new(sub, null);
        }
        catch (SecurityTokenExpiredException)
        {
            return new(null, "sign-in expired — sign in again");
        }
        catch (SecurityTokenInvalidIssuerException)
        {
            return new(null, $"signed in at {UnverifiedClaim(handler, token, "iss") ?? "another server"}, which this server does not accept");
        }
        catch (SecurityTokenSignatureKeyNotFoundException)
        {
            return new(null, "signature from an unknown login server (Keycloak was reset or replaced) — sign in again");
        }
        catch (SecurityTokenInvalidSignatureException)
        {
            return new(null, "invalid token signature — sign in again");
        }
        catch (SecurityTokenInvalidAudienceException)
        {
            return new(null, "token is for a different audience");
        }
        catch (ArgumentException)
        {
            return new(null, "not a valid token");
        }
        catch (Exception e)
        {
            return new(null, $"token rejected ({e.GetType().Name})");
        }
    }

    /// <summary>A claim read WITHOUT validation — for diagnostics only.</summary>
    public static string? UnverifiedClaim(JwtSecurityTokenHandler handler, string? token, string claim)
    {
        if (string.IsNullOrEmpty(token) || !handler.CanReadToken(token))
        {
            return null;
        }
        try
        {
            return handler.ReadJwtToken(token).Claims.FirstOrDefault(c => c.Type == claim)?.Value;
        }
        catch
        {
            return null;
        }
    }
}
