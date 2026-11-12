//! Runs external programs (the Docker CLI, OS package managers, service managers) with argument
//! vectors only: never a shell, never a command line built by concatenating strings.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

/// Output kept per stream; `docker logs --tail` and installers stay far below it.
const MAX_CAPTURE: usize = 1 << 20;
pub(crate) const MASK: &str = "********";

/// Cancellation shared between a running provisioning and `cancel_provisioning`.
#[derive(Default)]
pub(crate) struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancel {
    pub(crate) fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub(crate) async fn cancelled(&self) {
        loop {
            // Register before checking, so a cancel between the two isn't missed
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    /// Sleeps for `duration`, or returns early (false) when cancelled.
    pub(crate) async fn sleep(&self, duration: Duration) -> bool {
        tokio::select! {
            () = tokio::time::sleep(duration) => !self.is_cancelled(),
            () = self.cancelled() => false,
        }
    }
}

/// One program invocation. `env` sets variables on the child only (how secrets reach `docker
/// create -e NAME` without appearing in its arguments); `stdin` is written then closed.
pub(crate) struct Cmd {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub stdin: Option<String>,
    pub timeout: Duration,
}

impl Cmd {
    #[cfg(test)]
    pub(crate) fn new(program: impl Into<PathBuf>, args: &[&str]) -> Self {
        Self {
            program: program.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            env: Vec::new(),
            stdin: None,
            timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug)]
pub(crate) struct Output {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, PartialEq)]
pub(crate) enum RunError {
    /// The program isn't installed (or not on PATH).
    NotFound,
    Io(String),
    Cancelled,
    TimedOut,
}

fn push_capped(buffer: &mut String, line: &str) {
    if buffer.len() < MAX_CAPTURE {
        buffer.push_str(line);
        buffer.push('\n');
    }
}

/// Runs `cmd`, calling `on_line` with each line of stdout and stderr as it arrives.
/// The child is killed on timeout, on cancel, and if this future is dropped.
pub(crate) async fn run(
    cmd: &Cmd,
    cancel: Option<&Cancel>,
    mut on_line: impl FnMut(&str),
) -> Result<Output, RunError> {
    let mut command = Command::new(&cmd.program);
    command
        .args(&cmd.args)
        .envs(cmd.env.iter().map(|(k, v)| (k, v)))
        .stdin(if cmd.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // No console window flashing up for every docker call
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = command.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => RunError::NotFound,
        _ => RunError::Io(e.to_string()),
    })?;
    if let (Some(input), Some(mut stdin)) = (&cmd.stdin, child.stdin.take()) {
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|e| RunError::Io(e.to_string()))?;
        // Dropping closes it, so the program sees end of input
    }

    let mut out = BufReader::new(child.stdout.take().expect("piped")).split(b'\n');
    let mut err = BufReader::new(child.stderr.take().expect("piped")).split(b'\n');
    let (mut stdout, mut stderr) = (String::new(), String::new());
    let (mut out_done, mut err_done) = (false, false);
    let deadline = tokio::time::sleep(cmd.timeout);
    tokio::pin!(deadline);
    let cancelled = async {
        match cancel {
            Some(c) => c.cancelled().await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(cancelled);

    let text = |bytes: Vec<u8>| {
        let line = String::from_utf8_lossy(&bytes).into_owned();
        line.trim_end_matches('\r').to_owned()
    };
    loop {
        if out_done && err_done {
            break;
        }
        tokio::select! {
            segment = out.next_segment(), if !out_done => match segment {
                Ok(Some(bytes)) => {
                    let line = text(bytes);
                    on_line(&line);
                    push_capped(&mut stdout, &line);
                }
                _ => out_done = true,
            },
            segment = err.next_segment(), if !err_done => match segment {
                Ok(Some(bytes)) => {
                    let line = text(bytes);
                    on_line(&line);
                    push_capped(&mut stderr, &line);
                }
                _ => err_done = true,
            },
            () = &mut deadline => {
                let _ = child.kill().await;
                return Err(RunError::TimedOut);
            }
            () = &mut cancelled => {
                let _ = child.kill().await;
                return Err(RunError::Cancelled);
            }
        }
    }
    let status = tokio::select! {
        status = child.wait() => status.map_err(|e| RunError::Io(e.to_string()))?,
        () = &mut deadline => {
            let _ = child.kill().await;
            return Err(RunError::TimedOut);
        }
    };
    Ok(Output {
        success: status.success(),
        code: status.code(),
        stdout,
        stderr,
    })
}

/// Runs `cmd` without streaming.
pub(crate) async fn output(cmd: &Cmd) -> Result<Output, RunError> {
    run(cmd, None, |_| {}).await
}

/// Replaces every secret in `text` with a mask, then masks password forms the audit log knows
/// (`password=…`, URLs with a password, `IDENTIFIED BY '…'`).
pub(crate) fn mask(text: &str, secrets: &[&str]) -> String {
    let mut masked = text.to_owned();
    for secret in secrets.iter().filter(|s| s.len() >= 4) {
        masked = masked.replace(secret, MASK);
    }
    crate::audit::redact(&masked)
}

/// Finds `name` on PATH, then in `extra` directories. GUI apps on macOS start with a minimal
/// PATH, so Docker and Homebrew are also looked for where their installers put them.
pub(crate) fn find_program(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    let path: OsString = std::env::var_os("PATH").unwrap_or_default();
    let names: Vec<String> = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            name.to_owned(),
        ]
    } else {
        vec![name.to_owned()]
    };
    std::env::split_paths(&path)
        .chain(extra.iter().cloned())
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        // symlink_metadata too: winget is an app execution alias, which metadata() can't follow
        .find(|p| p.is_file() || std::fs::symlink_metadata(p).is_ok_and(|m| !m.is_dir()))
}

/// Quotes an argument for display only (the consent dialog); commands never go through a shell.
pub(crate) fn display_arg(arg: &str) -> String {
    if arg.is_empty() || arg.contains([' ', '"', '\'']) {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_owned()
    }
}

pub(crate) fn display_command(program: &Path, args: &[String]) -> String {
    let name = program.file_stem().map_or_else(
        || program.display().to_string(),
        |s| s.to_string_lossy().into_owned(),
    );
    std::iter::once(name)
        .chain(args.iter().map(|a| display_arg(a)))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_secrets_and_password_forms() {
        let text = "init: password Xy7-secret-9 set; url postgres://a:other@h/db";
        let masked = mask(text, &["Xy7-secret-9", ""]);
        assert!(!masked.contains("Xy7-secret-9"));
        assert!(!masked.contains("other"));
        assert!(masked.contains(MASK));
    }

    #[test]
    fn quotes_arguments_for_display() {
        let args = vec![
            "install".into(),
            "--override".into(),
            "--mode unattended".into(),
        ];
        assert_eq!(
            display_command(Path::new("winget"), &args),
            r#"winget install --override "--mode unattended""#
        );
    }

    #[tokio::test]
    async fn reports_a_missing_program() {
        let cmd = Cmd::new("qlueprint-no-such-program", &[]);
        assert_eq!(output(&cmd).await.unwrap_err(), RunError::NotFound);
    }

    #[tokio::test]
    async fn cancels_a_running_program() {
        let cancel = Cancel::default();
        cancel.cancel();
        assert!(cancel.is_cancelled());
        assert!(!cancel.sleep(Duration::from_secs(5)).await);
    }
}
