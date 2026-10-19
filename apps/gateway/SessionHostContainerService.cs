using Docker.DotNet;
using Docker.DotNet.Models;
using System.Net;

namespace Astropiano.AxnTerm.Gateway;

public sealed class SessionHostContainerService : IDisposable
{
    private readonly DockerClient _docker;
    private readonly ILogger<SessionHostContainerService> _logger;
    private readonly string _image;
    private readonly string _network;
    private readonly string _prefix;
    private readonly int _hostPort;
    private readonly string? _dataMount;
    private readonly string _puid;
    private readonly string _pgid;
    private readonly string _defaultPtyCwd;
    private readonly string _home;
    private readonly string _stateDir;
    private readonly bool _nixEnabled;
    private readonly UserCapabilities _caps;
    private readonly string? _runtime;
    private readonly bool _privileged;
    private readonly bool _dind;
    private readonly string _user;
    private readonly string _hostname;
    private readonly string? _homeVolumePrefix;
    private readonly string? _nixVolumePrefix;
    private readonly string? _nixFlake;
    private readonly long _memory;
    private readonly long? _pidsLimit;
    private readonly long _nanoCpus;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> _spawnLocks = new();

    public SessionHostContainerService(
        UserCapabilities caps,IConfiguration configuration, ILogger<SessionHostContainerService> logger)
    {
        _logger = logger;
        _image = configuration["SESSION_HOST_IMAGE"] ?? "axn-term-host";
        _network = configuration["SESSION_HOST_NETWORK"] ?? "axn-term_default";
        _prefix = configuration["SESSION_HOST_PREFIX"] ?? "axn-term-host";
        _hostPort = int.TryParse(configuration["SESSION_HOST_PORT"], out var p) ? p : 7682;
        _dataMount = configuration["DATA_MOUNT"];
        _puid = configuration["PUID"] ?? "1000";
        _pgid = configuration["PGID"] ?? "1000";
        _defaultPtyCwd = configuration["PTY_CWD"] ?? "/tmp";
        _home = configuration["SESSION_HOST_HOME"] ?? _defaultPtyCwd;
        _stateDir = configuration["AXN_STATE_DIR"] ?? "/tmp/axn-term";
        _nixEnabled = configuration["AXN_USER_NIX_ENABLED"] is "1" or "true";
        _caps = caps;
        // SESSION_HOST_RUNTIME picks the OCI runtime for session hosts, e.g.
        // "kata" to run each session in its own KVM-backed VM so users can
        // run dockerd inside without privileges on the host.
        _runtime = string.IsNullOrWhiteSpace(configuration["SESSION_HOST_RUNTIME"])
            ? null
            : configuration["SESSION_HOST_RUNTIME"];
        // SESSION_HOST_PRIVILEGED grants full capabilities inside the session
        // host — safe under a VM runtime like kata where the guest kernel is
        // the isolation boundary; required for dockerd inside the session.
        _privileged = configuration["SESSION_HOST_PRIVILEGED"] == "1"
            || configuration["SESSION_HOST_PRIVILEGED"]?.Equals("true", StringComparison.OrdinalIgnoreCase) == true;
        // SESSION_HOST_DIND=1 enables docker-in-session: full capabilities
        // and unconfined seccomp inside the session host plus ip_forward —
        // everything an inner dockerd needs. Under kata this is the correct
        // form (HostConfig.Privileged tries to pass host devices into the
        // VM and fails).
        _dind = configuration["SESSION_HOST_DIND"] == "1"
            || configuration["SESSION_HOST_DIND"]?.Equals("true", StringComparison.OrdinalIgnoreCase) == true;
        // Both put the user on (near-)root terms with the kernel the host
        // runs on — refused unless that kernel is a kata guest, see
        // SessionHostResources.ValidateIsolation.
        var isolationWarning = SessionHostResources.ValidateIsolation(
            _dind,
            _privileged,
            _runtime,
            configuration["SESSION_HOST_ALLOW_UNSAFE_RUNC"] == "1");
        if (isolationWarning is not null)
        {
            _logger.LogWarning("UNSAFE session host isolation: {Warning}", isolationWarning);
        }
        // SESSION_HOST_USER overrides the container user (default PUID:PGID).
        // Docker-in-session typically wants "0:0" so dockerd can run.
        _user = string.IsNullOrWhiteSpace(configuration["SESSION_HOST_USER"])
            ? $"{_puid}:{_pgid}"
            : configuration["SESSION_HOST_USER"]!;
        // SESSION_HOST_HOSTNAME sets the session host's hostname — it's what
        // the shell prompt shows (user@hostname). Default keeps the familiar
        // "axn-machine" instead of a raw container id.
        _hostname = string.IsNullOrWhiteSpace(configuration["SESSION_HOST_HOSTNAME"])
            ? "axn-machine"
            : configuration["SESSION_HOST_HOSTNAME"]!;
        // SESSION_HOST_HOME_VOLUME enables a persistent per-user home: a
        // named docker volume "<prefix>-<user>" mounted at /home/<user>,
        // created on demand. Everything under $HOME survives session-host
        // recreation — userland installs (nix, mise, ~/.local, dotfiles)
        // persist; system-level changes remain ephemeral.
        _homeVolumePrefix = string.IsNullOrWhiteSpace(configuration["SESSION_HOST_HOME_VOLUME"])
            ? null
            : configuration["SESSION_HOST_HOME_VOLUME"]!;
        // SESSION_HOST_NIX_VOLUME enables a persistent per-user nix store:
        // a named docker volume "<prefix>-<user>" mounted at /nix, created
        // on demand and seeded from the image. Each user's store is private
        // and survives session-host recreation.
        _nixVolumePrefix = string.IsNullOrWhiteSpace(configuration["SESSION_HOST_NIX_VOLUME"])
            ? null
            : configuration["SESSION_HOST_NIX_VOLUME"]!;
        // AXN_NIX_FLAKE is a deployment-wide default home-manager flake ref
        // applied on session-host spawn; a user's own nix-flake file (see
        // entrypoint) takes precedence.
        _nixFlake = string.IsNullOrWhiteSpace(configuration["AXN_NIX_FLAKE"])
            ? null
            : configuration["AXN_NIX_FLAKE"]!;

        // Per-container limits so one session can't starve the box:
        // SESSION_HOST_MEMORY (docker size, default 4g), SESSION_HOST_PIDS
        // (default 4096), SESSION_HOST_CPUS (default 2); "0" lifts a limit.
        _memory = SessionHostResources.ParseMemory(configuration["SESSION_HOST_MEMORY"]);
        _pidsLimit = SessionHostResources.ParsePids(configuration["SESSION_HOST_PIDS"]);
        _nanoCpus = SessionHostResources.ParseNanoCpus(configuration["SESSION_HOST_CPUS"]);

        var dockerHost = configuration["DOCKER_HOST"];
        _docker = string.IsNullOrWhiteSpace(dockerHost)
            ? new DockerClientConfiguration().CreateClient()
            : new DockerClientConfiguration(new Uri(dockerHost)).CreateClient();
    }

    public async Task<SessionHostEndpoint> EnsureSessionHostAsync(string userId, CancellationToken cancellationToken = default)
    {
        // Serialize spawn per user: concurrent /ws connects (e.g. React
        // StrictMode double-mount, browser retry) must not race docker
        // create — the second caller waits and attaches to the host the
        // first one spawned.
        var gate = _spawnLocks.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            var containerName = $"{_prefix}-{userId}";
            _logger.LogInformation("Ensuring session host container {ContainerName} for user {UserId}", containerName, userId);

            var secret = await TryStartExistingAsync(containerName, cancellationToken);
            if (secret is not null)
            {
                _logger.LogDebug("Session host container {ContainerName} already exists and is running", containerName);
            }
            else
            {
                secret = SessionHostSecret.Generate();
                await CreateAndStartAsync(containerName, userId, secret, cancellationToken);
            }

            var endpoint = new SessionHostEndpoint(containerName, _hostPort, secret);
            await WaitForAgentReadyAsync(endpoint, cancellationToken);
            return endpoint;
        }
        finally
        {
            gate.Release();
        }
    }

    /// Removes the user's session host so the next /ws connect spawns a
    /// fresh one — "recreate my environment" (home/nix volumes persist).
    public async Task RecreateSessionHostAsync(string userId, CancellationToken cancellationToken = default)
    {
        // Share the spawn gate so a recreate never races an in-flight spawn.
        var gate = _spawnLocks.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            var containerName = $"{_prefix}-{userId}";
            try
            {
                await _docker.Containers.RemoveContainerAsync(
                    containerName,
                    new ContainerRemoveParameters { Force = true },
                    cancellationToken);
                _logger.LogInformation("Removed session host {ContainerName} on recreate request", containerName);
            }
            catch (DockerApiException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
            {
                // Nothing to remove — the next connect will spawn anyway.
            }
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>
    /// Starts the user's existing session host and returns its secret, read
    /// back from the container env (survives gateway restarts). Null when
    /// there is none to reuse — including hosts created before the secret
    /// existed: those accept unauthenticated connections, so they are
    /// removed here and the caller recreates them (volumes persist).
    /// </summary>
    private async Task<string?> TryStartExistingAsync(string containerName, CancellationToken cancellationToken)
    {
        ContainerInspectResponse inspect;
        try
        {
            inspect = await _docker.Containers.InspectContainerAsync(containerName, cancellationToken);
        }
        catch (DockerApiException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        var secret = SessionHostSecret.FromEnv(inspect.Config?.Env);
        if (secret is null)
        {
            _logger.LogWarning("Session host {ContainerName} has no {EnvName}; recreating it", containerName, SessionHostSecret.EnvName);
            await _docker.Containers.RemoveContainerAsync(
                containerName,
                new ContainerRemoveParameters { Force = true },
                cancellationToken);
            return null;
        }

        if (!inspect.State.Running)
        {
            await _docker.Containers.StartContainerAsync(
                containerName,
                new ContainerStartParameters(),
                cancellationToken);
        }

        return secret;
    }

    private async Task CreateAndStartAsync(string containerName, string userId, string secret, CancellationToken cancellationToken)
    {
        var binds = new List<string>();
        var nixManaged = false;
        var ptyCwd = _defaultPtyCwd;
        var home = _home;

        if (_homeVolumePrefix is not null)
        {
            // Persistent home: a named volume per user at /home/<user>.
            // Docker would auto-create it at start; we create it explicitly
            // so it carries the owner label for inspection/cleanup.
            var volumeName = $"{_homeVolumePrefix}-{userId}";
            await EnsureVolumeAsync(volumeName, userId, cancellationToken);
            home = $"/home/{userId}";
            // `Z` relabels the volume to this container's private SELinux
            // category on every create. Without it a recreated host (secret
            // rotation, POST /session/recreate) gets a new category and is
            // denied its own $HOME on SELinux podman; non-SELinux hosts
            // ignore the flag.
            binds.Add($"{volumeName}:{home}:Z");
            // With a real home the shell should land there unless DATA_MOUNT
            // overrides the cwd.
            ptyCwd = string.IsNullOrWhiteSpace(_dataMount) ? home : _dataMount;
        }

        if (_nixVolumePrefix is not null)
        {
            // Persistent nix store: a named volume per user at /nix. The
            // entrypoint seeds an empty volume from the image's nix seed
            // and hands ownership to the session user.
            var volumeName = $"{_nixVolumePrefix}-{userId}";
            await EnsureVolumeAsync(volumeName, userId, cancellationToken);
            binds.Add($"{volumeName}:/nix:Z");
        }

        if (!string.IsNullOrWhiteSpace(_dataMount))
        {
            // Mount the user's data directory at the same path so shell paths are
            // familiar. The container user must have write permission there.
            binds.Add($"{_dataMount}:{_dataMount}");
            ptyCwd = _dataMount;

            // Per-user nix config: the user's own writable nix dir mounted at
            // ~/.config/nix when entitled + AXN_USER_NIX_ENABLED is on.
            if (_nixEnabled && _caps.NixManaged(userId))
            {
                var nixDir = Path.Combine(_dataMount, "nix");
                binds.Add($"{nixDir}:/home/{userId}/.config/nix");
                nixManaged = true;
            }
        }

        var env = new List<string>
        {
            $"SESSION_HOST_PORT={_hostPort}",
            $"USER={userId}",
            $"LOGNAME={userId}",
            $"KEYCLOAK_USERNAME={userId}",
            $"PUID={_puid}",
            $"PGID={_pgid}",
            "TERM=xterm-256color",
            $"PTY_CMD=/bin/bash",
            $"PTY_ARGS=",
            $"PTY_CWD={ptyCwd}",
            $"HOME={home}",
            $"AXN_STATE_DIR={_stateDir}",
            $"{SessionHostSecret.EnvName}={secret}",
        };
        if (nixManaged)
        {
            env.Add("AXN_USER_NIX_MANAGED=1");
        }

        if (_nixFlake is not null)
        {
            env.Add($"AXN_NIX_FLAKE={_nixFlake}");
        }

        var createParams = new CreateContainerParameters
        {
            Image = _image,
            Name = containerName,
            Hostname = _hostname,
            User = _user,
            Labels = new Dictionary<string, string> { ["axn-term-user"] = userId },
            ExposedPorts = new Dictionary<string, EmptyStruct>
            {
                [$"{_hostPort}/tcp"] = default,
            },
            Env = env,
            WorkingDir = "/app",
            HostConfig = new HostConfig
            {
                NetworkMode = _network,
                RestartPolicy = new RestartPolicy { Name = RestartPolicyKind.UnlessStopped },
                Binds = binds,
                Runtime = _runtime,
                Privileged = _privileged,
                // tini as PID 1: reaps zombies left by PTY shells and exec
                // children and forwards signals.
                Init = true,
                Memory = _memory,
                PidsLimit = _pidsLimit,
                NanoCPUs = _nanoCpus,
                // SYS_PTRACE lets the root-owned host resolve the PTY user's
                // /proc/<pid>/cwd — cwd/exec/fs-* all resolve through it.
                CapAdd = _dind
                    ? new List<string> { "ALL" }
                    : new List<string> { "SYS_PTRACE" },
                SecurityOpt = _dind ? new List<string> { "seccomp=unconfined" } : null,
                Sysctls = _dind
                    ? new Dictionary<string, string> { ["net.ipv4.ip_forward"] = "1" }
                    : null,
            },
        };

        _logger.LogInformation("Creating session host container {ContainerName} from image {Image}", containerName, _image);
        CreateContainerResponse response;
        try
        {
            response = await _docker.Containers.CreateContainerAsync(createParams, cancellationToken);
        }
        catch (DockerApiException ex)
        {
            _logger.LogError(ex, "Docker create failed for {ContainerName}: {StatusCode} {ResponseBody}", containerName, ex.StatusCode, ex.Message);
            throw;
        }

        _logger.LogInformation("Created session host container {ContainerId}", response.ID);

        try
        {
            await _docker.Containers.StartContainerAsync(
                response.ID,
                new ContainerStartParameters(),
                cancellationToken);
        }
        catch (DockerApiException ex)
        {
            _logger.LogError(ex, "Docker start failed for {ContainerName}: {StatusCode} {ResponseBody}", containerName, ex.StatusCode, ex.Message);
            throw;
        }
    }

    private async Task EnsureVolumeAsync(string name, string userId, CancellationToken cancellationToken)
    {
        try
        {
            await _docker.Volumes.InspectAsync(name, cancellationToken);
            return;
        }
        catch (DockerApiException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            // fall through — create it
        }

        _logger.LogInformation("Creating volume {VolumeName} for user {UserId}", name, userId);
        await _docker.Volumes.CreateAsync(
            new VolumesCreateParameters
            {
                Name = name,
                Labels = new Dictionary<string, string> { ["axn-term-user"] = userId },
            },
            cancellationToken);
    }

    private async Task WaitForAgentReadyAsync(SessionHostEndpoint endpoint, CancellationToken cancellationToken)
    {
        // Generous bound: a kata VM cold boot plus entrypoint work (nix seed
        // copy on first spawn) can take tens of seconds.
        var timeout = TimeSpan.FromSeconds(60);
        var poll = TimeSpan.FromMilliseconds(250);
        var deadline = DateTime.UtcNow + timeout;

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                // The host answers 401 to anything without its secret.
                using var request = new HttpRequestMessage(HttpMethod.Get, $"http://{endpoint.Host}:{endpoint.Port}/");
                request.Headers.Add(SessionHostSecret.HeaderName, endpoint.Secret);
                using var response = await http.SendAsync(request, cancellationToken);
                if (response.StatusCode == HttpStatusCode.OK)
                {
                    return;
                }
            }
            catch (Exception ex)
            {
                _logger.LogTrace(ex, "Agent {ContainerName} not ready yet", endpoint.Host);
            }

            await Task.Delay(poll, cancellationToken);
        }

        throw new InvalidOperationException($"Session host container {endpoint.Host} did not become ready in time");
    }

    public void Dispose()
    {
        _docker.Dispose();
    }
}
