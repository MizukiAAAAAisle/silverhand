//! The session WRITE face — issuing a fresh session at signup/login, and
//! revoking one at logout.
//!
//! Reading a bearer (validate-and-touch) lives in [`super::session`]; this is the
//! other half of the same `auth_sessions` authority. The [`SessionTokenMint`]
//! ([`super::session_mint`]) produces the opaque bearer plaintext and its lookup
//! coordinate; this module persists that coordinate ([`SessionIssue`]) and, on
//! logout, retires it ([`SessionRevoke`]). The plaintext bearer never touches
//! persistence — only the SHA-256 coordinate does.
//!
//! The session-row surrogate id is NOT modelled here: it is an opaque
//! persistence primary key the adapter allocates, carries no ubiquitous-language
//! meaning, and is never surfaced — so it stays a persistence detail, not a
//! domain identity this context owns.

use std::future::Future;

use crate::{
    foundation::name_canonicalization, foundation::persistence::PersistenceFailure,
    identity::UserId, identity_access::auth::session::SessionTokenHash,
};

/// The maximum length, in UTF-16 code units, of a stored audit field — the
/// ratified bound matching the TS `normalizeInfoField`'s `slice(0, 512)`.
pub const AUDIT_FIELD_MAX_UTF16: usize = 512;

/// The optional forensic breadcrumbs captured with a session at issue time: the
/// caller's user-agent and first-seen IP. Both are normalized on capture (trim,
/// drop-if-empty, cut to [`AUDIT_FIELD_MAX_UTF16`] code units WITHOUT splitting a
/// Unicode scalar) so a stored value can never exceed the bound nor land
/// mid-scalar — the ratified audit-field contract.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SessionAudit {
    user_agent: Option<String>,
    ip_first_seen: Option<String>,
}

impl SessionAudit {
    /// Capture and normalize the two breadcrumbs. A missing, blank, or
    /// whitespace-only value becomes `None`; a long value is cut to the bound.
    pub fn capture(user_agent: Option<&str>, ip_first_seen: Option<&str>) -> Self {
        Self {
            user_agent: normalize_info_field(user_agent),
            ip_first_seen: normalize_info_field(ip_first_seen),
        }
    }

    pub fn user_agent(&self) -> Option<&str> {
        self.user_agent.as_deref()
    }

    pub fn ip_first_seen(&self) -> Option<&str> {
        self.ip_first_seen.as_deref()
    }
}

/// Trim (ECMAScript whitespace, the same set the name envelope folds), drop to
/// `None` if empty, then cut to [`AUDIT_FIELD_MAX_UTF16`] code units on a scalar
/// boundary.
fn normalize_info_field(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim_matches(name_canonicalization::is_ecmascript_trim_whitespace);
    if trimmed.is_empty() {
        return None;
    }
    Some(cut_to_utf16_units(trimmed, AUDIT_FIELD_MAX_UTF16))
}

/// Cut a string to at most `max_units` UTF-16 code units without splitting a
/// Unicode scalar. The ratified rule: a `slice(0, n)` bound that never severs a
/// code point (a supplementary scalar at the boundary is dropped whole, not
/// halved into a lone surrogate).
fn cut_to_utf16_units(raw: &str, max_units: usize) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for character in raw.chars() {
        let width = character.len_utf16();
        if units + width > max_units {
            break;
        }
        out.push(character);
        units += width;
    }
    out
}

/// Persist a freshly minted session. The caller has already minted the bearer and
/// its coordinate; this commits the coordinate against the user with the captured
/// audit breadcrumbs, stamping `created_at`/`last_used_at` at `now_ms`. Success
/// (`()`) means the row committed — the mint's plaintext is then safe to return.
pub trait SessionIssue: Clone + Send + Sync + 'static {
    fn issue(
        &self,
        user_id: &UserId,
        token_hash: SessionTokenHash,
        audit: &SessionAudit,
        now_ms: i64,
    ) -> impl Future<Output = Result<(), PersistenceFailure>> + Send;
}

/// Retire a session by its lookup coordinate. Returns whether a LIVE session was
/// revoked: `false` means no matching, unrevoked row existed (unknown or
/// already-revoked coordinate), which the logout flow maps to the same `401` as a
/// missing bearer. Idempotent — revoking an already-revoked coordinate is
/// `false`, never an error.
pub trait SessionRevoke: Clone + Send + Sync + 'static {
    fn revoke(
        &self,
        token_hash: SessionTokenHash,
        now_ms: i64,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_fields_trim_drop_blank_and_cut_to_512_units() {
        let audit = SessionAudit::capture(Some("  Mozilla/5.0  "), Some("   "));
        assert_eq!(audit.user_agent(), Some("Mozilla/5.0"));
        assert_eq!(
            audit.ip_first_seen(),
            None,
            "a blank field normalizes to None"
        );

        let long = "a".repeat(600);
        let audit = SessionAudit::capture(Some(&long), None);
        assert_eq!(
            audit.user_agent().unwrap().chars().count(),
            AUDIT_FIELD_MAX_UTF16
        );
    }

    #[test]
    fn the_cut_never_splits_a_supplementary_scalar() {
        // 511 ASCII + one astral emoji (2 UTF-16 units) = 513 units: the emoji
        // would straddle the 512 boundary, so it is dropped whole, not halved.
        let raw = format!("{}\u{1F680}", "a".repeat(511));
        let cut = cut_to_utf16_units(&raw, AUDIT_FIELD_MAX_UTF16);
        assert_eq!(cut.encode_utf16().count(), 511);
        assert!(!cut.contains('\u{1F680}'));

        // 510 ASCII + the emoji = 512 units exactly: it fits and is kept whole.
        let raw = format!("{}\u{1F680}", "a".repeat(510));
        let cut = cut_to_utf16_units(&raw, AUDIT_FIELD_MAX_UTF16);
        assert_eq!(cut.encode_utf16().count(), 512);
        assert!(cut.contains('\u{1F680}'));
    }
}
