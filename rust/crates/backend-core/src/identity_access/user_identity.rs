//! The human user-identity bounded context — the `users` authority.
//!
//! Its reason to change is the shape of a human identity: the immutable
//! @-handle (`users.name`), the login email, the mutable `display_name`, and the
//! projected profile a reader sees (`GET /api/me`). This context owns the
//! `users` row and the `user_changed` app-scope announce; it does NOT own the
//! password credential (`user_password_credentials`, [`crate::credential`]) nor
//! the session (`auth_sessions`, [`crate::auth`]). Signup COMPOSES this context
//! with those two; PATCH `/api/me` drives the `display_name` write here.
//!
//! ## The self-profile update: derive the change gate, skip the write on a no-op
//!
//! `PATCH /api/me` accepts only `display_name` (the handle is set once at
//! registration and is editable through no surface). The product's
//! `updateProfile` reads the row, and writes ONLY when the requested display
//! differs from the stored one — a patch that resolves to no change returns the
//! existing profile WITHOUT bumping `updated_at` and WITHOUT announcing. So the
//! write is not "always write, derive the gate after" (that is the
//! workspace-metadata shape); here the no-op skips the write entirely.
//!
//! The adapter therefore decides the skip under its own lock and reports the
//! committed row plus the display it read BEFORE writing
//! ([`UserProfileWrite::Committed`]'s `prior_display_name`). The domain seal
//! ([`seal_profile_write_fact`]) DERIVES "did the display move?" from that
//! before-image, exactly as the workspace rename derives its gate: the adapter
//! witnesses, the domain decides. The `user_changed` announce fires iff a real
//! change committed.

use std::future::Future;

use thiserror::Error;

use crate::{identity::UserId, persistence::PersistenceFailure};

// ===========================================================================
// Value objects — the admission vocabulary of a human identity.
//
// These parse the exact shapes the shared Zod schemas admit, so the domain
// receives validated values and the server's admission layer only maps a parse
// failure to the ratified terminal `400 {"error":"invalid input"}`. They are a
// DISTINCT authority from `name_canonicalization` (which NFC-folds workspace and
// conversation names): a participant @-handle is ASCII by a strict regex, and a
// display name is trimmed + control-char-rejected, neither NFC-folded.
// ===========================================================================

/// The maximum length (UTF-16 code units, matching Zod `.max`) of a login email.
pub const EMAIL_MAX_UTF16: usize = 320;
/// The maximum length (UTF-16 code units) of a participant handle.
pub const HANDLE_MAX_UTF16: usize = 64;
/// The maximum length (UTF-16 code units) of a display name.
pub const DISPLAY_NAME_MAX_UTF16: usize = 64;

/// A login email address, stored in its NORMALIZED form (ECMAScript-trimmed then
/// lowercased — the product's `normalizeLoginEmail`). Both signup storage and
/// login lookup use this one normalized form, and the `users.email` uniqueness is
/// matched `COLLATE NOCASE`, so carrying the lowercased value is faithful.
///
/// Admission mirrors `z.string().trim().email().max(320)`: trim first, then the
/// Zod v3 email regex on the trimmed value, then the 320-code-unit cap. The Zod
/// regex is ASCII-only, so a passing value is ASCII and its UTF-16 length equals
/// its `char` count.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmailAddress(String);

impl EmailAddress {
    pub fn parse(raw: &str) -> Result<Self, InvalidEmailAddress> {
        let trimmed = trim_ecmascript(raw);
        if !is_zod_email(trimmed) {
            return Err(InvalidEmailAddress);
        }
        if trimmed.chars().count() > EMAIL_MAX_UTF16 {
            return Err(InvalidEmailAddress);
        }
        Ok(Self(trimmed.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }

    /// The local part (before the first `@`) of the normalized email — the seed
    /// for a derived default display name.
    fn local_part(&self) -> &str {
        self.0.split('@').next().unwrap_or("user")
    }
}

#[derive(Debug, Error)]
#[error("email address is not valid")]
pub struct InvalidEmailAddress;

/// A participant @-handle (`users.name`) — the immutable mention identifier that
/// lives in the ONE namespace shared by agents and human users. Admission mirrors
/// `z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)`; there is no
/// trim (the anchored regex already forbids leading whitespace). Stored verbatim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParticipantHandle(String);

impl ParticipantHandle {
    pub fn parse(raw: &str) -> Result<Self, InvalidParticipantHandle> {
        let units = raw.encode_utf16().count();
        if !(1..=HANDLE_MAX_UTF16).contains(&units) {
            return Err(InvalidParticipantHandle);
        }
        let mut chars = raw.chars();
        match chars.next() {
            Some(first) if first.is_ascii_alphabetic() => {}
            _ => return Err(InvalidParticipantHandle),
        }
        if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(InvalidParticipantHandle);
        }
        Ok(Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

#[derive(Debug, Error)]
#[error("participant handle is not valid")]
pub struct InvalidParticipantHandle;

/// A mutable display name. Admission mirrors
/// `z.string().trim().min(1).max(64).refine(no control/line-separator chars)`:
/// trim first, then the 1..=64-code-unit bound on the trimmed value, then reject
/// any `[\x00-\x1F\x7F-\x9F  ]`. Stored trimmed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisplayName(String);

impl DisplayName {
    pub fn parse(raw: &str) -> Result<Self, InvalidDisplayName> {
        let trimmed = trim_ecmascript(raw);
        let units = trimmed.encode_utf16().count();
        if !(1..=DISPLAY_NAME_MAX_UTF16).contains(&units) {
            return Err(InvalidDisplayName);
        }
        if trimmed.chars().any(is_display_name_forbidden) {
            return Err(InvalidDisplayName);
        }
        Ok(Self(trimmed.to_owned()))
    }

    /// The SYSTEM-derived default when signup omits `display_name`, mirroring the
    /// product's `displayNameFromEmailLocalPart`: take the email local part,
    /// collapse runs of `._-` and whitespace to single spaces, trim, fall back to
    /// `"User"` when empty, cut to 64 code units, trim again.
    ///
    /// This deliberately does NOT route through [`parse`](Self::parse) — it is the
    /// same divergence the product documents: a system default written straight to
    /// the row, not a second authority on the field's length. By construction the
    /// result is a valid display name (non-empty, ≤64 units, no control chars),
    /// because its source alphabet is an already-validated ASCII email local part.
    pub fn derived_default_from_email(email: &EmailAddress) -> Self {
        let mut collapsed = String::new();
        let mut in_gap = false;
        for character in email.local_part().chars() {
            if character == '.'
                || character == '_'
                || character == '-'
                || is_ascii_or_ecmascript_space(character)
            {
                in_gap = true;
                continue;
            }
            if in_gap && !collapsed.is_empty() {
                collapsed.push(' ');
            }
            in_gap = false;
            collapsed.push(character);
        }
        let collapsed = trim_ecmascript(&collapsed);
        let base = if collapsed.is_empty() {
            "User"
        } else {
            collapsed
        };
        let cut = cut_to_utf16_units(base, DISPLAY_NAME_MAX_UTF16);
        Self(trim_ecmascript(&cut).to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

#[derive(Debug, Error)]
#[error("display name is not valid")]
pub struct InvalidDisplayName;

/// ECMAScript `String.prototype.trim()` — the exact whitespace set Zod `.trim()`
/// folds, reused from the shared name-canonicalization authority so this context
/// never mints a second trim.
fn trim_ecmascript(raw: &str) -> &str {
    raw.trim_matches(crate::name_canonicalization::is_ecmascript_trim_whitespace)
}

/// Whether a character is an ECMAScript trim-whitespace or an ASCII space — the
/// gap alphabet the display-name deriver collapses.
fn is_ascii_or_ecmascript_space(character: char) -> bool {
    crate::name_canonicalization::is_ecmascript_trim_whitespace(character)
}

/// The display-name forbidden set: C0 controls, DEL + C1 controls, and the two
/// line/paragraph separators — `[\x00-\x1F\x7F-\x9F  ]`.
fn is_display_name_forbidden(character: char) -> bool {
    let point = character as u32;
    point <= 0x1F || (0x7F..=0x9F).contains(&point) || point == 0x2028 || point == 0x2029
}

/// Cut a string to at most `max_units` UTF-16 code units WITHOUT splitting a
/// Unicode scalar, mirroring a JS `slice(0, n)` that never lands mid-scalar for
/// our inputs (the deriver's source is ASCII, so this is exact there; the
/// scalar-safe rule is the same ratified boundary the session audit fields use).
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

/// The Zod v3 `.email()` predicate, hand-rolled to its exact regex
/// `/^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i`
/// (the `regex` crate is out of the CP2 dependency delta). Operates on the
/// already-trimmed value.
fn is_zod_email(candidate: &str) -> bool {
    if candidate.starts_with('.') || candidate.contains("..") {
        return false;
    }
    let Some(at) = candidate.find('@') else {
        return false;
    };
    let (local, domain) = (&candidate[..at], &candidate[at + 1..]);
    if domain.contains('@') {
        return false;
    }
    // Local: `([A-Z0-9_'+\-.]*)[A-Z0-9_+-]` — non-empty, all chars in the wide
    // set, final char in the narrow set (no trailing `.` or `'`).
    if local.is_empty()
        || !local.chars().all(is_email_local_char)
        || !local
            .chars()
            .next_back()
            .is_some_and(is_email_local_final_char)
    {
        return false;
    }
    // Domain: `([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}` — one or more labels, then a
    // TLD of ≥2 ASCII letters.
    let mut labels = domain.split('.').collect::<Vec<_>>();
    let Some(tld) = labels.pop() else {
        return false;
    };
    if labels.is_empty() {
        return false;
    }
    if tld.len() < 2 || !tld.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    labels.iter().all(|label| {
        let mut chars = label.chars();
        matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric())
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

fn is_email_local_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '\'' | '+' | '-' | '.')
}

fn is_email_local_final_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '+' | '-')
}

// ===========================================================================
// The projected user profile — the committed/read fact.
// ===========================================================================

/// A human user's profile, as read from or committed to the `users` authority.
///
/// Fields are public because this is a read model the boundary projects to the
/// wire, not a verdict. `GET /api/me` projects `{id, name, display_name,
/// avatar_url, created_at, updated_at}` from it (email is never returned;
/// `avatar_url` is the cache-busted `/api/users/:id/avatar?v=:updated_at`
/// projection, or null when the user has no stored avatar).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRecord {
    pub id: UserId,
    /// The immutable @-handle (`users.name`).
    pub handle: String,
    pub display_name: String,
    /// `users.email` (nullable — a profile-only user has none; a signup user
    /// always does).
    pub email: Option<String>,
    /// The avatar revision (from `users.avatar_storage_key` + `updated_at`), or
    /// `None` when no avatar is stored. The boundary projects the cache-busted
    /// URL from it; a freshly signed-up user has none.
    pub avatar: Option<crate::messaging::AvatarRevision>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ===========================================================================
// Read: GET /api/me.
// ===========================================================================

/// Read a user's profile by id. `None` is "no such user" — under the bearer
/// perimeter that is a dangling session pointer, which the route maps to a
/// safe-500, never a product 404.
pub trait UserProfileRead: Clone + Send + Sync + 'static {
    fn get(
        &self,
        user_id: &UserId,
    ) -> impl Future<Output = Result<Option<UserRecord>, PersistenceFailure>> + Send;
}

/// Read the caller's own profile. A thin domain door over [`UserProfileRead`]:
/// the route already resolved the viewer's [`UserId`] from the bearer perimeter.
pub async fn read_self_profile<R>(
    reads: &R,
    user_id: &UserId,
) -> Result<Option<UserRecord>, PersistenceFailure>
where
    R: UserProfileRead,
{
    reads.get(user_id).await
}

/// Resolve a normalized login email to the user that holds it, if any — the
/// `users.getByEmail` existence read signup consults before deciding the
/// credential answer. This is a `users`-authority read (email→user existence),
/// distinct from the credential context's login lookup (email→{user, PHC}): the
/// two touch different tables for different questions.
pub trait UserEmailLookup: Clone + Send + Sync + 'static {
    fn find_by_email(
        &self,
        email: &str,
    ) -> impl Future<Output = Result<Option<UserId>, PersistenceFailure>> + Send;
}

/// The global human directory — every registered `users` row, in the order the
/// product lists them. `GET /api/users` projects each row to a `UserDto` and
/// wraps them as `{"users":[...]}`. This is an ungated read: any authenticated
/// viewer sees the whole directory (there is no hidden-profile concept in V1),
/// so the port carries no viewer and no filter.
///
/// Ordering is `created_at ASC` — the product's `SELECT * FROM users ORDER BY
/// created_at ASC`. It is a stable read of the authority, NOT a second in-memory
/// cache: the TS service reads the same rows through an in-memory port, but the
/// authoritative fact is the table, so the Rust adapter reads it directly.
pub trait UserDirectoryRead: Clone + Send + Sync + 'static {
    fn list(&self) -> impl Future<Output = Result<Vec<UserRecord>, PersistenceFailure>> + Send;
}

// ===========================================================================
// Write: PATCH /api/me (display_name), with the user_changed announce.
// ===========================================================================

/// The raw outcome of a `display_name` write, decided under the adapter's lock.
///
/// `Committed` carries the row the write left AND the display it read BEFORE
/// writing (`prior_display_name`). On a no-op (requested == stored) the adapter
/// skips the write, so the committed row still carries the OLD `updated_at` and
/// `prior_display_name == committed display`. The domain seal derives whether the
/// display moved from that before-image; the adapter does not decide it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UserProfileWrite {
    /// No user answers to this id.
    NoSuchUser,
    /// The write path ran: the committed row plus the display read before it.
    Committed {
        user: UserRecord,
        prior_display_name: String,
    },
}

/// The atomic `display_name` write on the `users` authority. Re-reads the row
/// under its own lock, writes ONLY when the display actually changes (bumping
/// `updated_at` to `now_ms` then), and returns the committed row plus the
/// before-image display.
pub trait UserProfileWriteUnitOfWork: Clone + Send + Sync + 'static {
    fn update_display_name(
        &self,
        user_id: &UserId,
        display_name: &DisplayName,
        now_ms: i64,
    ) -> impl Future<Output = Result<UserProfileWrite, PersistenceFailure>> + Send;
}

/// Why a profile write could not yield a trustworthy answer — both safe-500s.
#[derive(Debug, Error)]
pub enum UserProfileWriteError {
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
    #[error("user profile write returned a fact that does not match the request")]
    UntrustworthyWriteFact,
}

/// Seal a committed profile fact against the request AND derive the change gate.
///
/// The request carries the sole identity (`user_id`) and the sole target value
/// (`display_name`). The seal binds both and derives "did the display move?" from
/// the write's own before-image:
///
/// * the committed row's id must equal the request's;
/// * the committed display must equal the requested display (whether or not a
///   write happened — a no-op returns the row whose display already equals it);
/// * a MOVE (before-image `!=` committed display) must carry `updated_at == now_ms`
///   (the write bumps it), and only then is `user_changed` owed.
///
/// A no-op leaves `updated_at` untouched, so the seal must NOT assert `now_ms`
/// there — asserting it would reject the very no-op the product allows.
fn seal_profile_write_fact(
    user_id: &UserId,
    display_name: &DisplayName,
    user: &UserRecord,
    prior_display_name: &str,
    now_ms: i64,
) -> Result<bool, UserProfileWriteError> {
    if user.id != *user_id || user.display_name != display_name.as_str() {
        return Err(UserProfileWriteError::UntrustworthyWriteFact);
    }
    let changed = prior_display_name != user.display_name;
    if changed && user.updated_at != now_ms {
        return Err(UserProfileWriteError::UntrustworthyWriteFact);
    }
    Ok(changed)
}

/// The app-scope `user_changed` announce this context owns: on a genuine identity
/// change (signup, or a real `display_name` edit) every app-scope viewer is told
/// to reconverge its directory + identity carriers. The hint carries only the
/// `user_id` — a cache-invalidation signal, never a value channel — so it can fire
/// post-commit off the derived change gate without re-reading anything.
///
/// One sink, shared by the signup and profile-edit paths (human and agent
/// identity-create are isomorphic actors on this mechanism, matching the
/// product's `publishChanged`/`publishCreated` twins). No production adapter ships
/// in this leaf; that is a #2215 integration residual.
pub trait UserChangedSink: Clone + Send + Sync + 'static {
    fn user_changed(
        &self,
        user_id: &UserId,
    ) -> impl Future<Output = Result<(), UserChangedAnnounceFailure>> + Send;
}

/// An outward `user_changed` announce could not be delivered. Opaque like
/// [`PersistenceFailure`], and deliberately NOT one: a lost cache hint is not a
/// corrupted fact.
#[derive(Debug, Error)]
#[error("user-changed announce could not be delivered")]
pub struct UserChangedAnnounceFailure {
    #[source]
    source: Box<dyn std::error::Error + Send + Sync + 'static>,
}

impl UserChangedAnnounceFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

/// What became of the `user_changed` announce — a value carried back, never a
/// `Result` a caller may drop. The three arms are the three facts a boundary may
/// record.
#[derive(Debug)]
pub enum UserChangedAnnounce {
    /// No announce was owed: the patch changed no field (a no-op), so the sink was
    /// never called.
    NotOwed,
    /// The change committed and the sink accepted the hint.
    Delivered,
    /// The change committed but the hint could not be delivered. The commit stands;
    /// affected readers simply stay stale until they refetch for another reason.
    Failed(UserChangedAnnounceFailure),
}

/// A committed profile update together with the fate of its `user_changed`
/// announce. Sealed and reachable only through [`into_parts`](Self::into_parts),
/// so a boundary that takes the profile for the wire necessarily receives the
/// announce fate in the same move and cannot let it fall on the floor.
#[derive(Debug)]
#[must_use = "a committed profile update carries an announce outcome that must be handled"]
pub struct UpdatedUserProfile {
    user: UserRecord,
    announce: UserChangedAnnounce,
}

impl UpdatedUserProfile {
    pub fn into_parts(self) -> (UserRecord, UserChangedAnnounce) {
        (self.user, self.announce)
    }
}

/// The closed outcome of [`update_self_display_name`].
#[derive(Debug)]
pub enum UserProfileUpdate {
    /// The patch was applied (or resolved to a no-op); carries the sealed profile
    /// and its announce fate.
    Committed(UpdatedUserProfile),
    /// No such user — under the bearer perimeter, a dangling pointer the route
    /// maps to a safe-500 (never a product 404).
    NoSuchUser,
}

/// Update the caller's own `display_name` and fire the `user_changed` hint the
/// change owes.
///
/// The write self-decides the no-op skip under its lock; the seal derives whether
/// the display actually moved. The sink fires iff a move committed — a no-op owes
/// nothing. The announce is best-effort: a [`UserChangedAnnounce::Failed`] never
/// downgrades the committed edit.
pub async fn update_self_display_name<W, S>(
    writes: &W,
    announce_sink: &S,
    user_id: &UserId,
    display_name: DisplayName,
    now_ms: i64,
) -> Result<UserProfileUpdate, UserProfileWriteError>
where
    W: UserProfileWriteUnitOfWork,
    S: UserChangedSink,
{
    match writes
        .update_display_name(user_id, &display_name, now_ms)
        .await?
    {
        UserProfileWrite::NoSuchUser => Ok(UserProfileUpdate::NoSuchUser),
        UserProfileWrite::Committed {
            user,
            prior_display_name,
        } => {
            let changed = seal_profile_write_fact(
                user_id,
                &display_name,
                &user,
                &prior_display_name,
                now_ms,
            )?;
            let announce = if changed {
                match announce_sink.user_changed(user_id).await {
                    Ok(()) => UserChangedAnnounce::Delivered,
                    Err(failure) => UserChangedAnnounce::Failed(failure),
                }
            } else {
                UserChangedAnnounce::NotOwed
            };
            Ok(UserProfileUpdate::Committed(UpdatedUserProfile {
                user,
                announce,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    // ---- value objects ----

    #[test]
    fn email_admits_the_zod_set_and_normalizes_to_trimmed_lowercase() {
        assert_eq!(
            EmailAddress::parse("  Alice.Smith+tag@Example.COM ")
                .unwrap()
                .as_str(),
            "alice.smith+tag@example.com"
        );
        // Rejections: no `@`, leading dot, `..`, trailing-dot local, no TLD, unicode.
        for bad in [
            "",
            "plainaddress",
            ".lead@x.com",
            "a..b@x.com",
            "a.@x.com",
            "a@localhost",
            "a@x.c",
            "a@-x.com",
            "unïcode@x.com",
            "a@x..com",
        ] {
            assert!(
                EmailAddress::parse(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        // A 1-letter TLD is rejected; two letters admitted.
        assert!(EmailAddress::parse("a@x.io").is_ok());
    }

    #[test]
    fn email_max_is_320_code_units() {
        let local = "a".repeat(315);
        let ok = format!("{local}@x.io"); // 315 + 5 = 320
        assert!(EmailAddress::parse(&ok).is_ok());
        let over = format!("{}@x.io", "a".repeat(316)); // 321
        assert!(EmailAddress::parse(&over).is_err());
    }

    #[test]
    fn handle_admits_the_ascii_regex_only() {
        assert_eq!(
            ParticipantHandle::parse("Alice_9-x").unwrap().as_str(),
            "Alice_9-x"
        );
        for bad in [
            "",
            "9leads",
            "-leads",
            "has space",
            "dot.name",
            "emoji😀",
            &"a".repeat(65),
        ] {
            assert!(
                ParticipantHandle::parse(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn display_name_trims_bounds_and_rejects_control_chars() {
        assert_eq!(DisplayName::parse("  Alice  ").unwrap().as_str(), "Alice");
        assert!(DisplayName::parse("   ").is_err()); // empty after trim
        assert!(DisplayName::parse(&"x".repeat(65)).is_err()); // over 64
        assert!(DisplayName::parse("bad\u{0007}bell").is_err()); // C0 control
        assert!(DisplayName::parse("line\u{2028}sep").is_err()); // line separator
        assert!(DisplayName::parse("ok 名前").is_ok()); // unicode letters are fine
    }

    #[test]
    fn display_name_default_derives_from_the_email_local_part() {
        let email = EmailAddress::parse("alice.smith_jones@example.com").unwrap();
        assert_eq!(
            DisplayName::derived_default_from_email(&email).as_str(),
            "alice smith jones"
        );
        // A local part that collapses to nothing falls back to "User".
        let dots = EmailAddress::parse("a@x.io").unwrap();
        assert_eq!(DisplayName::derived_default_from_email(&dots).as_str(), "a");
    }

    // ---- the profile write seal + announce ----

    const NOW: i64 = 5_000;

    fn user_id() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    fn record(display: &str, updated_at: i64) -> UserRecord {
        UserRecord {
            id: UserId::parse("user-1").unwrap(),
            handle: "alice".to_owned(),
            display_name: display.to_owned(),
            email: Some("alice@example.com".to_owned()),
            created_at: 1,
            updated_at,
            avatar: None,
        }
    }

    #[derive(Clone)]
    struct FakeWrites(UserProfileWrite);

    impl UserProfileWriteUnitOfWork for FakeWrites {
        async fn update_display_name(
            &self,
            _user_id: &UserId,
            _display_name: &DisplayName,
            _now_ms: i64,
        ) -> Result<UserProfileWrite, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

    #[derive(Clone)]
    struct FakeSink {
        calls: Arc<AtomicUsize>,
        fail: bool,
    }

    impl FakeSink {
        fn new(fail: bool) -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                fail,
            }
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl UserChangedSink for FakeSink {
        async fn user_changed(&self, _user_id: &UserId) -> Result<(), UserChangedAnnounceFailure> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                #[derive(Debug, Error)]
                #[error("bus down")]
                struct BusDown;
                Err(UserChangedAnnounceFailure::from_source(BusDown))
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn a_real_change_commits_bumps_updated_at_and_announces_once() {
        let writes = FakeWrites(UserProfileWrite::Committed {
            user: record("New Name", NOW),
            prior_display_name: "Old Name".to_owned(),
        });
        let sink = FakeSink::new(false);
        let outcome = update_self_display_name(
            &writes,
            &sink,
            &user_id(),
            DisplayName::parse("New Name").unwrap(),
            NOW,
        )
        .await
        .unwrap();
        let UserProfileUpdate::Committed(updated) = outcome else {
            panic!("expected Committed");
        };
        let (user, announce) = updated.into_parts();
        assert_eq!(user.display_name, "New Name");
        assert!(matches!(announce, UserChangedAnnounce::Delivered));
        assert_eq!(sink.calls(), 1);
    }

    #[tokio::test]
    async fn a_no_op_patch_commits_without_bumping_and_never_announces() {
        // The adapter skipped the write: the row still carries the OLD updated_at
        // (NOW - 100), and the before-image equals the committed display.
        let writes = FakeWrites(UserProfileWrite::Committed {
            user: record("Same", NOW - 100),
            prior_display_name: "Same".to_owned(),
        });
        let sink = FakeSink::new(false);
        let outcome = update_self_display_name(
            &writes,
            &sink,
            &user_id(),
            DisplayName::parse("Same").unwrap(),
            NOW,
        )
        .await
        .unwrap();
        let UserProfileUpdate::Committed(updated) = outcome else {
            panic!("expected Committed");
        };
        let (user, announce) = updated.into_parts();
        assert_eq!(
            user.updated_at,
            NOW - 100,
            "a no-op must not bump updated_at"
        );
        assert!(matches!(announce, UserChangedAnnounce::NotOwed));
        assert_eq!(sink.calls(), 0, "a no-op owes no announce");
    }

    #[tokio::test]
    async fn a_failed_hint_is_carried_as_a_value_and_never_flips_the_commit() {
        let writes = FakeWrites(UserProfileWrite::Committed {
            user: record("New Name", NOW),
            prior_display_name: "Old".to_owned(),
        });
        let sink = FakeSink::new(true);
        let outcome = update_self_display_name(
            &writes,
            &sink,
            &user_id(),
            DisplayName::parse("New Name").unwrap(),
            NOW,
        )
        .await
        .unwrap();
        let UserProfileUpdate::Committed(updated) = outcome else {
            panic!("a failed announce must not turn the commit into a refusal");
        };
        let (_user, announce) = updated.into_parts();
        assert!(matches!(announce, UserChangedAnnounce::Failed(_)));
        assert_eq!(sink.calls(), 1);
    }

    #[tokio::test]
    async fn no_such_user_passes_through_and_never_announces() {
        let writes = FakeWrites(UserProfileWrite::NoSuchUser);
        let sink = FakeSink::new(false);
        let outcome = update_self_display_name(
            &writes,
            &sink,
            &user_id(),
            DisplayName::parse("New Name").unwrap(),
            NOW,
        )
        .await
        .unwrap();
        assert!(matches!(outcome, UserProfileUpdate::NoSuchUser));
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn a_committed_fact_for_a_foreign_user_is_sealed_off() {
        let mut user = record("New Name", NOW);
        user.id = UserId::parse("user-2").unwrap();
        let writes = FakeWrites(UserProfileWrite::Committed {
            user,
            prior_display_name: "Old".to_owned(),
        });
        let sink = FakeSink::new(false);
        let result = update_self_display_name(
            &writes,
            &sink,
            &user_id(),
            DisplayName::parse("New Name").unwrap(),
            NOW,
        )
        .await;
        assert!(matches!(
            result,
            Err(UserProfileWriteError::UntrustworthyWriteFact)
        ));
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn a_committed_display_that_is_not_the_requested_value_is_sealed_off() {
        let writes = FakeWrites(UserProfileWrite::Committed {
            user: record("Something Else", NOW),
            prior_display_name: "Old".to_owned(),
        });
        let sink = FakeSink::new(false);
        let result = update_self_display_name(
            &writes,
            &sink,
            &user_id(),
            DisplayName::parse("New Name").unwrap(),
            NOW,
        )
        .await;
        assert!(matches!(
            result,
            Err(UserProfileWriteError::UntrustworthyWriteFact)
        ));
    }

    #[tokio::test]
    async fn a_real_change_that_did_not_bump_updated_at_is_sealed_off() {
        // Display moved off the before-image but updated_at is stale: the adapter
        // claims a change it did not stamp.
        let writes = FakeWrites(UserProfileWrite::Committed {
            user: record("New Name", NOW - 1),
            prior_display_name: "Old".to_owned(),
        });
        let sink = FakeSink::new(false);
        let result = update_self_display_name(
            &writes,
            &sink,
            &user_id(),
            DisplayName::parse("New Name").unwrap(),
            NOW,
        )
        .await;
        assert!(matches!(
            result,
            Err(UserProfileWriteError::UntrustworthyWriteFact)
        ));
        assert_eq!(sink.calls(), 0);
    }
}
