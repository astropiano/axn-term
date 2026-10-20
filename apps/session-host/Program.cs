using Astropiano.AxnTerm.SessionHost;
using Astropiano.Ramphastos.Server;

var builder = WebApplication.CreateBuilder(args);

// Keep framework request logging (full request URLs) out of the logs.
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);

// The gateway spawns this process per user and probes http://<container>:<port>/
// for readiness. SESSION_HOST_PORT selects the port when ASPNETCORE_URLS is unset.
var agentPort = builder.Configuration["SESSION_HOST_PORT"];
if (!string.IsNullOrWhiteSpace(agentPort) &&
    string.IsNullOrWhiteSpace(builder.Configuration["ASPNETCORE_URLS"]))
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{agentPort}");
}

// Every request must carry the gateway's per-container secret; without
// AXN_SESSION_HOST_SECRET the host refuses to start unless
// AXN_SESSION_HOST_INSECURE=1 (local dev, e.g. apps/web against
// ws://localhost:7682 directly) — see SessionHostAuth.
var sessionSecret = SessionHostAuth.ResolveSecret(
    SessionHostAuth.ReadSecret(
        builder.Configuration[SessionHostAuth.SecretEnvName],
        builder.Configuration[SessionHostAuth.SecretFileEnvName]),
    builder.Configuration[SessionHostAuth.InsecureEnvName]);
// Configuration already holds it; drop it from the managed environment too.
// This alone does not reach the native environ children are spawned from —
// in containers the entrypoint passes the secret as a file instead.
Environment.SetEnvironmentVariable(SessionHostAuth.SecretEnvName, null);

builder.Services.AddSingleton<ControlBroker>();
builder.Services.AddSingleton<PtyHost>();
builder.Services.AddHostedService<ControlListener>();
builder.Services.AddSingleton<SessionHostService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<SessionHostService>());

// Ramphastos endpoint (/ramphastos): the host's synced projection — clients
// see the live PTY list and drive terminals over pty:<id> duplex streams
// instead of per-terminal /ws sockets.
builder.Services.AddRamphastos(
    sp => new AxnHostVm(
        sp.GetRequiredService<PtyHost>(),
        sp.GetRequiredService<ControlBroker>(),
        sp.GetRequiredService<ILogger<AxnHostVm>>()),
    opts => opts.ConfigureSession = session => ((AxnHostVm)session.Root).Attach(session));

var app = builder.Build();

if (sessionSecret is null)
{
    app.Logger.LogWarning(
        "!!! {InsecureEnvName}=1: this session host accepts UNAUTHENTICATED connections — anyone who can reach its port gets a shell. Local development only. !!!",
        SessionHostAuth.InsecureEnvName);
}

// Before anything else — in particular before a WebSocket is accepted.
app.Use(async (context, next) =>
{
    var provided = context.Request.Headers[SessionHostAuth.HeaderName];
    if (!SessionHostAuth.IsAuthorized(sessionSecret, provided.Count == 1 ? provided[0] : null))
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return;
    }

    await next(context);
});

app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(30),
    KeepAliveTimeout = TimeSpan.FromSeconds(60),
});

app.MapGet("/", () => "axn-term session host");
app.MapGet("/healthz", () => Results.Ok());
app.MapRamphastos("/ramphastos");

app.Map("/ws", async (HttpContext context, SessionHostService sessions, ILogger<Program> logger) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    try
    {
        // `?cmd=`/`?cwd=` spawn a sub-shell PTY (`sh -c <cmd>` in `cwd`).
        var cmd = context.Request.Query["cmd"].FirstOrDefault();
        var cwd = context.Request.Query["cwd"].FirstOrDefault();
        await sessions.RunSessionAsync(socket, cmd, cwd, context.RequestAborted);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Session failed");
    }
});

app.Map("/tasks", async (HttpContext context, SessionHostService sessions, ILogger<Program> logger) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    try
    {
        await sessions.RunTaskSubscriptionAsync(socket, context.RequestAborted);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Task subscription failed");
    }
});

app.Run();
