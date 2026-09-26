//! The one-shot embedded-bootstrap token authority — the in-memory half of the TS
//! `EmbeddedBootstrapState` + `consumeEmbeddedBootstrapToken`.
//!
//! This is a process-lifetime operational secret, not a domain concept: it exists
//! only because embedded mode hands the local client a loopback-written token file
//! to prove it is the machine's owner. So it lives in the server packaging layer
//! (beside [`crate::host_runtime::runtime_credential`], the other process-lifetime secret), never
//! in the domain core.
//!
//! ## Atomic one-shot consume (a security property)
//!
//! [`EmbeddedBootstrapTokenAuthority::consume`] verifies AND invalidates the token
//! in-memory under the write lock in one synchronous step, then best-effort unlinks
//! the file. A matching token is spent exactly once: a replay observes the nulled
//! hash and fails. A wrong/empty token leaves the state untouched. The file unlink
//! happens AFTER the in-memory invalidation and its failure is only logged — it
//! NEVER restores the token, so a filesystem hiccup can never re-arm a spent token.
//! The raw token is never stored: only its SHA-256 (the shared session hashing
//! rule) is held, and even that is dropped on consume. The stored/presented digests
//! are compared in constant time ([`hashes_match`]), matching the TS handler's
//! `timingSafeEqual` — a wrong attempt is unlimited and non-consuming, so an
//! early-exit compare would be a timing oracle for a co-resident process.

use std::{path::PathBuf, sync::Arc};

use silverhand_backend_core::identity_access::auth::SessionTokenHash;
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;

/// The shared in-memory token state, cloned into the router state. `Clone` shares
/// the one `Arc<RwLock<..>>`, so every request consults the same one-shot cell.
#[derive(Clone)]
pub struct EmbeddedBootstrapTokenAuthority {
    inner: Arc<RwLock<TokenState>>,
}

struct TokenState {
    /// The SHA-256 of the outstanding token (the shared session hashing rule), or
    /// `None` once disabled or consumed. Compared, never reversed; the raw token is
    /// never held.
    token_hash: Option<String>,
    /// The token file to unlink on the one successful consume. `None` when disabled
    /// (no file was written) or once already taken.
    file_path: Option<PathBuf>,
}

impl EmbeddedBootstrapTokenAuthority {
    /// An armed authority holding the hash of `token_plaintext` and the path to
    /// unlink on consume. The plaintext is hashed immediately and dropped; only the
    /// coordinate survives. (The loopback-guarded file write itself is a startup /
    /// convergence concern, not this leaf's.)
    pub fn enabled(token_plaintext: &str, file_path: PathBuf) -> Self {
        Self {
            inner: Arc::new(RwLock::new(TokenState {
                token_hash: Some(
                    SessionTokenHash::of_plaintext(token_plaintext)
                        .as_str()
                        .to_owned(),
                ),
                file_path: Some(file_path),
            })),
        }
    }

    /// A disabled authority: mode is not embedded, or the listen address is not
    /// loopback. Every consume fails, so the route collapses to the indistinguishable
    /// 404 without ever minting a session.
    pub fn disabled() -> Self {
        Self {
            inner: Arc::new(RwLock::new(TokenState {
                token_hash: None,
                file_path: None,
            })),
        }
    }

    /// Verify and one-shot-consume the presented token. Returns whether THIS call
    /// spent a live token. On a match the in-memory hash is nulled synchronously
    /// (so a concurrent replay loses), then the file is best-effort unlinked; a
    /// wrong/empty/already-spent/disabled token returns `false` and touches nothing.
    ///
    /// The hash comparison is **constant-time** ([`hashes_match`], the sole
    /// comparison site): this token is a locally-reachable secret that a wrong
    /// attempt neither consumes nor rate-limits, so a plain early-exit `==` would
    /// hand a co-resident process a timing oracle to recover it byte by byte.
    pub async fn consume(&self, presented: &str) -> bool {
        let presented_hash = SessionTokenHash::of_plaintext(presented);
        let to_unlink = {
            let mut state = self.inner.write().await;
            let Some(stored) = state.token_hash.as_deref() else {
                return false;
            };
            // Compare digests constant-time, never the raw token; a mismatch changes
            // no state.
            if !hashes_match(presented_hash.as_str(), stored) {
                return false;
            }
            // Match: invalidate synchronously (one-shot) and capture the file to
            // unlink. From here the token is permanently spent whatever the DB says.
            state.token_hash = None;
            state.file_path.take()
        };
        if let Some(path) = to_unlink {
            remove_token_file(&path).await;
        }
        true
    }

    /// Best-effort cleanup of an UNCONSUMED token file at graceful shutdown or a
    /// startup rollback. Idempotent and race-safe with [`consume`](Self::consume):
    /// whichever runs first takes the file path under the write lock and unlinks it;
    /// the other observes `None` and is a no-op. It ALSO nulls the in-memory hash, so
    /// a token cleaned up at shutdown can never be spent afterward. A missing file
    /// (already consumed, or never written for a disabled authority) is success; any
    /// other unlink fault is logged and swallowed — cleanup NEVER re-arms the token.
    pub async fn cleanup(&self) {
        let to_unlink = {
            let mut state = self.inner.write().await;
            state.token_hash = None;
            state.file_path.take()
        };
        if let Some(path) = to_unlink {
            remove_token_file(&path).await;
        }
    }
}

/// The sole hash-comparison site for the bootstrap token, in constant time via the
/// audited [`subtle`] primitive. Both operands are the base64url of a SHA-256 digest
/// — a fixed 43-byte length for every input — so this is a same-length digest
/// comparison; the `ConstantTimeEq` slice impl still handles a length mismatch
/// without leaking content timing.
fn hashes_match(presented: &str, stored: &str) -> bool {
    presented.as_bytes().ct_eq(stored.as_bytes()).into()
}

/// Best-effort unlink of the token file. A missing file is success (already gone);
/// any other error is logged and swallowed — it NEVER restores the spent token.
async fn remove_token_file(path: &std::path::Path) {
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(
                error = crate::foundation::safe_log_field::safe_display(&(error)),
                "embedded bootstrap: failed to remove consumed token file"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_matching_token_is_spent_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        tokio::fs::write(&file, b"secret\n").await.unwrap();
        let authority = EmbeddedBootstrapTokenAuthority::enabled("secret", file.clone());

        assert!(authority.consume("secret").await, "first consume wins");
        assert!(!authority.consume("secret").await, "replay loses");
        // The file was unlinked on the one successful consume.
        assert!(!file.exists(), "token file removed on consume");
    }

    #[tokio::test]
    async fn a_wrong_token_never_consumes_or_unlinks() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        tokio::fs::write(&file, b"secret\n").await.unwrap();
        let authority = EmbeddedBootstrapTokenAuthority::enabled("secret", file.clone());

        for wrong in ["wrong", "", "secrex"] {
            assert!(!authority.consume(wrong).await, "{wrong}");
            assert!(file.exists(), "no unlink for {wrong}");
        }
        // Untouched: the real token still works and the file still exists.
        assert!(file.exists(), "file intact after a wrong attempt");
        assert!(authority.consume("secret").await);
    }

    #[tokio::test]
    async fn a_disabled_authority_never_consumes() {
        let authority = EmbeddedBootstrapTokenAuthority::disabled();
        assert!(!authority.consume("anything").await);
        assert!(!authority.consume("").await);
    }

    /// Resident guard for the P0 timing invariant: the sole comparison site is the
    /// constant-time `hashes_match`, and it judges every fixed-length SHA-256 digest
    /// pair correctly — equal accepts; a difference in the FIRST or the LAST byte is
    /// rejected all the same (an early-exit `==` would still return the right verdict,
    /// so this pins the correctness contract of the primitive production consume uses,
    /// while the constant-time property itself is discharged by delegating to the
    /// audited `subtle::ConstantTimeEq` rather than a hand-written loop).
    #[test]
    fn digest_comparison_rejects_first_and_last_byte_differences() {
        let a = SessionTokenHash::of_plaintext("token-a");
        let a_again = SessionTokenHash::of_plaintext("token-a");
        let b = SessionTokenHash::of_plaintext("token-b");
        assert_eq!(
            a.as_str().len(),
            b.as_str().len(),
            "digests are fixed length"
        );

        assert!(
            hashes_match(a.as_str(), a_again.as_str()),
            "equal digests accept"
        );
        assert!(
            !hashes_match(a.as_str(), b.as_str()),
            "differing digests reject"
        );

        // Flip only the last byte: a full-length comparison must still reject.
        let mut tail_flipped = a.as_str().to_owned();
        let last = tail_flipped.pop().unwrap();
        tail_flipped.push(if last == 'A' { 'B' } else { 'A' });
        assert!(
            !hashes_match(a.as_str(), &tail_flipped),
            "last-byte difference rejects"
        );

        // Flip only the first byte: rejected without any early accept.
        let mut head_flipped = a.as_str().to_owned();
        let first = head_flipped.remove(0);
        head_flipped.insert(0, if first == 'A' { 'B' } else { 'A' });
        assert!(
            !hashes_match(a.as_str(), &head_flipped),
            "first-byte difference rejects"
        );
    }

    #[tokio::test]
    async fn a_missing_token_file_is_tolerated_and_never_re_arms() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("already-gone");
        // The file was never written; consume must still spend the token and not
        // restore it despite the ENOENT unlink.
        let authority = EmbeddedBootstrapTokenAuthority::enabled("secret", file);
        assert!(authority.consume("secret").await);
        assert!(!authority.consume("secret").await, "still one-shot");
    }

    #[tokio::test]
    async fn cleanup_unlinks_an_unconsumed_token_and_disarms() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        tokio::fs::write(&file, b"secret\n").await.unwrap();
        let authority = EmbeddedBootstrapTokenAuthority::enabled("secret", file.clone());

        authority.cleanup().await;
        assert!(
            !file.exists(),
            "shutdown cleanup removes the unconsumed file"
        );
        assert!(
            !authority.consume("secret").await,
            "a cleaned-up token can never be spent afterward"
        );
    }

    #[tokio::test]
    async fn cleanup_after_consume_is_a_safe_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        tokio::fs::write(&file, b"secret\n").await.unwrap();
        let authority = EmbeddedBootstrapTokenAuthority::enabled("secret", file.clone());

        assert!(
            authority.consume("secret").await,
            "consume spends + unlinks"
        );
        assert!(!file.exists());
        // Shutdown still runs cleanup; the file is already gone (ENOENT) — no panic,
        // no error, no re-arm.
        authority.cleanup().await;
        assert!(!authority.consume("secret").await, "still spent");
    }

    #[tokio::test]
    async fn cleanup_is_idempotent_and_safe_on_a_disabled_authority() {
        let authority = EmbeddedBootstrapTokenAuthority::disabled();
        authority.cleanup().await;
        authority.cleanup().await; // second cleanup is a no-op, never a panic
    }
}
