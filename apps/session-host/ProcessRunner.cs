using System.Diagnostics;
using System.Text;

namespace Astropiano.AxnTerm.SessionHost;

public sealed record ProcessResult(int ExitCode, byte[] Stdout, string Stderr, bool TimedOut, bool OutputLimitExceeded)
{
    /// <summary>stdout as text — UTF-8 unless a BOM says otherwise (like File.ReadAllText).</summary>
    public string StdoutText
    {
        get
        {
            using var reader = new StreamReader(new MemoryStream(Stdout), Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            return reader.ReadToEnd();
        }
    }
}

/// <summary>
/// Runs a child process for exec / fs-* requests: stdout and stderr are
/// drained concurrently (reading one to the end first deadlocks once the
/// other fills its pipe buffer), output is capped, and on timeout, output
/// overflow or cancellation the whole process tree is killed.
/// </summary>
public static class ProcessRunner
{
    /// <summary>
    /// How long to keep draining after the process exits or is killed: a
    /// backgrounded grandchild can hold the pipes open indefinitely.
    /// </summary>
    private static readonly TimeSpan DrainTimeout = TimeSpan.FromSeconds(2);

    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> fired (the process tree is killed first).</exception>
    public static async Task<ProcessResult> RunAsync(
        ProcessStartInfo psi,
        string? stdin,
        TimeSpan timeout,
        long maxOutputBytes,
        CancellationToken cancellationToken)
    {
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardInput = stdin is not null;

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"could not start {psi.FileName}");
        using var limitCts = new CancellationTokenSource();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, limitCts.Token);
        cts.CancelAfter(timeout);

        var stdout = new BoundedBuffer(maxOutputBytes, limitCts);
        var stderr = new BoundedBuffer(maxOutputBytes, limitCts);
        var pumps = Task.WhenAll(
            stdout.PumpAsync(proc.StandardOutput.BaseStream),
            stderr.PumpAsync(proc.StandardError.BaseStream));
        var stdinTask = stdin is null ? Task.CompletedTask : WriteStdinAsync(proc.StandardInput, stdin);

        var killed = false;
        try
        {
            await proc.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            killed = true;
            KillTree(proc);
        }

        await Quietly(pumps.WaitAsync(DrainTimeout));
        await Quietly(stdinTask.WaitAsync(DrainTimeout));
        if (killed)
        {
            await Quietly(proc.WaitForExitAsync().WaitAsync(DrainTimeout));
        }

        cancellationToken.ThrowIfCancellationRequested();
        return new ProcessResult(
            proc.HasExited ? proc.ExitCode : -1,
            stdout.ToArray(),
            Encoding.UTF8.GetString(stderr.ToArray()),
            TimedOut: killed && !stdout.Exceeded && !stderr.Exceeded,
            OutputLimitExceeded: stdout.Exceeded || stderr.Exceeded);
    }

    private static async Task WriteStdinAsync(StreamWriter writer, string contents)
    {
        try
        {
            await writer.WriteAsync(contents);
            writer.Close();
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            // the child exited (or was killed) without reading everything
        }
    }

    private static void KillTree(Process proc)
    {
        try
        {
            proc.Kill(entireProcessTree: true);
        }
        catch
        {
            // already gone
        }
    }

    private static async Task Quietly(Task task)
    {
        try
        {
            await task;
        }
        catch
        {
            // drain timeouts / pipe errors after a kill are expected
        }
    }

    /// <summary>Collects a pipe up to a cap; overflowing cancels the run.</summary>
    private sealed class BoundedBuffer(long max, CancellationTokenSource overflow)
    {
        private readonly MemoryStream _data = new();

        public bool Exceeded { get; private set; }

        public async Task PumpAsync(Stream source)
        {
            var buffer = new byte[8192];
            try
            {
                int read;
                while ((read = await source.ReadAsync(buffer)) > 0)
                {
                    lock (_data)
                    {
                        var room = (int)Math.Min(read, max - _data.Length);
                        _data.Write(buffer, 0, room);
                        if (room < read)
                        {
                            Exceeded = true;
                        }
                    }

                    if (Exceeded)
                    {
                        overflow.Cancel();
                        return;
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException)
            {
                // pipe torn down by the kill
            }
        }

        public byte[] ToArray()
        {
            lock (_data)
            {
                return _data.ToArray();
            }
        }
    }
}
