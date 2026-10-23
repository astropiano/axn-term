using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using System.Net.WebSockets;
using System.Security.Claims;
using Astropiano.AxnTerm.Gateway;
using Ramphastos.Core;
using Ramphastos.Server;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using System.Text.Json;
using System.Text.Json.Nodes;

var builder = WebApplication.CreateBuilder(args);

// Hosting logs every request line at Information — including WebSocket
// URLs carrying `?access_token=`. Keep framework logs to warnings.
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);

// JWT setup is hoisted into locals so the /remote hub's hello-level auth
// can validate viewer/controller tokens against the same JWKS.
var authAuthority = builder.Configuration["Authentication:Authority"];
if (string.IsNullOrWhiteSpace(authAuthority))
{
    throw new InvalidOperationException("Authentication:Authority is required");
}

var jwksUri = builder.Configuration["Authentication:JwksUri"];
if (string.IsNullOrWhiteSpace(jwksUri))
{
    jwksUri = $"{authAuthority.TrimEnd('/')}/protocol/openid-connect/certs";
}

var audience = builder.Configuration["Authentication:Audience"];
var clientId = builder.Configuration["Authentication:ClientId"];
var validIssuers = GatewayAuth.ParseValidIssuers(builder.Configuration["Authentication:ValidIssuer"], builder.Configuration["Authentication:ValidIssuers"]);
GatewayAuth.RequireTokenBinding(validIssuers, audience, clientId);

var hasAudience = !string.IsNullOrWhiteSpace(audience);
var hasIssuers = validIssuers.Count > 0;

var tokenValidationParameters = new TokenValidationParameters
{
    ValidateIssuer = hasIssuers,
    ValidateAudience = hasAudience,
    ValidateLifetime = true,
    NameClaimType = "preferred_username",
    RoleClaimType = "roles",
};

if (hasIssuers)
{
    tokenValidationParameters.ValidIssuers = validIssuers;
}

// Fetch the JWKS directly from the internal Keycloak URL. We cannot rely on
// the discovery document's jwks_uri because Keycloak advertises the public
// hostname (keycloak.localhost), which is not resolvable inside the gateway
// container, while keycloak:8082 is.
var jwksConfig = new ConfigurationManager<OpenIdConnectConfiguration>(
    jwksUri,
    new JwkConfigurationRetriever(),
    new HttpDocumentRetriever { RequireHttps = false });

builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(JwtBearerDefaults.AuthenticationScheme, options =>
{
    options.Authority = authAuthority;
    options.Audience = hasAudience ? audience : null;
    options.RequireHttpsMetadata = false;
    options.TokenValidationParameters = tokenValidationParameters;
    options.ConfigurationManager = jwksConfig;

    // WebSocket clients cannot send custom headers from JavaScript, so we also
    // accept the access token as an 'access_token' query string parameter.
    options.Events = new JwtBearerEvents
    {
        OnMessageReceived = context =>
        {
            var accessToken = context.Request.Query["access_token"].FirstOrDefault();
            if (string.IsNullOrEmpty(accessToken))
            {
                var header = context.Request.Headers.Authorization.FirstOrDefault();
                if (header?.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) == true)
                {
                    accessToken = header["Bearer ".Length..];
                }
            }

            if (!string.IsNullOrEmpty(accessToken))
            {
                context.Token = accessToken;
            }

            return Task.CompletedTask;
        },
        // Tokens of other clients in the realm must not open shells here.
        OnTokenValidated = context =>
        {
            var azp = context.SecurityToken is JsonWebToken jwt && jwt.TryGetPayloadValue<string>("azp", out var value)
                ? value
                : context.Principal?.FindFirst("azp")?.Value;
            if (!GatewayAuth.IsAuthorizedParty(azp, clientId))
            {
                context.Fail("token was not issued to this client (azp)");
            }

            return Task.CompletedTask;
        },
    };
});

builder.Services.AddAuthorization();
builder.Services.AddSingleton<SessionHostContainerService>();
builder.Services.AddSingleton(sp => new UserCapabilities(
    builder.Configuration["AXN_STATE_DIR"] ?? "/tmp/axn-term"));

// Ramphastos hub for client-authoritative sessions (/remote): a desktop
// axn-term connects outbound with role "authority" and owns the model —
// the hub mirrors its snapshots/patches, forwards invokes and tunnels
// pty:<id> streams to remote viewers. Server-authoritative sessions are
// not created here (the VM factory is a bare placeholder; remote clients
// always attach to an existing mirrored session by id).
//
// Auth is identity-scoped on the hello envelope (the transport itself is
// unauthenticated — hellos carry a user JWT in `auth`, validated against
// the same JWKS as the HTTP routes). A mirrored session belongs to the
// account that published it:
//   - authority hellos must pin a session id; the first JWT sub to
//     publish it becomes the owner (recorded in memory — authorities
//     re-stamp on reconnect). A different sub publishing the same id is
//     denied: the id is claimed, not a shared secret.
//   - viewer/controller hellos attach only when their sub matches the
//     session's owner — same Keycloak account on the phone gets in,
//     nobody else does.
// RemoteAuthority:AllowAnonymous=true opens the endpoint for local dev.
var remoteAllowAnonymous =
    string.Equals(builder.Configuration["RemoteAuthority:AllowAnonymous"], "true", StringComparison.OrdinalIgnoreCase);
var jwtHandler = new JwtSecurityTokenHandler();
var sessionOwners = new ConcurrentDictionary<string, string>(StringComparer.Ordinal);
builder.Services.AddRamphastos(
    _ => new RelayVm(),
    opts =>
    {
        opts.AuthorizeHello = hello =>
        {
            if (remoteAllowAnonymous)
            {
                return true;
            }
            var sub = ValidateJwt(hello.Auth);
            if (sub is null)
            {
                return false;
            }
            if (hello.Role == "authority")
            {
                // Authorities must pin the session they own — the bind has
                // to happen before the server would assign an id.
                if (string.IsNullOrEmpty(hello.Session))
                {
                    return false;
                }
                return sessionOwners.GetOrAdd(hello.Session, sub) == sub;
            }
            return !string.IsNullOrEmpty(hello.Session)
                && sessionOwners.TryGetValue(hello.Session, out var owner)
                && owner == sub;
        };
    });

var app = builder.Build();

// Resolve eagerly so misconfiguration (JWT validation, session-host
// isolation policy, resource limits) fails the gateway at startup, not on
// the first connect — options and singletons are otherwise built lazily.
app.Services.GetRequiredService<IOptionsMonitor<JwtBearerOptions>>().Get(JwtBearerDefaults.AuthenticationScheme);
app.Services.GetRequiredService<SessionHostContainerService>();

app.UseAuthentication();
app.UseAuthorization();

// Client-authoritative hub — see the AddRamphastos registration above.
// Deliberately NOT RequireAuthorization: hello-level token check instead
// (desktops have no JWT).
app.MapRamphastos("/remote");
app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = WebSocketProxy.KeepAliveInterval,
    KeepAliveTimeout = WebSocketProxy.KeepAliveTimeout,
});

// Discovery for remote clients: the mirrored sessions this account owns.
// A phone browser hits this after Keycloak login to list "your desktops"
// instead of typing session ids. Owner-scoped — same sub check as the
// viewer hello. In AllowAnonymous dev mode the endpoint still requires a
// JWT (there is no owner to match otherwise).
app.MapGet("/remote/sessions", [Microsoft.AspNetCore.Authorization.Authorize] (ClaimsPrincipal user) =>
{
    var sub = user.FindFirst("sub")?.Value
        ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value;
    var sessions = sub is null
        ? Array.Empty<string>()
        : sessionOwners.Where(kv => kv.Value == sub).Select(kv => kv.Key).ToArray();
    return Results.Ok(new { sessions });
});

app.MapGet("/", () => "axn-term session gateway");
app.MapGet("/healthz", () => Results.Ok());

// Per-user capability map — admin-gated. realm_access.roles carries the
// Keycloak realm roles; 'admin' is the only entitlement today.
static bool IsAdmin(ClaimsPrincipal user) =>
    user.FindAll("realm_access")
        .Select(c => c.Value)
        .Select(v => { try { return JsonDocument.Parse(v).RootElement; } catch { return default; } })
        .Any(el => el.ValueKind == JsonValueKind.Object &&
                   el.TryGetProperty("roles", out var r) &&
                   r.EnumerateArray().Any(x => x.GetString() == "admin"));

var capsGroup = app.MapGroup("/admin");

capsGroup.MapGet("/users", [Microsoft.AspNetCore.Authorization.Authorize] (
    ClaimsPrincipal user, UserCapabilities caps) =>
        IsAdmin(user) ? Results.Json(caps.All()) : Results.Forbid());

capsGroup.MapGet("/users/{userId}/capabilities", [Microsoft.AspNetCore.Authorization.Authorize] (
    string userId, ClaimsPrincipal user, UserCapabilities caps) =>
        IsAdmin(user) ? Results.Json(caps.Get(userId)) : Results.Forbid());

capsGroup.MapPut("/users/{userId}/capabilities", [Microsoft.AspNetCore.Authorization.Authorize] async (
    string userId, HttpRequest req, ClaimsPrincipal user, UserCapabilities caps) =>
{
    if (!IsAdmin(user)) return Results.Forbid();
    var body = await JsonNode.ParseAsync(req.Body) as JsonObject;
    if (body is null) return Results.BadRequest();
    if (body["nixManaged"] is not null)
    {
        caps.SetNixManaged(userId, body["nixManaged"]!.GetValue<bool>());
    }
    return Results.Json(caps.Get(userId));
});

app.Map("/ws", [Microsoft.AspNetCore.Authorization.Authorize] async (
    HttpContext context,
    SessionHostContainerService hosts,
    ILogger<Program> logger,
    CancellationToken cancellationToken) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var userId = UserIdentity.Resolve(context.User);
    if (userId is null)
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return;
    }

    try
    {
        var agentHost = await hosts.EnsureSessionHostAsync(userId, cancellationToken);

        using var serverSocket = await context.WebSockets.AcceptWebSocketAsync();
        await WebSocketProxy.RunAsync(serverSocket, agentHost, "/ws", WebSocketProxy.ForwardedQuery(context.Request.Query), cancellationToken);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "WebSocket /ws failed for user {UserId}", userId);
        context.Abort();
    }
});

// Ramphastos hub on the session host — one multiplexed connection carrying
// the synced projection, commands and pty:<id> streams. The proxy forwards
// raw WebSocket frames only, so clients must connect with the SignalR
// WebSockets transport and skipNegotiation.
app.Map("/ramphastos", [Microsoft.AspNetCore.Authorization.Authorize] async (
    HttpContext context,
    SessionHostContainerService hosts,
    ILogger<Program> logger,
    CancellationToken cancellationToken) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var userId = ResolveUserId(context.User, context.Request.Query);
    try
    {
        var agentHost = await hosts.EnsureSessionHostAsync(userId, cancellationToken);

        using var serverSocket = await context.WebSockets.AcceptWebSocketAsync();
        await WebSocketProxy.RunAsync(serverSocket, agentHost, "/ramphastos", context.Request.QueryString.Value, cancellationToken);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "WebSocket /ramphastos failed for user {UserId}", userId);
        context.Abort();
    }
});

// Recreate my session host: drops the container; the next /ws connect
// spawns a fresh one. Persistent volumes (home, nix store) are kept —
// this is the "re-apply my environment config" trigger.
app.MapPost("/session/recreate", [Microsoft.AspNetCore.Authorization.Authorize] async (
    HttpContext context,
    SessionHostContainerService hosts,
    CancellationToken cancellationToken) =>
{
    var userId = UserIdentity.Resolve(context.User);
    if (userId is null)
    {
        return Results.Unauthorized();
    }

    await hosts.RecreateSessionHostAsync(userId, cancellationToken);
    return Results.NoContent();
});

app.Map("/tasks", [Microsoft.AspNetCore.Authorization.Authorize] async (
    HttpContext context,
    SessionHostContainerService hosts,
    ILogger<Program> logger,
    CancellationToken cancellationToken) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var userId = UserIdentity.Resolve(context.User);
    if (userId is null)
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return;
    }

    try
    {
        var agentHost = await hosts.EnsureSessionHostAsync(userId, cancellationToken);

        using var serverSocket = await context.WebSockets.AcceptWebSocketAsync();
        await WebSocketProxy.RunAsync(serverSocket, agentHost, "/tasks", null, cancellationToken);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "WebSocket /tasks failed for user {UserId}", userId);
        context.Abort();
    }
});

app.Run();
static string ResolveUserId(ClaimsPrincipal user, IQueryCollection query)
{
    var name = user.Identity?.Name;
    if (!string.IsNullOrWhiteSpace(name))
    {
        return Sanitize(name);
    }

    name = user.FindFirst("preferred_username")?.Value;
    if (!string.IsNullOrWhiteSpace(name))
    {
        return Sanitize(name);
    }

    name = user.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? user.FindFirst("sub")?.Value;
    if (!string.IsNullOrWhiteSpace(name))
    {
        return Sanitize(name);
    }

    if (!string.IsNullOrWhiteSpace(query["user"]))
    {
        return Sanitize(query["user"]!);
    }

    return Sanitize(
        Environment.GetEnvironmentVariable("DEFAULT_USER") ?? "dev");
}

static string Sanitize(string userId)
{
    var safe = string.Concat(
        userId.ToLowerInvariant()
            .Where(c => char.IsLetterOrDigit(c) || c == '-' || c == '_'));
    safe = safe.Trim('-', '_');
    return string.IsNullOrEmpty(safe) ? "dev" : safe;
}

/// <summary>
/// Validate a hello-carried JWT against the same JWKS/parameters as the
/// HTTP routes; returns the stable subject (sub, falling back to
/// preferred_username / nameidentifier) or null when invalid.
/// </summary>
string? ValidateJwt(string? token)
{
    if (string.IsNullOrEmpty(token))
    {
        return null;
    }
    try
    {
        var oidc = jwksConfig.GetConfigurationAsync(CancellationToken.None)
            .GetAwaiter().GetResult();
        tokenValidationParameters.IssuerSigningKeys = oidc.SigningKeys;
        var principal = jwtHandler.ValidateToken(token, tokenValidationParameters, out _);
        return principal.FindFirst("sub")?.Value
            ?? principal.FindFirst("preferred_username")?.Value
            ?? principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
    }
    catch
    {
        return null;
    }
}

/// <summary>
/// Placeholder application model for the /remote hub — sessions here are
/// client-authoritative (their state lives in the authority client, the
/// hub mirrors it). A fresh non-authority hello would create a session
/// from this empty root, which is not a supported flow but stays harmless.
/// </summary>
sealed class RelayVm : ApplicationModel;
