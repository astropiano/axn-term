using AxnTerm.Gateway;

namespace AxnTerm.Gateway.Tests;

public class SessionHostDataMountTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public void NoDataMountMeansNoUserDataDir(string? dataMount)
    {
        Assert.Null(SessionHostContainerService.UserDataDir(dataMount, "alice"));
        Assert.Equal("/tmp/axn-term", SessionHostContainerService.RebaseOntoUserDataDir("/tmp/axn-term", dataMount, null));
    }

    [Theory]
    [InlineData("/mnt/data", "/mnt/data/alice")]
    [InlineData("/mnt/data/", "/mnt/data/alice")]
    public void EachUserGetsItsOwnSubdirectory(string dataMount, string expected)
    {
        Assert.Equal(expected, SessionHostContainerService.UserDataDir(dataMount, "alice"));
        Assert.NotEqual(
            SessionHostContainerService.UserDataDir(dataMount, "alice"),
            SessionHostContainerService.UserDataDir(dataMount, "bob"));
    }

    [Theory]
    // compose defaults: PTY_CWD / SESSION_HOST_HOME = DATA_MOUNT,
    // AXN_STATE_DIR = DATA_MOUNT/.axn-term — all shared before.
    [InlineData("/mnt/data", "/mnt/data/alice")]
    [InlineData("/mnt/data/", "/mnt/data/alice")]
    [InlineData("/mnt/data/.axn-term", "/mnt/data/alice/.axn-term")]
    [InlineData("/mnt/data/projects/x", "/mnt/data/alice/projects/x")]
    // Paths outside DATA_MOUNT are container-local and stay put.
    [InlineData("/tmp", "/tmp")]
    [InlineData("/tmp/axn-term", "/tmp/axn-term")]
    [InlineData("/mnt/database", "/mnt/database")]
    public void PathsInDataMountMoveIntoTheUsersDirectory(string path, string expected)
    {
        var userDir = SessionHostContainerService.UserDataDir("/mnt/data", "alice");

        Assert.Equal(expected, SessionHostContainerService.RebaseOntoUserDataDir(path, "/mnt/data", userDir));
    }

    [Fact]
    public void TwoUsersNeverShareAStateDir()
    {
        const string dataMount = "/mnt/data";
        const string stateDir = "/mnt/data/.axn-term";

        var alice = SessionHostContainerService.RebaseOntoUserDataDir(
            stateDir, dataMount, SessionHostContainerService.UserDataDir(dataMount, "alice"));
        var bob = SessionHostContainerService.RebaseOntoUserDataDir(
            stateDir, dataMount, SessionHostContainerService.UserDataDir(dataMount, "bob"));

        Assert.NotEqual(alice, bob);
    }
}
