//! Asking a local executable what it is, with a bounded wait.
//!
//! ## A version answer is whatever the binary printed
//!
//! The product reports the first `<major>.<minor>[.<patch>]` token found in the
//! output; failing that, the first line verbatim; failing that, nothing. So a
//! runtime whose `--version` prints a banner is reported as present with that banner
//! as its version — the field is what the binary said about itself, not a parsed
//! semantic version, and narrowing it here would report installed runtimes as
//! unverified.
//!
//! Standard error is read as a fallback for standard output because several of these
//! CLIs print their version there. The exit status is deliberately ignored: a
//! runtime that answers and then exits non-zero has still answered.
//!
//! ## The deadline is the whole failure model
//!
//! One of these binaries is a Node wrapper that re-spawns a native executable after
//! a cold dyld start, empirically 10–22s. The budget is therefore 30s — long enough
//! for the slowest wrapper the product has seen, and bounded so a hung binary cannot
//! hold a detection pass open. At the deadline the child is killed; a spawn that
//! never started, a kill, and unreadable output are all "no answer", never a
//! partially-read one.

use std::{path::Path, process::Stdio, time::Duration};

use tokio::{process::Command, time::timeout};

/// What a finished child printed, and how it exited. `code` is `None` when a signal
/// ended it, which callers that require success treat as failure.
pub(super) struct CommandOutput {
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

/// See the module note: long enough for the slowest observed wrapper cold start.
const VERSION_TIMEOUT: Duration = Duration::from_secs(30);

/// Run `program args…`, or `None` if it could not be started or did not finish in
/// time.
///
/// `stdin` is closed so a binary that prompts cannot wait forever on a terminal it
/// does not have, and the child is killed when this future is dropped — which is how
/// the deadline is enforced.
pub(super) async fn run_command(
    program: &Path,
    args: &[&str],
    budget: Duration,
) -> Option<CommandOutput> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command.spawn().ok()?;
    let finished = timeout(budget, child.wait_with_output()).await.ok()?.ok()?;
    Some(CommandOutput {
        code: finished.status.code(),
        stdout: String::from_utf8_lossy(&finished.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&finished.stderr).into_owned(),
    })
}

/// What `binary --version` says about itself, or `None` when it says nothing.
pub(super) async fn probe_version(binary: &Path) -> Option<String> {
    let output = run_command(binary, &["--version"], VERSION_TIMEOUT).await?;
    // Standard output wins whenever it produced anything at all — including
    // whitespace, which then trims to nothing and reports no version rather than
    // silently switching to the other stream.
    let printed = if output.stdout.is_empty() {
        output.stderr
    } else {
        output.stdout
    };
    let printed = printed.trim();
    if let Some(token) = version_token(printed) {
        return Some(token.to_string());
    }
    let first_line = printed.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() {
        None
    } else {
        Some(first_line.to_string())
    }
}

/// The leftmost `<digits>.<digits>[.<digits>]` in `text`.
///
/// Hand-rolled because the workspace has no regular-expression dependency and this
/// is the only pattern it would be for. Greedy digit runs need no backtracking here:
/// a shorter run would leave a digit where a `.` is required, so it cannot match
/// either.
fn version_token(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() {
            continue;
        }
        let major = digit_run_end(bytes, start);
        if bytes.get(major) != Some(&b'.') {
            continue;
        }
        let minor = digit_run_end(bytes, major + 1);
        if minor == major + 1 {
            continue;
        }
        let mut end = minor;
        if bytes.get(minor) == Some(&b'.') {
            let patch = digit_run_end(bytes, minor + 1);
            if patch > minor + 1 {
                end = patch;
            }
        }
        return Some(&text[start..end]);
    }
    None
}

fn digit_run_end(bytes: &[u8], from: usize) -> usize {
    let mut end = from;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_version_shaped_token_wins_wherever_it_sits() {
        assert_eq!(version_token("1.2.3"), Some("1.2.3"));
        assert_eq!(version_token("claude 1.2.3 (build 9)"), Some("1.2.3"));
        assert_eq!(version_token("v0.44"), Some("0.44"));
        assert_eq!(version_token("2026.10.1-beta.4"), Some("2026.10.1"));
        // Four segments are not four: the token stops after the patch, as the
        // product's pattern does.
        assert_eq!(version_token("1.2.3.4"), Some("1.2.3"));
    }

    #[test]
    fn text_without_two_dotted_numbers_has_no_version_token() {
        assert_eq!(version_token(""), None);
        assert_eq!(version_token("qodercli"), None);
        assert_eq!(version_token("12"), None);
        assert_eq!(version_token("12."), None);
        assert_eq!(version_token("12.x"), None);
        assert_eq!(version_token("build 7"), None);
    }
}
