//! `axn-term` CLI subcommands, handled before the Tauri app starts.
//!
//! `install`/`uninstall` copy the bundled agent skills (embedded via
//! `include_str!`, so the packaged binary is self-contained) into agent skill
//! directories — the same scheme as `axn-dev install`. `session` runs an
//! `axn-*` command for the terminal it is invoked from, over the app's
//! control socket (`control.rs`).

use std::fs;
use std::path::{Path, PathBuf};

struct Agent {
    name: &'static str,
    /// User-level skills dir under $HOME (None = project-level only).
    personal_subdir: Option<&'static str>,
    /// Repo/project-level skills dir.
    project_subdir: &'static str,
    /// Marker dirs under $HOME that prove the agent is in use.
    detect_home: &'static [&'static str],
    /// Marker dirs under the cwd that prove the agent is in use.
    detect_cwd: &'static [&'static str],
}

const AGENTS: &[Agent] = &[
    Agent {
        name: "claude",
        personal_subdir: Some(".claude/skills"),
        project_subdir: ".claude/skills",
        detect_home: &[".claude"],
        detect_cwd: &[".claude"],
    },
    Agent {
        name: "openclaw",
        personal_subdir: Some(".openclaw/skills"),
        project_subdir: ".openclaw/skills",
        detect_home: &[".openclaw"],
        detect_cwd: &[".openclaw"],
    },
    Agent {
        name: "codex",
        personal_subdir: Some(".codex/skills"),
        project_subdir: ".codex/skills",
        detect_home: &[".codex"],
        detect_cwd: &[".codex"],
    },
    Agent {
        name: "cursor",
        personal_subdir: None,
        project_subdir: ".cursor/skills",
        detect_home: &[],
        detect_cwd: &[".cursor"],
    },
    Agent {
        name: "devin",
        personal_subdir: Some(".config/devin/skills"),
        project_subdir: ".devin/skills",
        detect_home: &[".config/devin", ".devin"],
        detect_cwd: &[".devin", ".agents"],
    },
];

/// Skill name → (file name, contents) pairs, embedded into the binary.
struct EmbeddedSkill {
    name: &'static str,
    files: &'static [(&'static str, &'static str)],
}

const SKILLS: &[EmbeddedSkill] = &[
    EmbeddedSkill {
        name: "axn-term-agent-tasks",
        files: &[(
            "SKILL.md",
            include_str!("../skills/axn-term-agent-tasks/SKILL.md"),
        )],
    },
    EmbeddedSkill {
        name: "axn-term",
        files: &[("SKILL.md", include_str!("../skills/axn-term/SKILL.md"))],
    },
];

const HELP: &str = "\
axn-term — terminal application

Usage:
  axn-term                            Start the app (default)
  axn-term install <target> [opts]    Install bundled agent skills
  axn-term uninstall <target> [opts]  Remove installed skills
  axn-term session summary [text]     Set this terminal's session summary (no text clears it)
  axn-term session rename [name]      Rename this terminal's session (no name resets it)
  axn-term session focus [tab]        Bring a view of this session to the front
  axn-term session set <flags…>       Update this session (--summary, --name/--title)
  axn-term session create [path]      Open a new session (same flags as `axn-session create`)
  axn-term session command <axn-…>    Run any axn-* or plugin command for this session
  axn-term command [--window <label>] <axn-…>
                                      Run an app-level command (e.g. axn-views open <url>)
                                      from any process, in the focused window by default
  axn-term --help                     Show this help
  axn-term --version                  Print the version

Targets:
  --skill <name>      Install a specific skill by name
  --skills            Install all bundled skills

Options:
  --project           Install at project level into the cwd (default: personal/global)
  --repo <path>       Install into a repo's .agents folder (standard agent skills)
  --devin             Use Devin-specific paths (.devin/skills in repo, ~/.config/devin/skills)
  --agent <name>      Install only for one agent (claude, openclaw, codex, cursor, devin)
  --all-agents        Install for all agents (default: detected agents)

Examples:
  axn-term install --skills
  axn-term install --skills --project
  axn-term install --skills --agent claude
  axn-term install --skills --repo /path/to/repo            # .agents
  axn-term install --skills --repo /path/to/repo --devin    # .devin/skills
  axn-term install --skills --devin                         # ~/.config/devin/skills
";

/// Entry point from `main()`. Returns `Some(exit_code)` when the invocation is
/// a CLI command, `None` when the GUI should start.
pub fn run_cli(args: &[String]) -> Option<i32> {
    match args.first()?.as_str() {
        "install" => Some(run_install(&args[1..], false)),
        "uninstall" => Some(run_install(&args[1..], true)),
        "session" => Some(run_session(&args[1..])),
        "command" => Some(run_command(&args[1..])),
        "--help" | "-h" | "help" => {
            print!("{HELP}");
            Some(0)
        }
        "--version" | "-V" | "version" => {
            println!("axn-term {}", env!("CARGO_PKG_VERSION"));
            Some(0)
        }
        // Options and paths/URLs (a launcher passing %u, macOS -psn_…) start
        // the app; a bare word is a mistyped subcommand, not a second GUI.
        word if looks_like_command(word) => {
            eprintln!("axn-term: unknown command '{word}'\n");
            eprint!("{HELP}");
            Some(2)
        }
        _ => None,
    }
}

fn looks_like_command(arg: &str) -> bool {
    !arg.is_empty()
        && !arg.starts_with('-')
        && !arg.contains(['/', '\\', ':', '.', '%'])
        && !Path::new(arg).exists()
}

struct InstallArgs {
    skills: Vec<&'static EmbeddedSkill>,
    project: bool,
    devin: bool,
    all_agents: bool,
    agent: Option<String>,
    repo: Option<PathBuf>,
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    args.iter()
        .find_map(|a| a.strip_prefix(&prefix).map(String::from))
        .or_else(|| {
            args.iter()
                .position(|a| a == name)
                .and_then(|i| args.get(i + 1))
                .cloned()
        })
}

fn parse_install_args(args: &[String]) -> Result<InstallArgs, String> {
    let mut skills: Vec<&'static EmbeddedSkill> = Vec::new();
    let mut positional: Option<&str> = None;
    for a in args {
        if !a.starts_with('-') {
            if positional.is_none() {
                positional = Some(a.as_str());
            }
            continue;
        }
        match a.as_str() {
            "--skills" => skills = SKILLS.iter().collect(),
            "--project" | "--devin" | "--all-agents" => {}
            "--skill" => {}
            _ if a.starts_with("--skill=") => {}
            _ if a.starts_with("--agent") || a.starts_with("--repo") => {}
            _ => return Err(format!("unknown option '{a}'")),
        }
    }

    if skills.is_empty() {
        let name = flag_value(args, "--skill")
            .or_else(|| positional.filter(|p| !p.starts_with('-')).map(String::from));
        let name = name.ok_or_else(|| {
            "missing target — use --skills or --skill <name>".to_string()
        })?;
        match SKILLS.iter().find(|s| s.name == name) {
            Some(skill) => skills.push(skill),
            None => {
                return Err(format!(
                    "unknown skill '{name}' (available: {})",
                    SKILLS.iter().map(|s| s.name).collect::<Vec<_>>().join(", ")
                ))
            }
        }
    }

    Ok(InstallArgs {
        skills,
        project: args.iter().any(|a| a == "--project"),
        devin: args.iter().any(|a| a == "--devin"),
        all_agents: args.iter().any(|a| a == "--all-agents"),
        agent: flag_value(args, "--agent"),
        repo: flag_value(args, "--repo").map(PathBuf::from),
    })
}

fn agent_detected(agent: &Agent, cwd: &Path) -> bool {
    let home = dirs::home_dir();
    agent
        .detect_home
        .iter()
        .any(|d| home.as_ref().is_some_and(|h| h.join(d).exists()))
        || agent.detect_cwd.iter().any(|d| cwd.join(d).exists())
}

fn install_skill(skill: &EmbeddedSkill, target_base: &Path, label: &str, remove: bool) {
    let target = target_base.join(skill.name);
    if remove {
        if target.exists() {
            match fs::remove_dir_all(&target) {
                Ok(()) => println!("Removed {label}: {}", target.display()),
                Err(e) => eprintln!("  failed to remove {}: {e}", target.display()),
            }
        }
        return;
    }
    println!("Installing to {label}: {}", target.display());
    if let Err(e) = fs::create_dir_all(&target) {
        eprintln!("  failed to create {}: {e}", target.display());
        return;
    }
    for (file, contents) in skill.files {
        if let Err(e) = fs::write(target.join(file), contents) {
            eprintln!("  failed to write {file}: {e}");
        }
    }
    println!("  installed");
}

/// Shared by `install` and `uninstall` (`remove = true`).
fn run_install(args: &[String], remove: bool) -> i32 {
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{HELP}");
        return 0;
    }
    let parsed = match parse_install_args(args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("axn-term install: {e}");
            return 2;
        }
    };

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let use_agents_repo =
        parsed.repo.is_some() && parsed.agent.is_none() && !parsed.devin && !parsed.all_agents;

    let agents: Vec<&Agent> = if let Some(name) = &parsed.agent {
        match AGENTS.iter().find(|a| a.name == name.as_str()) {
            Some(a) => vec![a],
            None => {
                eprintln!(
                    "axn-term install: unknown agent '{name}' (available: {})",
                    AGENTS.iter().map(|a| a.name).collect::<Vec<_>>().join(", ")
                );
                return 2;
            }
        }
    } else if parsed.devin {
        AGENTS.iter().filter(|a| a.name == "devin").collect()
    } else if parsed.all_agents {
        AGENTS.iter().collect()
    } else if parsed.repo.is_none() {
        AGENTS.iter().filter(|a| agent_detected(a, &cwd)).collect()
    } else {
        AGENTS.iter().collect()
    };

    if !use_agents_repo && agents.is_empty() {
        println!("No agents detected. Use --agent <name> or --all-agents to force installation.");
        return 0;
    }

    for skill in &parsed.skills {
        println!("\n{} {}...", if remove { "Removing" } else { "Installing" }, skill.name);

        if use_agents_repo {
            let repo = parsed.repo.as_ref().unwrap();
            install_skill(skill, &repo.join(".agents"), "repo .agents", remove);
            continue;
        }

        for agent in &agents {
            let base = if let Some(repo) = &parsed.repo {
                repo.join(agent.project_subdir)
            } else if parsed.project {
                cwd.join(agent.project_subdir)
            } else {
                match agent.personal_subdir.and_then(|s| dirs::home_dir().map(|h| h.join(s))) {
                    Some(p) => p,
                    None => {
                        println!("Skipping {}: no personal-level installation", agent.name);
                        continue;
                    }
                }
            };
            let label = if parsed.repo.is_some() {
                format!("{} (repo)", agent.name)
            } else if parsed.project {
                format!("{} (project)", agent.name)
            } else {
                format!("{} (personal)", agent.name)
            };
            install_skill(skill, &base, &label, remove);
        }
    }

    if !remove {
        println!("\nDone. Restart your AI agent to load the skill.");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn gui_when_no_args_options_or_paths() {
        assert_eq!(run_cli(&args(&[])), None);
        assert_eq!(run_cli(&args(&["--gtk-flag"])), None);
        assert_eq!(run_cli(&args(&["-psn_0_12345"])), None);
        assert_eq!(run_cli(&args(&["some-file.txt"])), None);
        assert_eq!(run_cli(&args(&["/home/me/project"])), None);
        assert_eq!(run_cli(&args(&["axn-term://open"])), None);
        assert_eq!(run_cli(&args(&["src"])), None, "an existing path");
    }

    #[test]
    fn a_mistyped_subcommand_is_an_error_not_a_second_gui() {
        assert_eq!(run_cli(&args(&["sesion", "summary"])), Some(2));
        assert_eq!(run_cli(&args(&["instal"])), Some(2));
    }

    #[test]
    fn cli_subcommands_return_exit_codes() {
        assert_eq!(run_cli(&args(&["--help"])), Some(0));
        assert_eq!(run_cli(&args(&["--version"])), Some(0));
        assert_eq!(run_cli(&args(&["install"])), Some(0));
        assert_eq!(run_cli(&args(&["install", "--bogus"])), Some(2));
        assert_eq!(run_cli(&args(&["install", "--skill", "nope"])), Some(2));
    }

    #[test]
    fn parses_skill_selection() {
        let p = parse_install_args(&args(&["--skills"])).unwrap();
        assert_eq!(p.skills.len(), SKILLS.len());

        let p = parse_install_args(&args(&["--skill", "axn-term-agent-tasks"])).unwrap();
        assert_eq!(p.skills.len(), 1);
        assert_eq!(p.skills[0].name, "axn-term-agent-tasks");

        let p = parse_install_args(&args(&["--skill=axn-term-agent-tasks"])).unwrap();
        assert_eq!(p.skills.len(), 1);
    }

    #[test]
    fn parses_target_flags() {
        let p = parse_install_args(&args(&[
            "--skills",
            "--repo",
            "/tmp/x",
            "--agent=devin",
        ]))
        .unwrap();
        assert_eq!(p.repo, Some(PathBuf::from("/tmp/x")));
        assert_eq!(p.agent.as_deref(), Some("devin"));

        let p = parse_install_args(&args(&["--skills", "--project", "--devin"])).unwrap();
        assert!(p.project && p.devin && p.agent.is_none());
    }
}

/// The command line `axn-term session <sub> …` stands for. Arguments join
/// verbatim — the hidden commands parse the rest of the line themselves
/// (summary/rename take it whole, matching outer quotes stripped).
fn session_line(args: &[String]) -> Result<String, String> {
    let (sub, rest) = args.split_first().ok_or("usage: axn-term session <summary|rename|focus|set|create|command> …")?;
    let command = match sub.as_str() {
        "summary" => "axn-session-summary".to_string(),
        "rename" => "axn-rename".to_string(),
        "focus" => "axn-focus".to_string(),
        "set" => "axn-session set".to_string(),
        "create" => "axn-session create".to_string(),
        "command" => {
            let (cmd, rest) = rest.split_first().ok_or("usage: axn-term session command <axn-command> [args…]")?;
            if !cmd.starts_with("axn-") {
                return Err(format!("not an axn-term command: {cmd}"));
            }
            return Ok(std::iter::once(cmd.as_str()).chain(rest.iter().map(String::as_str)).collect::<Vec<_>>().join(" "));
        }
        other => return Err(format!("unknown session command: {other}")),
    };
    Ok(std::iter::once(command.as_str()).chain(rest.iter().map(String::as_str)).collect::<Vec<_>>().join(" "))
}

/// `axn-term command [--window <label>] <axn-command> [args…]`.
fn app_request(args: &[String]) -> Result<crate::control::AppRequest, String> {
    const USAGE: &str = "usage: axn-term command [--window <label>] <axn-command> [args…]";
    let (window, rest) = match args.split_first() {
        Some((flag, rest)) if flag == "--window" => {
            let (label, rest) = rest.split_first().ok_or(USAGE)?;
            (Some(label.clone()), rest)
        }
        _ => (None, args),
    };
    let (cmd, _) = rest.split_first().ok_or(USAGE)?;
    if !cmd.starts_with("axn-") {
        return Err(format!("not an axn-term command: {cmd}"));
    }
    Ok(crate::control::AppRequest { line: rest.join(" "), window })
}

fn state_dir() -> PathBuf {
    std::env::var("AXN_TERM_CONTROL_DIR")
        .or_else(|_| std::env::var("AXN_TERM_STATE_DIR"))
        .map(PathBuf::from)
        .or_else(|_| dirs::home_dir().map(|h| h.join(".axn-term")).ok_or(()))
        .unwrap_or_default()
}

#[cfg(unix)]
fn run_command(args: &[String]) -> i32 {
    let request = match app_request(args) {
        Ok(request) => request,
        Err(e) => {
            eprintln!("axn-term command: {e}");
            return 2;
        }
    };
    match crate::control::send_app(&crate::control::socket_path(&state_dir()), &request) {
        Ok(reply) if reply.ok => {
            if let Some(message) = reply.message {
                println!("{message}");
            }
            0
        }
        Ok(reply) => {
            eprintln!("axn-term command: {}", reply.error.unwrap_or_else(|| "failed".into()));
            1
        }
        Err(e) => {
            eprintln!("axn-term command: {e}");
            1
        }
    }
}

#[cfg(not(unix))]
fn run_command(_args: &[String]) -> i32 {
    eprintln!("axn-term command: not supported on this platform");
    2
}

#[cfg(unix)]
fn run_session(args: &[String]) -> i32 {
    let line = match session_line(args) {
        Ok(line) => line,
        Err(e) => {
            eprintln!("axn-term session: {e}");
            return 2;
        }
    };
    let (Ok(pty), Ok(secret)) = (std::env::var("AXN_TERM_PTY_ID"), std::env::var("AXN_TERM_PTY_SECRET")) else {
        eprintln!("axn-term session: not inside an axn-term terminal (AXN_TERM_PTY_ID/AXN_TERM_PTY_SECRET unset)");
        return 2;
    };
    let request = crate::control::ControlRequest { pty, secret, line };
    match crate::control::send(&crate::control::socket_path(&state_dir()), &request) {
        Ok(reply) if reply.ok => {
            if let Some(message) = reply.message {
                println!("{message}");
            }
            0
        }
        Ok(reply) => {
            eprintln!("axn-term session: {}", reply.error.unwrap_or_else(|| "failed".into()));
            1
        }
        Err(e) => {
            eprintln!("axn-term session: {e}");
            1
        }
    }
}

#[cfg(not(unix))]
fn run_session(_args: &[String]) -> i32 {
    eprintln!("axn-term session: not supported on this platform");
    2
}

#[cfg(test)]
mod session_tests {
    use super::session_line;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn maps_subcommands_to_hidden_command_lines() {
        assert_eq!(session_line(&args(&["summary", "fixing the build"])).unwrap(), "axn-session-summary fixing the build");
        assert_eq!(session_line(&args(&["summary"])).unwrap(), "axn-session-summary");
        assert_eq!(session_line(&args(&["rename", "api", "work"])).unwrap(), "axn-rename api work");
        assert_eq!(session_line(&args(&["set", "--summary", "wip"])).unwrap(), "axn-session set --summary wip");
        assert_eq!(session_line(&args(&["create", "src"])).unwrap(), "axn-session create src");
        assert_eq!(session_line(&args(&["command", "axn-workflow", "move", "review"])).unwrap(), "axn-workflow move review");
    }

    #[test]
    fn app_command_takes_an_optional_window() {
        let r = super::app_request(&args(&["--window", "w-2", "axn-views", "open", "http://x/", "MR"])).unwrap();
        assert_eq!(r.window.as_deref(), Some("w-2"));
        assert_eq!(r.line, "axn-views open http://x/ MR");
        let r = super::app_request(&args(&["axn-views", "current"])).unwrap();
        assert!(r.window.is_none());
        assert_eq!(r.line, "axn-views current");
    }

    #[test]
    fn app_command_refuses_non_axn_lines_and_a_missing_window() {
        assert!(super::app_request(&args(&["rm", "-rf", "/"])).is_err());
        assert!(super::app_request(&args(&["--window"])).is_err());
        assert!(super::app_request(&args(&[])).is_err());
    }

    #[test]
    fn refuses_anything_but_axn_commands() {
        assert!(session_line(&args(&["command", "rm", "-rf", "/"])).is_err());
        assert!(session_line(&args(&["bogus"])).is_err());
        assert!(session_line(&args(&[])).is_err());
    }
}
