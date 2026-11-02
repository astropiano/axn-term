using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace AxnTerm.Gateway;

/// <summary>
/// Fetches a JWKS endpoint directly and exposes the signing keys through an
/// <see cref="OpenIdConnectConfiguration"/> instance. This is useful when the
/// OIDC discovery document advertises a public hostname (e.g. keycloak.localhost)
/// that is not resolvable inside the gateway container, but an internal JWKS URL
/// (e.g. keycloak:8082) is available.
/// </summary>
public sealed class JwkConfigurationRetriever : IConfigurationRetriever<OpenIdConnectConfiguration>
{
    public async Task<OpenIdConnectConfiguration> GetConfigurationAsync(
        string address,
        IDocumentRetriever retriever,
        CancellationToken cancel)
    {
        var json = await retriever.GetDocumentAsync(address, cancel);
        var jwks = new JsonWebKeySet(json);
        var config = new OpenIdConnectConfiguration();
        foreach (var key in jwks.GetSigningKeys())
        {
            config.SigningKeys.Add(key);
        }

        return config;
    }
}
