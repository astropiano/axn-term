using Ramphastos.Core;

namespace Astropiano.AxnTerm.SessionHost;

/// <summary>
/// Per-connection terminal geometry with smallest-wins semantics
/// (tmux-style): a shared PTY is resized to the smallest viewport across
/// live connections. When the smallest device disconnects its viewport
/// leaves the set and the PTY grows back to the next-smallest.
/// </summary>
public sealed class ViewportSizer
{
    private readonly Dictionary<string, (int cols, int rows)> _viewports = new();

    /// <summary>The connection gave up its claim; callers re-fit PTYs after.</summary>
    public bool Remove(string connectionId) => _viewports.Remove(connectionId);

    /// <summary>Record the invoking connection's viewport (when cols/rows
    /// are given), compute the smallest-wins geometry and apply it to the
    /// PTY and its projection. Returns the effective size.</summary>
    public (int cols, int rows) Apply(
        PtySession pty, IDictionary<string, RemotePtyInfo> infos,
        int? cols = null, int? rows = null)
    {
        if (cols.HasValue && rows.HasValue && ConnectionContext.Current is { } conn)
        {
            _viewports[conn.Id] = (cols.Value, rows.Value);
        }

        var ec = pty.Cols;
        var er = pty.Rows;
        foreach (var (c, r) in _viewports.Values)
        {
            if (c > 0 && c < ec) ec = c;
            if (r > 0 && r < er) er = r;
        }

        if (ec != pty.Cols || er != pty.Rows)
        {
            pty.Pty.Resize(ec, er);
            pty.Cols = ec;
            pty.Rows = er;
            if (infos.TryGetValue(pty.Id, out var info))
            {
                info.Cols = ec;
                info.Rows = er;
            }
        }
        return (ec, er);
    }
}
