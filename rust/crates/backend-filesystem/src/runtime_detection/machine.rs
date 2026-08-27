//! What this process knows about the machine it is detecting runtimes on.
//!
//! Every source of candidate locations is a FIELD here rather than a call to the
//! environment inside the search: the search then has no way to consult something a
//! caller did not give it, which is what makes a detection pass reproducible and
//! keeps a test off the developer's own installations.

use std::{env, path::PathBuf};

/// Which platform's conventions a detection pass follows.
///
/// A value rather than `cfg!`, because the two macOS-only sources — the system
/// `path_helper` and the app-bundle candidates — must be exercisable from a test on
/// any host, and because the product decides this at runtime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DetectionPlatform {
    MacOs,
    Other,
}

impl DetectionPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            DetectionPlatform::MacOs
        } else {
            DetectionPlatform::Other
        }
    }
}

/// macOS assembles the system-wide `PATH` with this helper.
const PATH_HELPER: &str = "/usr/libexec/path_helper";

/// Where to look for runtime executables, and under whose conventions.
#[derive(Clone, Debug)]
pub struct MachineFacts {
    pub platform: DetectionPlatform,
    /// `None` means no home-relative candidates: the process could not tell where
    /// home is, so it does not guess a path that would silently match nothing.
    pub home: Option<PathBuf>,
    /// The `PATH` this process inherited, verbatim.
    pub path_env: Option<String>,
    /// The login shell to ask for a `PATH`, when the platform needs asking.
    pub login_shell: Option<PathBuf>,
    pub path_helper: Option<PathBuf>,
    /// Whether to search the package-manager, system and version-manager locations
    /// beyond `PATH`. Off means "only what you were told", which is what lets a
    /// caller ask about a machine it fully describes.
    pub include_default_directories: bool,
}

impl MachineFacts {
    /// Read the machine this process is actually running on.
    ///
    /// The login shell and `path_helper` are macOS-only: that is where a
    /// desktop-launched process reliably inherits a `PATH` that has nothing a user
    /// installed in it, so that is where the product pays for asking. On other
    /// platforms the inherited `PATH` plus the default locations are the answer.
    pub fn for_this_process() -> Self {
        let platform = DetectionPlatform::current();
        let on_macos = platform == DetectionPlatform::MacOs;
        Self {
            platform,
            home: home_directory(),
            path_env: env::var("PATH").ok(),
            login_shell: on_macos
                .then(|| env::var_os("SHELL").map(PathBuf::from))
                .flatten(),
            path_helper: on_macos.then(|| PathBuf::from(PATH_HELPER)),
            include_default_directories: true,
        }
    }
}

/// Where this process's user's home is, or `None` when even the OS cannot say.
///
/// [`std::env::home_dir`] is the product's `os.homedir()`: `$HOME` when the process
/// has a usable one, and the OS's own account record otherwise. The fallback is not
/// theoretical — a desktop- or `launchd`-started process can inherit no `HOME` at
/// all, and reading only the environment would drop every home-relative location
/// (package managers, version managers) from the search path on exactly the machines
/// this crate exists to find runtimes on.
///
/// Whatever the source, the answer must be usable as a search root: an empty or
/// relative home is no answer, because joining candidates onto it would silently
/// produce paths relative to the process's working directory.
fn home_directory() -> Option<PathBuf> {
    usable_search_root(env::home_dir())
}

/// Whether an answer can be joined onto. Separate from where the answer CAME from,
/// so the rule is checkable without a process that has a different environment.
fn usable_search_root(home: Option<PathBuf>) -> Option<PathBuf> {
    let home = home?;
    if home.as_os_str().is_empty() || !home.is_absolute() {
        return None;
    }
    Some(home)
}

impl MachineFacts {
    /// The machine as described by `path_env` alone.
    #[cfg(test)]
    pub(super) fn only_searching(directory: &std::path::Path) -> Self {
        Self {
            platform: DetectionPlatform::Other,
            home: None,
            path_env: Some(directory.to_string_lossy().into_owned()),
            login_shell: None,
            path_helper: None,
            include_default_directories: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A home that cannot be joined onto is not a home. `.` is the one that matters:
    /// accepting it would turn every home-relative candidate into a path relative to
    /// the process's working directory.
    #[test]
    fn only_an_absolute_home_is_usable_as_a_search_root() {
        assert_eq!(usable_search_root(None), None);
        assert_eq!(usable_search_root(Some(PathBuf::new())), None);
        assert_eq!(usable_search_root(Some(PathBuf::from("."))), None);
        assert_eq!(
            usable_search_root(Some(PathBuf::from("relative/home"))),
            None
        );
        assert_eq!(
            usable_search_root(Some(PathBuf::from("/Users/someone"))),
            Some(PathBuf::from("/Users/someone"))
        );
    }

    /// The facts this process reports come from the OS's home answer, not from a bare
    /// `HOME` read — and where `HOME` is usable, that answer IS `HOME`, which is the
    /// preference half of `os.homedir()`. The other half is the API's own fallback to
    /// the account record, which is why the resolver calls it instead of the
    /// environment.
    #[test]
    fn the_home_this_process_reports_is_the_os_answer_and_prefers_a_usable_home_env() {
        let reported = MachineFacts::for_this_process().home;
        assert_eq!(reported, usable_search_root(env::home_dir()));

        if let Some(from_env) = env::var_os("HOME").map(PathBuf::from)
            && from_env.is_absolute()
        {
            assert_eq!(reported, Some(from_env));
        }
    }
}
