using Astropiano.AxnTerm.SessionHost;

namespace Astropiano.AxnTerm.SessionHost.Tests;

public class SessionHostAuthTests
{
    [Fact]
    public void OnlyTheMatchingSecretIsAuthorized()
    {
        Assert.True(SessionHostAuth.IsAuthorized("s3cret", "s3cret"));
        Assert.False(SessionHostAuth.IsAuthorized("s3cret", "s3cre"));
        Assert.False(SessionHostAuth.IsAuthorized("s3cret", "S3CRET"));
        Assert.False(SessionHostAuth.IsAuthorized("s3cret", ""));
        Assert.False(SessionHostAuth.IsAuthorized("s3cret", null));
    }

    [Fact]
    public void InsecureModeAdmitsEverything()
    {
        Assert.True(SessionHostAuth.IsAuthorized(null, null));
        Assert.True(SessionHostAuth.IsAuthorized(null, "anything"));
    }

    [Fact]
    public void MissingSecretFailsClosed()
    {
        Assert.Throws<InvalidOperationException>(() => SessionHostAuth.ResolveSecret(null, null));
        Assert.Throws<InvalidOperationException>(() => SessionHostAuth.ResolveSecret("", "0"));
        Assert.Null(SessionHostAuth.ResolveSecret(null, "1"));
        // A configured secret always wins over the opt-out.
        Assert.Equal("s3cret", SessionHostAuth.ResolveSecret("s3cret", "1"));
    }

    [Fact]
    public void SecretIsReadFromTheFileWhenTheEnvIsEmpty()
    {
        var file = Path.GetTempFileName();
        try
        {
            File.WriteAllText(file, "from-file\n");
            Assert.Equal("from-file", SessionHostAuth.ReadSecret(null, file));
            Assert.Equal("from-file", SessionHostAuth.ReadSecret("", file));
            Assert.Equal("from-env", SessionHostAuth.ReadSecret("from-env", file));
            Assert.Null(SessionHostAuth.ReadSecret(null, null));
        }
        finally
        {
            File.Delete(file);
        }
    }
}
