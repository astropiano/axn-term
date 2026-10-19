using System.Diagnostics;
using System.Text;
using Astropiano.AxnTerm.SessionHost;

namespace Astropiano.AxnTerm.SessionHost.Tests;

public class ProcessRunnerTests
{
    private const long Max = 16 * 1024 * 1024;

    [Fact]
    public async Task LargeStderrDoesNotDeadlock()
    {
        // Far beyond the 64 KB pipe buffer on stderr, before any stdout.
        var result = await RunShAsync(
            "head -c 1000000 /dev/zero | tr '\\0' e >&2; head -c 300000 /dev/zero | tr '\\0' o",
            TimeSpan.FromSeconds(30));

        Assert.False(result.TimedOut);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(1_000_000, result.Stderr.Length);
        Assert.Equal(300_000, result.Stdout.Length);
    }

    [Fact]
    public async Task TimeoutKillsTheWholeProcessTree()
    {
        var watch = Stopwatch.StartNew();
        var result = await RunShAsync("sleep 60 & echo $!; wait", TimeSpan.FromSeconds(1));

        Assert.True(result.TimedOut);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(15), $"took {watch.Elapsed}");
        var childPid = int.Parse(Encoding.UTF8.GetString(result.Stdout).Trim());
        Assert.True(await GoneAsync(childPid), $"background child {childPid} survived");
    }

    [Fact]
    public async Task CancellationKillsAndThrows()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        var watch = Stopwatch.StartNew();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => ProcessRunner.RunAsync(Sh("sleep 60"), null, TimeSpan.FromMinutes(1), Max, cts.Token));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(15), $"took {watch.Elapsed}");
    }

    [Fact]
    public async Task OutputBeyondTheCapIsCutOff()
    {
        var result = await ProcessRunner.RunAsync(
            Sh("cat /dev/zero"), null, TimeSpan.FromSeconds(30), 100_000, CancellationToken.None);

        Assert.True(result.OutputLimitExceeded);
        Assert.False(result.TimedOut);
        Assert.Equal(100_000, result.Stdout.Length);
    }

    [Fact]
    public async Task FeedsStdin()
    {
        var result = await ProcessRunner.RunAsync(
            Sh("cat"), "hello\nworld", TimeSpan.FromSeconds(30), Max, CancellationToken.None);

        Assert.Equal("hello\nworld", result.StdoutText);
        Assert.Equal(0, result.ExitCode);
    }

    [Fact]
    public async Task BackgroundedGrandchildDoesNotHoldTheResultHostage()
    {
        // `sleep` inherits the pipes and outlives the shell.
        var watch = Stopwatch.StartNew();
        var result = await RunShAsync("sleep 30 & echo done", TimeSpan.FromSeconds(60));

        Assert.False(result.TimedOut);
        Assert.Equal("done", result.StdoutText.Trim());
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(15), $"took {watch.Elapsed}");
    }

    private static Task<ProcessResult> RunShAsync(string script, TimeSpan timeout) =>
        ProcessRunner.RunAsync(Sh(script), null, timeout, Max, CancellationToken.None);

    private static ProcessStartInfo Sh(string script)
    {
        var psi = new ProcessStartInfo("/bin/sh");
        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add(script);
        return psi;
    }

    /// <summary>Exited — gone, or a zombie nobody reaps (the test runner may be PID 1).</summary>
    private static async Task<bool> GoneAsync(int pid)
    {
        for (var i = 0; i < 50; i++)
        {
            try
            {
                var stat = await File.ReadAllTextAsync($"/proc/{pid}/stat");
                if (stat[(stat.LastIndexOf(')') + 2)..].StartsWith('Z'))
                {
                    return true;
                }
            }
            catch (IOException)
            {
                return true;
            }

            await Task.Delay(100);
        }

        return false;
    }
}
