using System.Text;
using AxnTerm.SessionHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Porta.Pty;

namespace AxnTerm.SessionHost.Tests;

/// <summary>The PTY's single output pump and its subscribers.</summary>
public sealed class PtyOutputTests : IDisposable
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    private readonly string _dir = Directory.CreateTempSubdirectory("axn-pty-test").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public async Task EverySubscriberSeesAllOutput()
    {
        var host = NewHost();
        // Waits for a line so both subscribers are in place before output starts.
        var session = await host.SpawnAsync("fanout", "read x; seq 1 3000", null, 80, 24, CancellationToken.None);
        Assert.NotNull(session);

        var first = Collect(session!);
        var second = Collect(session!);
        await session!.Pty.WriterStream.WriteAsync("\n"u8.ToArray());
        await session.Pty.WriterStream.FlushAsync();

        var a = await first.Output.WaitAsync(Timeout);
        var b = await second.Output.WaitAsync(Timeout);
        Assert.Contains("\n2999\r\n3000", a);
        Assert.Equal(a, b);
        host.Remove("fanout");
    }

    [Fact]
    public async Task ReadErrorAfterExitIsEndOfOutput()
    {
        // Linux PTY masters fail reads with EIO once the shell is gone.
        var fake = new FakePty(new ThrowingStream("bye"u8.ToArray(), new IOException("Input/output error")));
        var session = NewSession(fake);

        var output = Collect(session);

        Assert.Equal("bye", await output.Output.WaitAsync(Timeout));
        Assert.Equal("bye", Encoding.UTF8.GetString(session.TailSnapshot()));
    }

    [Fact]
    public async Task SubscribingAfterExitEndsAtOnce()
    {
        var session = NewSession(new FakePty(new ThrowingStream([], new IOException("eio"))));
        await Collect(session).Output.WaitAsync(Timeout);

        var late = Collect(session);

        Assert.Equal("", await late.Output.WaitAsync(Timeout));
    }

    [Fact]
    public async Task AFailingSubscriberIsDroppedAndTheOthersKeepReceiving()
    {
        var gate = new TaskCompletionSource();
        var session = NewSession(new FakePty(new ThrowingStream("data"u8.ToArray(), new IOException("eio"), gate.Task)));
        var failed = 0;
        using var broken = session.SubscribeOutput(_ =>
        {
            failed++;
            throw new IOException("socket gone");
        }, _ => { });

        var output = Collect(session);
        gate.SetResult();

        Assert.Equal("data", await output.Output.WaitAsync(Timeout));
        Assert.Equal(1, failed);
    }

    [Fact]
    public void ThePtyIsDisposedOnce()
    {
        var fake = new FakePty(new ThrowingStream([], new IOException("eio")));
        var session = NewSession(fake);

        session.DisposePty();
        session.DisposePty();

        Assert.Equal(1, fake.Disposed);
    }

    [Theory]
    [InlineData("3f2c9a1e-8b7d-4c6e-9f00-1a2b3c4d5e6f", true)]
    [InlineData("sh-3f2c9a1e-8b7d", true)]
    [InlineData("lq1x2-abcde", true)]
    [InlineData("e2e_1.2", true)]
    [InlineData("", false)]
    [InlineData("..", false)]
    [InlineData(".hidden", false)]
    [InlineData("../../etc/cron.d/x", false)]
    [InlineData("a/b", false)]
    [InlineData("a\\b", false)]
    [InlineData("a b", false)]
    [InlineData("ä", false)]
    public void PtyIdsAreSafeFileNameParts(string id, bool valid)
    {
        Assert.Equal(valid, PtyHost.IsValidPtyId(id));
    }

    [Fact]
    public async Task SpawnRefusesAnIdThatWouldEscapeTheStateDir()
    {
        var host = NewHost();

        var session = await host.SpawnAsync("../escape", "true", null, 80, 24, CancellationToken.None);

        Assert.Null(session);
        Assert.Empty(host.Sessions);
    }

    private PtyHost NewHost()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PTY_USER"] = "root",
                ["PTY_CWD"] = _dir,
                ["AXN_STATE_DIR"] = Path.Combine(_dir, "state"),
            })
            .Build();
        return new PtyHost(configuration, NullLogger<PtyHost>.Instance, new ControlBroker());
    }

    private static PtySession NewSession(IPtyConnection pty) =>
        new() { Id = "fake", Pty = pty, StateFile = "/nonexistent", Cwd = "/" };

    private static (Task<string> Output, IDisposable Subscription) Collect(PtySession session)
    {
        var buffer = new MemoryStream();
        var done = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var subscription = session.SubscribeOutput(
            data =>
            {
                lock (buffer) buffer.Write(data.Span);
                return ValueTask.CompletedTask;
            },
            _ =>
            {
                lock (buffer) done.TrySetResult(Encoding.UTF8.GetString(buffer.ToArray()));
            });
        return (done.Task, subscription);
    }

    /// <summary>Yields <c>data</c> once, then throws like a Linux PTY master after exit.</summary>
    private sealed class ThrowingStream(byte[] data, Exception error, Task? gate = null) : Stream
    {
        private bool _sent;

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await (gate ?? Task.CompletedTask);
            if (_sent || data.Length == 0)
            {
                throw error;
            }
            _sent = true;
            data.CopyTo(buffer);
            return data.Length;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class FakePty(Stream reader) : IPtyConnection
    {
        public int Disposed;

        public Stream ReaderStream => reader;
        public Stream WriterStream => Stream.Null;
        public int Pid => 0;
        public int ExitCode => 0;
        public event EventHandler<PtyExitedEventArgs>? ProcessExited { add { } remove { } }
        public void Kill() { }
        public void Resize(int cols, int rows) { }
        public bool WaitForExit(int milliseconds) => true;
        public void Dispose() => Disposed++;
    }
}
