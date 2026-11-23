using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using System.Net.WebSockets;
using System.Security.Claims;
using AxnTerm.Gateway;
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
builder.Services.AddCors();
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
//   - session ids are namespaced '<jwt-sub>/<id>' — the prefix is
//     self-proving for both authority and viewer hellos, so ownership
//     needs no shared state and survives restarts.
//   - authorities must pin a session id; viewers attach to an existing
//     one in their own namespace — same Keycloak account on the phone
//     gets in, nobody else does.
// RemoteAuthority:AllowAnonymous=true opens the endpoint for local dev.
var remoteAllowAnonymous =
    string.Equals(builder.Configuration["RemoteAuthority:AllowAnonymous"], "true", StringComparison.OrdinalIgnoreCase);
// Authorized parties (azp) for hello tokens — see GatewayAuth.RemoteClientIds.
var remoteClientIds = GatewayAuth.RemoteClientIds(builder.Configuration["RemoteAuthority:ClientIds"], clientId);
var jwtHandler = new JwtSecurityTokenHandler();
var diagnostics = new RemoteDiagnostics();
builder.Services.AddSingleton(diagnostics);
// Set after Build() — the hello callback runs long after startup.
ILogger? remoteLog = null;
// Keep claim names verbatim — the default inbound mapping renames "sub" to
// NameIdentifier, which would make the <sub>/<session> namespace check below
// resolve to preferred_username instead and always reject valid hellos.
jwtHandler.MapInboundClaims = false;
builder.Services.AddRamphastos(
    // Null factory = client-authoritative hub: a viewer hello to an unknown
    // session claims a mirrored slot (authority_offline), never a server-
    // owned session that would permanently reject the authority's attach.
    _ => (Ramphastos.Core.ApplicationModel?)null,
    opts =>
    {
        opts.AuthorizeHello = hello =>
        {
            remoteLog?.LogInformation("[remote] hello role={Role} session={Session} anon={Anon}",
                hello.Role, hello.Session, remoteAllowAnonymous);
            if (remoteAllowAnonymous)
            {
                return true;
            }
            var check = CheckRemoteToken(hello.Auth);
            // Failed checks are filed under the subject the token CLAIMS —
            // only that account can read them back (/remote/status).
            var account = check.Sub ?? GatewayAuth.UnverifiedClaim(jwtHandler, hello.Auth, "sub");
            if (!check.Ok)
            {
                remoteLog?.LogWarning("[remote] hello denied role={Role}: {Reason}", hello.Role, check.Reason);
                diagnostics.Record(account, hello.Role.ToString(), hello.Session, false, check.Reason);
                return false;
            }
            // Tenant isolation is structural: every session id lives in the
            // caller's own namespace '<sub>/<id>' — self-proving on both the
            // publish and the attach path, stateless across restarts, no
            // shared registry to hijack. Unprefixed ids are rejected.
            var owned = !string.IsNullOrEmpty(hello.Session)
                && hello.Session.StartsWith(check.Sub + "/", StringComparison.Ordinal);
            var reason = owned ? null : "session does not belong to this account";
            if (!owned)
            {
                remoteLog?.LogWarning("[remote] hello denied role={Role}: {Reason}", hello.Role, reason);
            }
            diagnostics.Record(account, hello.Role.ToString(), hello.Session, owned, reason);
            return owned;
        };
    });

var app = builder.Build();
remoteLog = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("AxnTerm.Gateway.Remote");

// Resolve eagerly so misconfiguration (JWT validation, session-host
// isolation policy, resource limits) fails the gateway at startup, not on
// the first connect — options and singletons are otherwise built lazily.
app.Services.GetRequiredService<IOptionsMonitor<JwtBearerOptions>>().Get(JwtBearerDefaults.AuthenticationScheme);
app.Services.GetRequiredService<SessionHostContainerService>();

// CORS: the shell is served from a different origin than the gateway
// (localhost subdomains, mDNS names, LAN IPs — all on distinct ports), so
// /remote/sessions et al. must answer preflight. Token-bound endpoints are
// the auth boundary; the origin set legitimately varies in dev/LAN use.
app.UseCors(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod());

app.UseAuthentication();
app.UseAuthorization();

// Client-authoritative "remote" hub (desktop mirror) — see AddRamphastos
// above. Deliberately NOT RequireAuthorization: hello-level token check
// instead (desktops have no JWT). Hub__RemoteEnabled toggles the surface.
if (builder.Configuration.GetValue("Hub:RemoteEnabled", true))
{
    app.MapRamphastos("/remote");
}
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
if (builder.Configuration.GetValue("Hub:RemoteEnabled", true))
{
    // Remote endpoints take the same tokens as the hub hello (web, desktop
    // and mobile clients) — the [Authorize] pipeline only admits the web
    // client's azp, which would lock the apps out of their own discovery.
    ClientSession[] OwnedMirrors(string sub) =>
        app.Services.GetRequiredService<RamphastosConnectionHandler>().Manager.Endpoints
            .OfType<ClientSession>()
            .Where(s => s.Id.StartsWith(sub + "/", StringComparison.Ordinal))
            .ToArray();

    app.MapGet("/remote/sessions", (HttpRequest request) =>
    {
        var check = CheckRemoteToken(BearerToken(request));
        if (!check.Ok)
        {
            return Results.Json(new { error = check.Reason }, statusCode: StatusCodes.Status401Unauthorized);
        }
        var mirrors = OwnedMirrors(check.Sub!);
        return Results.Ok(new
        {
            // Bare ids — the original shape; older clients String() every
            // entry, so objects here would become '[object Object]' ids.
            sessions = mirrors.Select(s => s.Id).ToArray(),
            // Rich shape for current clients: offline mirrors stay listed
            // (the desktop may return), but viewers must know which are
            // attachable right now.
            sessionDetails = mirrors
                .Select(s => (object)new { id = s.Id, online = s.AuthorityOnline })
                .ToArray(),
        });
    });

    // "Why doesn't my desktop show up?" — this account's mirrored sessions
    // plus its recent hub hello attempts with the reason each was denied.
    // Clients show it on the empty/waiting state instead of spinning.
    app.MapGet("/remote/status", (HttpRequest request) =>
    {
        var token = BearerToken(request);
        var check = CheckRemoteToken(token);
        if (!check.Ok)
        {
            return Results.Json(new { error = check.Reason }, statusCode: StatusCodes.Status401Unauthorized);
        }
        var mirrors = OwnedMirrors(check.Sub!);
        return Results.Json(new
        {
            account = new
            {
                sub = check.Sub,
                user = GatewayAuth.UnverifiedClaim(jwtHandler, token, "preferred_username"),
            },
            sessions = mirrors.Select(s => new { id = s.Id, online = s.AuthorityOnline }).ToArray(),
            attempts = diagnostics.For(check.Sub!).Select(a => new
            {
                at = a.At,
                role = a.Role,
                session = a.Session,
                accepted = a.Accepted,
                reason = a.Reason,
            }).ToArray(),
        }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    });
}

// Server discovery: clients are configured with nothing but this server's
// address and read gateway/issuer/client ids from here. Public by design —
// it holds no secrets, only what a login page would reveal anyway.
var serverId = ServerDiscovery.ResolveServerId(
    app.Configuration,
    app.Configuration["Discovery:StateDir"] ?? app.Configuration["AXN_STATE_DIR"] ?? "/tmp/axn-term");
app.MapGet(ServerDiscovery.Path, (HttpRequest request) =>
    Results.Json(
        ServerDiscovery.Build(app.Configuration, serverId, ServerDiscovery.RequestOrigin(request)),
        new JsonSerializerOptions(JsonSerializerDefaults.Web)));

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

// The three session-host proxy endpoints share one body: WS check →
// resolve the caller's user → ensure their host → raw-frame bridge. They
// differ only in the upstream path and which query params go along.
static async Task ProxySessionHostWebSocket(
    HttpContext context,
    SessionHostContainerService hosts,
    ILogger<Program> logger,
    CancellationToken cancellationToken,
    string hostPath,
    string? queryString)
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
        await WebSocketProxy.RunAsync(serverSocket, agentHost, hostPath, queryString, cancellationToken);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "WebSocket {HostPath} failed for user {UserId}", hostPath, userId);
        context.Abort();
    }
}

// Hosted session paths — per-user session-host containers behind /ws and
// the multiplexed /cloud + /ramphastos hubs, plus /session/recreate and
// /tasks. Hub__CloudEnabled=false makes this a remote-only gateway:
// mirrored desktops via /remote are the only sessions, and no route can
// spawn or reach a session-host container.
if (builder.Configuration.GetValue("Hub:CloudEnabled", true))
{
app.Map("/ws", [Microsoft.AspNetCore.Authorization.Authorize] (
    HttpContext context,
    SessionHostContainerService hosts,
    ILogger<Program> logger,
    CancellationToken cancellationToken) =>
    ProxySessionHostWebSocket(
        context, hosts, logger, cancellationToken,
        "/ws", WebSocketProxy.ForwardedQuery(context.Request.Query)));

// The proxy forwards raw WebSocket frames only, so clients must connect
// with the SignalR WebSockets transport and skipNegotiation. /ramphastos
// kept as an alias.
    foreach (var cloudPath in new[] { "/cloud", "/ramphastos" })
    app.Map(cloudPath, [Microsoft.AspNetCore.Authorization.Authorize] (
    HttpContext context,
    SessionHostContainerService hosts,
    ILogger<Program> logger,
    CancellationToken cancellationToken) =>
    ProxySessionHostWebSocket(
        context, hosts, logger, cancellationToken,
        "/ramphastos", WebSocketProxy.QueryWithoutToken(context.Request.Query)));

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

app.Map("/tasks", [Microsoft.AspNetCore.Authorization.Authorize] (
    HttpContext context,
    SessionHostContainerService hosts,
    ILogger<Program> logger,
    CancellationToken cancellationToken) =>
    ProxySessionHostWebSocket(
        context, hosts, logger, cancellationToken,
        "/tasks", null));
}

app.Run();
/// <summary>
/// Validate a remote-surface JWT (hub hello, /remote/*) against the same
/// JWKS/parameters as the HTTP routes and the remote client list; the
/// reason says why when it fails.
/// </summary>
GatewayAuth.TokenCheck CheckRemoteToken(string? token)
{
    if (string.IsNullOrEmpty(token))
    {
        return new(null, "not signed in (no token)");
    }
    try
    {
        var oidc = jwksConfig.GetConfigurationAsync(CancellationToken.None)
            .GetAwaiter().GetResult();
        // Clone per validation: mutating the shared parameters would leak
        // refreshed keys into the JwtBearer handler and race concurrent
        // hellos.
        var parms = tokenValidationParameters.Clone();
        parms.IssuerSigningKeys = oidc.SigningKeys;
        return GatewayAuth.CheckHelloToken(jwtHandler, token, parms, remoteClientIds);
    }
    catch (Exception e)
    {
        remoteLog?.LogWarning(e, "[remote] cannot load signing keys");
        return new(null, "server cannot reach its login server (signing keys)");
    }
}

static string? BearerToken(HttpRequest request)
{
    var header = request.Headers.Authorization.FirstOrDefault();
    if (header?.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) == true)
    {
        return header["Bearer ".Length..].Trim();
    }
    return request.Query["access_token"].FirstOrDefault();
}

/// <summary>
/// Placeholder application model for the /remote hub — sessions here are
/// client-authoritative (their state lives in the authority client, the
/// hub mirrors it). A fresh non-authority hello would create a session
/// from this empty root, which is not a supported flow but stays harmless.
/// </summary>
sealed class RelayVm : ApplicationModel;
