//! Secret values whose plaintext cannot reach a log or a wire by accident.
//!
//! The guarantee is structural, not procedural: this type derives no `Debug` and
//! no `Serialize`, so "it slipped into a log line" and "it slipped into a
//! response body" are compile errors rather than review findings. Reading the
//! plaintext requires calling a method whose name says what it does.

use std::fmt;

/// A wrapper whose plaintext is only reachable through [`Secret::expose`].
///
/// Deliberately absent: `Debug` / `Serialize` derives, `Display`, `AsRef<str>`,
/// `Deref` — each would reintroduce an implicit path from the value to an output
/// stream. Also deliberately absent, and for a different reason:
///
/// * `Clone` — copying a secret should be a decision, not a default.
/// * `PartialEq` / `Eq` — a generic equality on secrets invites ordinary,
///   non-constant-time comparison of tokens and password material. A secret that
///   genuinely needs verification should expose a **named constant-time
///   verifier** for its own semantics instead.
///
/// If a concrete secret later needs one of these, it gets it explicitly, for that
/// secret, with the reason written down.
pub struct Secret<T> {
    value: T,
}

/// What `{:?}` prints instead of the plaintext.
pub const REDACTED: &str = "<redacted>";

impl<T> Secret<T> {
    pub fn new(value: T) -> Self {
        Self { value }
    }

    /// The one named escape hatch. Call sites are greppable on purpose.
    pub fn expose(&self) -> &T {
        &self.value
    }

    pub fn into_inner(self) -> T {
        self.value
    }
}

/// Manual and lossy: a secret is still debuggable as a *presence*, never as a
/// value. Without this impl a secret inside a larger struct would simply block
/// that struct from deriving `Debug`, which pushes callers toward removing the
/// wrapper.
impl<T> fmt::Debug for Secret<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("Secret")
            .field(&format_args!("{REDACTED}"))
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    #[expect(dead_code, reason = "fields are read only through the Debug rendering")]
    struct Credentials {
        user: String,
        token: Secret<String>,
    }

    #[test]
    fn debug_output_never_contains_the_plaintext() {
        let secret = Secret::new("hunter2-plaintext".to_owned());

        let rendered = format!("{secret:?}");

        assert_eq!(rendered, format!("Secret({REDACTED})"));
        assert!(!rendered.contains("hunter2-plaintext"));
    }

    #[test]
    fn a_struct_holding_a_secret_still_derives_debug_and_stays_redacted() {
        let credentials = Credentials {
            user: "lio".to_owned(),
            token: Secret::new("rotate-me".to_owned()),
        };

        let rendered = format!("{credentials:?}");

        assert!(rendered.contains("lio"));
        assert!(!rendered.contains("rotate-me"));
        assert!(rendered.contains(REDACTED));
    }

    #[test]
    fn plaintext_is_reachable_only_through_the_named_accessor() {
        let secret = Secret::new(vec![1_u8, 2, 3]);

        assert_eq!(secret.expose(), &vec![1, 2, 3]);
        assert_eq!(secret.into_inner(), vec![1, 2, 3]);
    }
}
