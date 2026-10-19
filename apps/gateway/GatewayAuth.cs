namespace Astropiano.AxnTerm.Gateway;

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
}
