//! Git commands: repo detection and `git` exec helpers.


#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoInfo {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    group: Option<String>,
    branch: Option<String>,
    ahead: u32,
    behind: u32,
    dirty: bool,
    untracked: u32,
    remote_branch_missing: bool,
    root: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    remote: Option<String>,
}

pub(crate) fn run_git(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub(crate) fn parse_git_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let without_git = url.strip_suffix(".git").unwrap_or(url);
    let path = if let Some(at) = without_git.find('@') {
        let after_host = &without_git[at + 1..];
        after_host
            .find([':', '/'])
            .map(|i| &after_host[i + 1..])?
    } else if let Some(scheme) = without_git.find("://") {
        let after_scheme = &without_git[scheme + 3..];
        after_scheme.find('/').map(|i| &after_scheme[i + 1..])?
    } else {
        without_git
    };
    path.rsplit_once('/').map(|(g, n)| (g.to_string(), n.to_string()))
}

pub(crate) fn parse_git_status(
    output: &str,
    name: String,
    group: Option<String>,
    root: String,
    remote: Option<String>,
) -> Option<RepoInfo> {
    let mut lines = output.lines();
    let branch_line = lines.next()?;
    let rest = branch_line.strip_prefix("## ")?;

    // An unborn branch (fresh `git init`) is reported as `No commits yet on
    // <branch>` (`Initial commit on <branch>` before git 2.16).
    let rest = rest
        .strip_prefix("No commits yet on ")
        .or_else(|| rest.strip_prefix("Initial commit on "))
        .unwrap_or(rest);

    let branch: Option<String>;
    let mut remote_branch_missing = false;
    let mut ahead = 0u32;
    let mut behind = 0u32;

    // Detached HEAD is exactly `HEAD (no branch)` — a prefix match would
    // also swallow branches named e.g. `HEAD-fix`.
    if rest.starts_with("HEAD (no branch)") {
        branch = None;
    } else if let Some(dots) = rest.find("...") {
        branch = Some(rest[..dots].to_string());
        let tracking = &rest[dots + 3..];
        if tracking.contains("[gone]") {
            remote_branch_missing = true;
        }
        if let Some(pos) = tracking.find("ahead ") {
            let s = &tracking[pos + 6..];
            let n = s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>();
            ahead = n.parse::<u32>().unwrap_or(0);
        }
        if let Some(pos) = tracking.find("behind ") {
            let s = &tracking[pos + 7..];
            let n = s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>();
            behind = n.parse::<u32>().unwrap_or(0);
        }
    } else {
        branch = Some(rest.split_whitespace().next()?.to_string());
        remote_branch_missing = true;
    }

    let mut dirty = false;
    let mut untracked = 0u32;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if line.starts_with("??") {
            untracked += 1;
        } else {
            dirty = true;
        }
    }

    Some(RepoInfo {
        name,
        group,
        branch,
        ahead,
        behind,
        dirty,
        untracked,
        remote_branch_missing,
        root,
        remote,
    })
}

// `git status --porcelain --untracked-files=all` can take seconds on large
// repos — run off the main thread so repo refreshes cannot freeze the UI.
#[tauri::command]
pub(crate) async fn get_git_repo(cwd: String) -> Result<Option<RepoInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || get_git_repo_blocking(cwd))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn get_git_repo_blocking(cwd: String) -> Result<Option<RepoInfo>, String> {
    let path = std::path::PathBuf::from(cwd);
    if !path.is_dir() {
        return Ok(None);
    }
    let toplevel = match run_git(&path, &["rev-parse", "--show-toplevel"]) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return Ok(None),
    };
    if toplevel.is_empty() {
        return Ok(None);
    }
    let repo_root = std::path::Path::new(&toplevel);
    let name = repo_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let remote = run_git(&path, &["remote", "get-url", "origin"]).ok();
    let group = remote
        .as_deref()
        .and_then(parse_git_remote)
        .map(|(g, _)| g);

    let status_output = match run_git(
        &path,
        &["status", "--porcelain", "--branch", "--untracked-files=all"],
    ) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };

    match parse_git_status(&status_output, name, group, toplevel, remote) {
        Some(info) => Ok(Some(info)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod git_status_tests {
    use super::*;

    fn parse(output: &str) -> RepoInfo {
        parse_git_status(output, "r".into(), None, "/r".into(), None).unwrap()
    }

    #[test]
    fn tracking_branch_with_counts() {
        let info = parse("## main...origin/main [ahead 2, behind 1]\n M a\n?? b\n");
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!((info.ahead, info.behind), (2, 1));
        assert!(info.dirty);
        assert_eq!(info.untracked, 1);
        assert!(!info.remote_branch_missing);
    }

    #[test]
    fn detached_head_has_no_branch() {
        assert_eq!(parse("## HEAD (no branch)\n").branch, None);
    }

    #[test]
    fn head_prefixed_branch_name_is_a_branch() {
        let info = parse("## HEAD-fix\n");
        assert_eq!(info.branch.as_deref(), Some("HEAD-fix"));
        assert!(info.remote_branch_missing);
    }

    #[test]
    fn unborn_branch_reports_its_name() {
        assert_eq!(parse("## No commits yet on main\n").branch.as_deref(), Some("main"));
        assert_eq!(parse("## Initial commit on master\n").branch.as_deref(), Some("master"));
    }
}
