using System.Text.Json.Nodes;

namespace AxnTerm.Gateway;

/// <summary>
/// Per-user capability/entitlement map, persisted as JSON under the
/// gateway's AXN_STATE_DIR. Today it carries only `nixManaged` — whether the
/// user's session host mounts a writable ~/.config/nix — but the shape is
/// meant to grow (resource overrides, dind opt-in, …).
/// </summary>
public sealed class UserCapabilities
{
    private readonly string _file;
    private readonly object _lock = new();
    private JsonObject _state = new();

    public UserCapabilities(string stateDir)
    {
        _file = Path.Combine(stateDir, "user-capabilities.json");
        Load();
    }

    public bool NixManaged(string userId) =>
        Read(userId)?["nixManaged"]?.GetValue<bool>() == true;

    public JsonObject Get(string userId)
    {
        lock (_lock)
        {
            return Read(userId)?.DeepClone() as JsonObject ?? new JsonObject();
        }
    }

    public void SetNixManaged(string userId, bool managed)
    {
        lock (_lock)
        {
            EnsureUser(userId)["nixManaged"] = managed;
            Save();
        }
    }

    public JsonObject All()
    {
        lock (_lock)
        {
            return _state.DeepClone() as JsonObject ?? new JsonObject();
        }
    }

    private JsonObject? Read(string userId) =>
        _state["users"]?[userId] as JsonObject;

    private JsonObject EnsureUser(string userId)
    {
        if (_state["users"] is not JsonObject users)
        {
            users = new JsonObject();
            _state["users"] = users;
        }
        if (users[userId] is not JsonObject entry)
        {
            entry = new JsonObject();
            users[userId] = entry;
        }
        return entry;
    }

    private void Load()
    {
        try
        {
            if (File.Exists(_file) &&
                JsonNode.Parse(File.ReadAllText(_file)) is JsonObject o)
            {
                _state = o;
            }
        }
        catch
        {
            // corrupt state — start empty rather than fail startup
        }
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            File.WriteAllText(_file, _state.ToJsonString());
        }
        catch
        {
            // persist failure — capabilities still work in memory this run
        }
    }
}
