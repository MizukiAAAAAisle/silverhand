//! The avatar sub-capability of the `users` authority — `POST`/`DELETE
//! /api/me/avatar` (upload/replace, clear) and the public-by-id byte fetch
//! `GET /api/users/{id}/avatar`.
//!
//! It reuses the human identity ([`UserRecord`]/[`UserId`]) and the `user_changed`
//! announce this authority owns; it does NOT own a second identity, DTO, or
//! avatar-URL rule (the wire `avatar_url` is projected by the server DTO from the
//! committed row's revision, exactly as `GET /api/me` projects it).
//!
//! ## Two seams this leaf DEFINES but does not ship production adapters for
//!
//! * [`AvatarBlobStore`] — a NARROW blob capability, not the generic
//!   [`crate::blob_store::BlobStore`]. Its pointer ([`AvatarBlobPointer`]) is the
//!   single opaque key the `users` row persists and the read path hands back; the
//!   storage KIND is the adapter's own (single-backend today, mirroring the
//!   product's `ctx.blobStorage.kind`), so it never crosses the DB or the wire.
//!   The production filesystem/blob adapter is a #2221 integration residual; this
//!   leaf supplies only the port + deterministic test adapters.
//! * [`UserChangedSink`] — reused from [`crate::user_identity`]; a mutating avatar
//!   write owes the same changed-only `user_changed` app-scope announce a profile
//!   edit does. The production sink is a #2220 integration residual.
//!
//! ## The write is a committed-fact seal, exactly like the display-name write
//!
//! The blob is written FIRST, the row is repointed SECOND, the previous blob is
//! deleted LAST (best-effort). The write authority returns the committed row plus
//! the before-image storage key; the domain seals the fact (id matches, the row
//! now carries the avatar it was told to set at `now_ms`) and derives whether an
//! announce is owed. A clear on an already-clear row is a no-op: no bump, no blob
//! delete, no announce — the same no-op algebra the display-name path uses.

use std::future::Future;

use thiserror::Error;

use crate::{
    identity::UserId,
    persistence::PersistenceFailure,
    user_identity::{UserChangedAnnounce, UserChangedSink, UserProfileRead, UserRecord},
};

// ===========================================================================
// Admission vocabulary: the size cap and the closed content-type set.
//
// These mirror `@silverhand/shared`'s `validateAvatarFile`: a byte-size cap and
// a four-member content-type allowlist, checked empty → too-large → unsupported.
// ===========================================================================

/// The maximum avatar payload, in bytes — the product's `AVATAR_MAX_BYTES`
/// (`5 * 1024 * 1024`). A JSON-representable magnitude well under `2^53`, so the
/// `u64` byte count and the JS `number` byte length agree exactly.
pub const AVATAR_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// A validated avatar content type: one of the four the product admits. Carrying
/// the closed enum (rather than a validated `String`) makes the allowlist the
/// type's domain, and gives the filename extension a total function.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AvatarContentType {
    Jpeg,
    Png,
    Gif,
    Webp,
}

impl AvatarContentType {
    /// The wire/DB spelling, e.g. `image/png`. Stored verbatim in
    /// `users.avatar_content_type` and emitted as the fetch's `Content-Type`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }

    /// The filename subtype — the product's `content_type.split('/')[1]`. Note
    /// JPEG is `jpeg`, not `jpg` (the download filename is `avatar.jpeg`).
    pub const fn subtype(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Png => "png",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }

    /// The download filename the fetch serves — the product's
    /// `avatar.${content_type.split('/')[1]}`.
    pub fn download_filename(self) -> String {
        format!("avatar.{}", self.subtype())
    }

    /// Parse a content type against the closed set. The value is lowercased and
    /// matched verbatim — no trimming, no `;charset` stripping — exactly as the
    /// product's `validateAvatarFile` does (`file.type` lowercased, then
    /// `AVATAR_ALLOWED_CONTENT_TYPES.includes`). A value with parameters or
    /// surrounding whitespace is therefore NOT a member.
    ///
    /// This is the ONE avatar-content-type parser, shared by the upload admission
    /// (a DECLARED multipart value) and the stored-row read. The only production
    /// writer of `users.avatar_content_type` is an admitted upload, so a stored
    /// value is always a member; a read that fails to parse is a persistence
    /// integrity fault the adapter surfaces as a safe-500, never a silent 404.
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "image/jpeg" => Some(Self::Jpeg),
            "image/png" => Some(Self::Png),
            "image/gif" => Some(Self::Gif),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }
}

/// Why an uploaded avatar was refused, before any blob was written. The three
/// arms are the product's three `AvatarValidationCode`s; each carries the stable
/// public `code` and a portable `message` the server maps to a fixed status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AvatarRejection {
    /// Empty payload — the product's `avatar_missing` (400).
    Empty,
    /// Over `AVATAR_MAX_BYTES` — the product's `avatar_too_large` (413).
    TooLarge,
    /// Declared content type outside the allowlist — `avatar_unsupported_type`
    /// (415).
    UnsupportedType,
}

impl AvatarRejection {
    /// The stable public error code (unchanged from the product's TS union).
    pub const fn code(self) -> &'static str {
        match self {
            Self::Empty => "avatar_missing",
            Self::TooLarge => "avatar_too_large",
            Self::UnsupportedType => "avatar_unsupported_type",
        }
    }

    /// A portable human message. These match the product's wording verbatim
    /// because it is stable, non-Zod, product-authored copy.
    pub const fn message(self) -> &'static str {
        match self {
            Self::Empty => "Avatar file is empty.",
            Self::TooLarge => "Avatar must be 5 MB or smaller.",
            Self::UnsupportedType => "Avatar must be a PNG, JPEG, GIF, or WEBP image.",
        }
    }
}

/// Validate an uploaded avatar's size and declared content type, in the product's
/// refusal order: empty first, then too-large, then unsupported-type. Returns the
/// validated content type on success — the value the row stores and the fetch
/// serves.
pub fn validate_avatar(
    byte_len: u64,
    declared_content_type: &str,
) -> Result<AvatarContentType, AvatarRejection> {
    if byte_len == 0 {
        return Err(AvatarRejection::Empty);
    }
    if byte_len > AVATAR_MAX_BYTES {
        return Err(AvatarRejection::TooLarge);
    }
    AvatarContentType::parse(declared_content_type).ok_or(AvatarRejection::UnsupportedType)
}

// ===========================================================================
// The narrow blob capability.
// ===========================================================================

/// A self-sufficient opaque pointer to a stored avatar blob — the exact string
/// persisted in `users.avatar_storage_key`. It carries no storage kind (the
/// adapter owns that) and no path grammar; construction only rejects the empty
/// key, because an empty key was never an avatar.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AvatarBlobPointer(String);

impl AvatarBlobPointer {
    pub fn parse(raw: impl Into<String>) -> Result<Self, EmptyAvatarBlobPointer> {
        let raw = raw.into();
        if raw.is_empty() {
            return Err(EmptyAvatarBlobPointer);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Error)]
#[error("avatar blob pointer is empty")]
pub struct EmptyAvatarBlobPointer;

/// The bytes a fetch found for a pointer, or that the pointer resolved to nothing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AvatarBlobReadOutcome {
    Found(Vec<u8>),
    /// The row's pointer resolves to no stored bytes. This is a storage
    /// inconsistency (the DB says an avatar exists), which the fetch route maps
    /// to a safe-500 — the product's `serve` throws when `stat` finds no file.
    Missing,
}

/// A blob-layer operation could not complete. Opaque like [`PersistenceFailure`],
/// and deliberately distinct: a blob backend fault is not a `users`-row fault.
#[derive(Debug, Error)]
#[error("avatar blob storage operation failed")]
pub struct AvatarStorageFailure {
    #[source]
    source: Box<dyn std::error::Error + Send + Sync + 'static>,
}

impl AvatarStorageFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

/// The narrow READ half of the avatar blob capability: fetch the bytes a pointer
/// resolves to. Split out from the full store so a read-only consumer — the public
/// byte fetch, for BOTH the `users` face here and the agent avatar face
/// ([`crate::agent_avatar`]) — depends only on the read, never on the id-keyed
/// `put` or the `delete`. The production adapter is a #2221 residual.
pub trait AvatarBlobRead: Clone + Send + Sync + 'static {
    fn read(
        &self,
        pointer: &AvatarBlobPointer,
    ) -> impl Future<Output = Result<AvatarBlobReadOutcome, AvatarStorageFailure>> + Send;
}

/// The full avatar blob capability: the narrow [`AvatarBlobRead`] plus the
/// mutating `put`/`delete` the upload and clear paths own. The adapter mints the
/// per-upload physical key (a fresh one each put, so re-uploading the same picture
/// never clobbers or cache-hits) and owns the single storage kind.
pub trait AvatarBlobStore: AvatarBlobRead {
    /// Store `bytes` for `user_id` under a fresh key and return its pointer.
    fn put(
        &self,
        user_id: &UserId,
        content_type: AvatarContentType,
        bytes: Vec<u8>,
    ) -> impl Future<Output = Result<AvatarBlobPointer, AvatarStorageFailure>> + Send;

    /// Best-effort delete. A failure never flips the already-committed pointer
    /// write (an orphaned previous blob is annoying, never fatal — the DB pointer
    /// is authoritative), but the orchestration CARRIES its fate as a
    /// [`BlobCleanup`] for the boundary to log rather than dropping it.
    fn delete(
        &self,
        pointer: &AvatarBlobPointer,
    ) -> impl Future<Output = Result<(), AvatarStorageFailure>> + Send;
}

// ===========================================================================
// The DB pointer authority: read the serve ref, write/clear the pointer.
// ===========================================================================

/// The server-side avatar coordinate for the public byte fetch: the opaque
/// pointer plus the stored content type. Mirrors the product's
/// `getAvatarStorageRef`, which returns `null` (→ [`Option::None`] here) when the
/// user is absent OR carries no `avatar_storage_key` OR no `avatar_content_type`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AvatarStorageRef {
    pub pointer: AvatarBlobPointer,
    pub content_type: AvatarContentType,
}

/// Resolve a user's avatar serve ref by id. `None` covers all three of the
/// product's null cases (no row / no key / no content type) — the fetch maps it
/// to a 404, so this is not a dangling-session concern.
pub trait AvatarStorageRefRead: Clone + Send + Sync + 'static {
    fn get_avatar_ref(
        &self,
        user_id: &UserId,
    ) -> impl Future<Output = Result<Option<AvatarStorageRef>, PersistenceFailure>> + Send;
}

/// The raw outcome of a pointer write, decided under the adapter's lock. Carries
/// the committed row AND the before-image storage key so the domain can seal the
/// fact and clean up the previous blob. On a clear of an already-clear row the
/// adapter skips the UPDATE, so `prior_key` is `None` and the row keeps its old
/// `updated_at` — the no-op that owes no announce.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AvatarPointerWrite {
    NoSuchUser,
    Committed {
        user: UserRecord,
        prior_key: Option<AvatarBlobPointer>,
    },
}

/// The atomic avatar-pointer write on the `users` authority. Both operations
/// re-read the row under the write lock, bump `updated_at` to `now_ms` when they
/// change it, and return the committed row plus the before-image key.
pub trait AvatarPointerWriteUnitOfWork: Clone + Send + Sync + 'static {
    /// Point the row at `pointer` with `content_type`, bumping `updated_at`.
    fn set_avatar(
        &self,
        user_id: &UserId,
        pointer: &AvatarBlobPointer,
        content_type: AvatarContentType,
        now_ms: i64,
    ) -> impl Future<Output = Result<AvatarPointerWrite, PersistenceFailure>> + Send;

    /// Clear the row's avatar. If the row is already clear the adapter skips the
    /// UPDATE (no bump); `prior_key` is then `None`.
    fn clear_avatar(
        &self,
        user_id: &UserId,
        now_ms: i64,
    ) -> impl Future<Output = Result<AvatarPointerWrite, PersistenceFailure>> + Send;
}

/// Why an avatar write could not yield a trustworthy answer — all safe-500s.
#[derive(Debug, Error)]
pub enum AvatarWriteError {
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
    #[error("avatar write returned a fact that does not match the request")]
    UntrustworthyWriteFact,
}

// ===========================================================================
// Upload orchestration.
// ===========================================================================

/// The closed outcome of [`upload_avatar`].
#[derive(Debug)]
pub enum AvatarUploadOutcome {
    /// The avatar was stored and the row repointed; carries the committed profile
    /// and the fate of its `user_changed` announce.
    Committed(CommittedAvatar),
    /// No such user. Under the bearer perimeter this is the caller's OWN id from
    /// the session, so a missing row is a dangling session pointer the route maps
    /// to a safe-500 — never a product 404 (the same rule `GET`/`PATCH /api/me`
    /// use). It is a distinct arm, not folded into the write error, because the
    /// mid-flight row-vanished case must first clean up the orphaned new blob;
    /// `orphan_cleanup` carries that delete's fate to the boundary (the existence
    /// pre-check path had nothing to clean → [`BlobCleanup::NothingToClean`]).
    NoSuchUser { orphan_cleanup: BlobCleanup },
    /// The payload was refused before any blob was written.
    Rejected(AvatarRejection),
    /// The blob backend could not store the bytes — the product's
    /// `avatar_storage_failed`. Carries the underlying fault so the boundary can
    /// log the cause chain before serving the stable, detail-free wire message.
    StorageFailed(AvatarStorageFailure),
}

/// A committed avatar change together with the fate of its `user_changed`
/// announce AND of its post-commit blob cleanup. Reachable only through
/// [`into_parts`](Self::into_parts), so a boundary taking the profile for the
/// wire receives both residues in the same move and cannot drop them.
#[derive(Debug)]
#[must_use = "a committed avatar change carries an announce and a blob-cleanup outcome that must be handled"]
pub struct CommittedAvatar {
    user: UserRecord,
    announce: UserChangedAnnounce,
    blob_cleanup: BlobCleanup,
}

impl CommittedAvatar {
    pub fn into_parts(self) -> (UserRecord, UserChangedAnnounce, BlobCleanup) {
        (self.user, self.announce, self.blob_cleanup)
    }
}

/// The fate of a best-effort blob delete performed AFTER the `users` row was
/// already committed — the replaced previous blob on a successful set/clear, or
/// the orphaned new blob on a mid-flight row-vanish. The DB pointer is
/// authoritative, so a failed delete never flips the committed write; but a leaked
/// blob is a real (if benign) storage residue, so its fate is carried to the
/// boundary as a named, loggable value rather than silently dropped — the same
/// carried-failure discipline [`UserChangedAnnounce`] uses for the announce hint.
#[derive(Debug)]
#[must_use = "a post-commit blob cleanup can leak storage and must be logged at the boundary"]
pub enum BlobCleanup {
    /// There was no previous or orphaned blob to delete.
    NothingToClean,
    /// The delete succeeded.
    Deleted,
    /// The delete failed; the blob is orphaned in storage. Carries the fault for
    /// the boundary log.
    Failed(AvatarStorageFailure),
}

/// Run the best-effort post-commit delete and fold its result into a
/// [`BlobCleanup`] (a failure is carried, never propagated — the pointer is
/// already authoritative).
async fn cleanup_blob<B>(blobs: &B, pointer: &AvatarBlobPointer) -> BlobCleanup
where
    B: AvatarBlobStore,
{
    match blobs.delete(pointer).await {
        Ok(()) => BlobCleanup::Deleted,
        Err(failure) => BlobCleanup::Failed(failure),
    }
}

/// The raw uploaded bytes together with the client-declared content type — the
/// candidate avatar before validation. The two always arrive together from the
/// multipart `file` part and are consumed as a unit by [`validate_avatar`].
pub struct CandidateAvatar {
    pub bytes: Vec<u8>,
    pub declared_content_type: String,
}

/// Upload (or replace) the caller's avatar.
///
/// Order matches the product exactly: existence first (so a missing user costs no
/// blob write), then validate, then put the new blob, then repoint the row, then
/// delete the previous blob (best-effort). A mid-flight row-vanished re-read
/// cleans up the just-written orphan before reporting [`AvatarUploadOutcome::NoSuchUser`].
/// The announce fires once on the genuine change.
pub async fn upload_avatar<R, W, B, S>(
    reads: &R,
    writes: &W,
    blobs: &B,
    announce_sink: &S,
    user_id: &UserId,
    candidate: CandidateAvatar,
    now_ms: i64,
) -> Result<AvatarUploadOutcome, AvatarWriteError>
where
    R: UserProfileRead,
    W: AvatarPointerWriteUnitOfWork,
    B: AvatarBlobStore,
    S: UserChangedSink,
{
    let CandidateAvatar {
        bytes,
        declared_content_type,
    } = candidate;

    // Existence pre-check: user_not_found precedes validation and any blob write.
    if reads.get(user_id).await?.is_none() {
        return Ok(AvatarUploadOutcome::NoSuchUser {
            orphan_cleanup: BlobCleanup::NothingToClean,
        });
    }

    let content_type = match validate_avatar(bytes.len() as u64, &declared_content_type) {
        Ok(content_type) => content_type,
        Err(rejection) => return Ok(AvatarUploadOutcome::Rejected(rejection)),
    };

    let pointer = match blobs.put(user_id, content_type, bytes).await {
        Ok(pointer) => pointer,
        Err(failure) => return Ok(AvatarUploadOutcome::StorageFailed(failure)),
    };

    match writes
        .set_avatar(user_id, &pointer, content_type, now_ms)
        .await?
    {
        AvatarPointerWrite::NoSuchUser => {
            // The row vanished between the pre-check and the repoint. Clean up the
            // orphaned new blob (best-effort) and carry that delete's fate before
            // reporting the dangling pointer.
            let orphan_cleanup = cleanup_blob(blobs, &pointer).await;
            Ok(AvatarUploadOutcome::NoSuchUser { orphan_cleanup })
        }
        AvatarPointerWrite::Committed { user, prior_key } => {
            seal_avatar_set(user_id, &user, now_ms)?;
            // Best-effort cleanup of the replaced blob; the pointer is already
            // updated, so a lingering previous blob is harmless (but its delete
            // fate is carried, not dropped).
            let blob_cleanup = match prior_key {
                Some(prior_key) => cleanup_blob(blobs, &prior_key).await,
                None => BlobCleanup::NothingToClean,
            };
            let announce = announce(announce_sink, user_id).await;
            Ok(AvatarUploadOutcome::Committed(CommittedAvatar {
                user,
                announce,
                blob_cleanup,
            }))
        }
    }
}

/// Seal a committed avatar-set fact against the request: the row is the caller's,
/// it now carries an avatar, and the write stamped `updated_at` to `now_ms`.
fn seal_avatar_set(
    user_id: &UserId,
    user: &UserRecord,
    now_ms: i64,
) -> Result<(), AvatarWriteError> {
    if user.id != *user_id || user.avatar.is_none() || user.updated_at != now_ms {
        return Err(AvatarWriteError::UntrustworthyWriteFact);
    }
    Ok(())
}

// ===========================================================================
// Clear orchestration.
// ===========================================================================

/// Clear the caller's avatar. Idempotent: clearing an already-clear row is a
/// no-op that neither bumps `updated_at` nor announces. `NoSuchUser` is the
/// dangling-pointer safe-500 case (as in [`upload_avatar`]).
pub async fn clear_avatar<W, B, S>(
    writes: &W,
    blobs: &B,
    announce_sink: &S,
    user_id: &UserId,
    now_ms: i64,
) -> Result<AvatarUploadOutcome, AvatarWriteError>
where
    W: AvatarPointerWriteUnitOfWork,
    B: AvatarBlobStore,
    S: UserChangedSink,
{
    match writes.clear_avatar(user_id, now_ms).await? {
        AvatarPointerWrite::NoSuchUser => Ok(AvatarUploadOutcome::NoSuchUser {
            orphan_cleanup: BlobCleanup::NothingToClean,
        }),
        AvatarPointerWrite::Committed { user, prior_key } => {
            match prior_key {
                // A genuine clear: the row now has no avatar and `updated_at` moved.
                Some(prior_key) => {
                    seal_avatar_clear(user_id, &user, true, now_ms)?;
                    let blob_cleanup = cleanup_blob(blobs, &prior_key).await;
                    let announce = announce(announce_sink, user_id).await;
                    Ok(AvatarUploadOutcome::Committed(CommittedAvatar {
                        user,
                        announce,
                        blob_cleanup,
                    }))
                }
                // Already clear: no bump, no blob delete, no announce.
                None => {
                    seal_avatar_clear(user_id, &user, false, now_ms)?;
                    Ok(AvatarUploadOutcome::Committed(CommittedAvatar {
                        user,
                        announce: UserChangedAnnounce::NotOwed,
                        blob_cleanup: BlobCleanup::NothingToClean,
                    }))
                }
            }
        }
    }
}

/// Seal a committed clear fact: the row is the caller's and now carries no
/// avatar. A genuine clear (`changed`) must have stamped `updated_at == now_ms`;
/// a no-op must NOT be asserted against `now_ms` (it kept its old timestamp).
fn seal_avatar_clear(
    user_id: &UserId,
    user: &UserRecord,
    changed: bool,
    now_ms: i64,
) -> Result<(), AvatarWriteError> {
    if user.id != *user_id || user.avatar.is_some() {
        return Err(AvatarWriteError::UntrustworthyWriteFact);
    }
    if changed && user.updated_at != now_ms {
        return Err(AvatarWriteError::UntrustworthyWriteFact);
    }
    Ok(())
}

/// Fire the changed-only `user_changed` announce and fold its result into the
/// carried value (a failed hint never downgrades the committed write).
async fn announce<S>(sink: &S, user_id: &UserId) -> UserChangedAnnounce
where
    S: UserChangedSink,
{
    match sink.user_changed(user_id).await {
        Ok(()) => UserChangedAnnounce::Delivered,
        Err(failure) => UserChangedAnnounce::Failed(failure),
    }
}

// ===========================================================================
// Public byte-fetch orchestration.
// ===========================================================================

/// The closed outcome of [`fetch_avatar`].
#[derive(Debug)]
pub enum AvatarFetchOutcome {
    /// Serve these bytes with this content type + download filename.
    Found {
        bytes: Vec<u8>,
        content_type: AvatarContentType,
        filename: String,
    },
    /// No such user, or the user has no avatar — the product's 404.
    NotFound,
    /// The row points at an avatar but the blob could not be served — a storage
    /// inconsistency the route maps to a safe-500 (the product's `serve` throws on
    /// a missing file). `cause` distinguishes a hard blob-backend read fault
    /// (`Some`) from a clean "the pointer resolved to nothing" (`None`); both are
    /// the same safe-500 on the wire, but the fault is carried so the boundary can
    /// log its cause chain instead of collapsing the two into a bare log line.
    StorageUnavailable { cause: Option<AvatarStorageFailure> },
}

/// Fetch a user's avatar bytes by id (public to any authenticated viewer).
pub async fn fetch_avatar<R, B>(
    refs: &R,
    blobs: &B,
    user_id: &UserId,
) -> Result<AvatarFetchOutcome, PersistenceFailure>
where
    R: AvatarStorageRefRead,
    B: AvatarBlobStore,
{
    let Some(reference) = refs.get_avatar_ref(user_id).await? else {
        return Ok(AvatarFetchOutcome::NotFound);
    };
    // A blob read failure is a storage fault; the route maps both it and a
    // Missing outcome to a safe-500 (never a product answer). The read fault's
    // cause is carried so the boundary can log it; a clean Missing carries none.
    match blobs.read(&reference.pointer).await {
        Ok(AvatarBlobReadOutcome::Found(bytes)) => Ok(AvatarFetchOutcome::Found {
            bytes,
            content_type: reference.content_type,
            filename: reference.content_type.download_filename(),
        }),
        Ok(AvatarBlobReadOutcome::Missing) => {
            Ok(AvatarFetchOutcome::StorageUnavailable { cause: None })
        }
        Err(failure) => Ok(AvatarFetchOutcome::StorageUnavailable {
            cause: Some(failure),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::AvatarRevision;
    use crate::user_identity::UserChangedAnnounceFailure;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    const NOW: i64 = 9_000;

    fn user_id() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    fn record(avatar: Option<i64>, updated_at: i64) -> UserRecord {
        UserRecord {
            id: UserId::parse("user-1").unwrap(),
            handle: "alice".to_owned(),
            display_name: "Alice".to_owned(),
            email: Some("alice@example.com".to_owned()),
            avatar: avatar.map(AvatarRevision::at),
            created_at: 1,
            updated_at,
        }
    }

    // ---- validation ----

    #[test]
    fn validation_follows_the_empty_then_too_large_then_type_order() {
        // Empty beats an unsupported type.
        assert_eq!(
            validate_avatar(0, "text/plain"),
            Err(AvatarRejection::Empty)
        );
        // Too-large beats an unsupported type.
        assert_eq!(
            validate_avatar(AVATAR_MAX_BYTES + 1, "text/plain"),
            Err(AvatarRejection::TooLarge)
        );
        // At the cap is admitted; over is not.
        assert_eq!(
            validate_avatar(AVATAR_MAX_BYTES, "image/png"),
            Ok(AvatarContentType::Png)
        );
        // Declared type is matched verbatim after lowercasing: parameters/whitespace
        // are NOT stripped, so they fall out of the allowlist (415).
        assert_eq!(validate_avatar(10, "IMAGE/PNG"), Ok(AvatarContentType::Png));
        assert_eq!(
            validate_avatar(10, "image/png; charset=binary"),
            Err(AvatarRejection::UnsupportedType)
        );
        assert_eq!(
            validate_avatar(10, "image/svg+xml"),
            Err(AvatarRejection::UnsupportedType)
        );
    }

    #[test]
    fn content_type_filename_uses_the_subtype_with_jpeg_not_jpg() {
        assert_eq!(AvatarContentType::Jpeg.download_filename(), "avatar.jpeg");
        assert_eq!(AvatarContentType::Webp.download_filename(), "avatar.webp");
    }

    #[test]
    fn a_blob_pointer_rejects_only_the_empty_key() {
        assert!(AvatarBlobPointer::parse("").is_err());
        assert_eq!(
            AvatarBlobPointer::parse("users/u/avatars/k.png")
                .unwrap()
                .as_str(),
            "users/u/avatars/k.png"
        );
    }

    // ---- fakes ----

    #[derive(Clone)]
    struct FakeReads(Option<UserRecord>);
    impl UserProfileRead for FakeReads {
        async fn get(&self, _id: &UserId) -> Result<Option<UserRecord>, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

    #[derive(Clone)]
    struct FakeWrites(AvatarPointerWrite);
    impl AvatarPointerWriteUnitOfWork for FakeWrites {
        async fn set_avatar(
            &self,
            _id: &UserId,
            _pointer: &AvatarBlobPointer,
            _content_type: AvatarContentType,
            _now_ms: i64,
        ) -> Result<AvatarPointerWrite, PersistenceFailure> {
            Ok(self.0.clone())
        }
        async fn clear_avatar(
            &self,
            _id: &UserId,
            _now_ms: i64,
        ) -> Result<AvatarPointerWrite, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

    #[derive(Clone, Default)]
    struct RecordingBlobs {
        put_key: String,
        fail_put: bool,
        fail_delete: bool,
        read: Option<AvatarBlobReadOutcome>,
        read_err: bool,
        deleted: Arc<Mutex<Vec<String>>>,
        puts: Arc<AtomicUsize>,
    }
    impl AvatarBlobRead for RecordingBlobs {
        async fn read(
            &self,
            _pointer: &AvatarBlobPointer,
        ) -> Result<AvatarBlobReadOutcome, AvatarStorageFailure> {
            if self.read_err {
                #[derive(Debug, Error)]
                #[error("read fault")]
                struct ReadFault;
                return Err(AvatarStorageFailure::from_source(ReadFault));
            }
            Ok(self.read.clone().unwrap_or(AvatarBlobReadOutcome::Missing))
        }
    }
    impl AvatarBlobStore for RecordingBlobs {
        async fn put(
            &self,
            _id: &UserId,
            _content_type: AvatarContentType,
            _bytes: Vec<u8>,
        ) -> Result<AvatarBlobPointer, AvatarStorageFailure> {
            self.puts.fetch_add(1, Ordering::SeqCst);
            if self.fail_put {
                #[derive(Debug, Error)]
                #[error("disk full")]
                struct DiskFull;
                return Err(AvatarStorageFailure::from_source(DiskFull));
            }
            AvatarBlobPointer::parse(self.put_key.clone())
                .map_err(AvatarStorageFailure::from_source)
        }
        async fn delete(&self, pointer: &AvatarBlobPointer) -> Result<(), AvatarStorageFailure> {
            self.deleted
                .lock()
                .unwrap()
                .push(pointer.as_str().to_owned());
            if self.fail_delete {
                #[derive(Debug, Error)]
                #[error("unlink failed")]
                struct UnlinkFailed;
                return Err(AvatarStorageFailure::from_source(UnlinkFailed));
            }
            Ok(())
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
        async fn user_changed(&self, _id: &UserId) -> Result<(), UserChangedAnnounceFailure> {
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

    // ---- upload ----

    #[tokio::test]
    async fn upload_puts_repoints_deletes_the_previous_blob_and_announces_once() {
        let reads = FakeReads(Some(record(Some(1), 1)));
        let writes = FakeWrites(AvatarPointerWrite::Committed {
            user: record(Some(NOW), NOW),
            prior_key: Some(AvatarBlobPointer::parse("old/key.png").unwrap()),
        });
        let blobs = RecordingBlobs {
            put_key: "new/key.png".to_owned(),
            ..Default::default()
        };
        let sink = FakeSink::new(false);
        let outcome = upload_avatar(
            &reads,
            &writes,
            &blobs,
            &sink,
            &user_id(),
            CandidateAvatar {
                bytes: vec![1, 2, 3],
                declared_content_type: "image/png".to_owned(),
            },
            NOW,
        )
        .await
        .unwrap();
        let AvatarUploadOutcome::Committed(committed) = outcome else {
            panic!("expected Committed");
        };
        let (user, ann, cleanup) = committed.into_parts();
        assert!(user.avatar.is_some());
        assert!(matches!(ann, UserChangedAnnounce::Delivered));
        assert!(matches!(cleanup, BlobCleanup::Deleted));
        assert_eq!(blobs.puts.load(Ordering::SeqCst), 1);
        assert_eq!(
            *blobs.deleted.lock().unwrap(),
            vec!["old/key.png".to_owned()]
        );
        assert_eq!(sink.calls(), 1);
    }

    #[tokio::test]
    async fn upload_with_no_previous_blob_deletes_nothing() {
        let reads = FakeReads(Some(record(None, 1)));
        let writes = FakeWrites(AvatarPointerWrite::Committed {
            user: record(Some(NOW), NOW),
            prior_key: None,
        });
        let blobs = RecordingBlobs {
            put_key: "new/key.png".to_owned(),
            ..Default::default()
        };
        let sink = FakeSink::new(false);
        upload_avatar(
            &reads,
            &writes,
            &blobs,
            &sink,
            &user_id(),
            CandidateAvatar {
                bytes: vec![1],
                declared_content_type: "image/png".to_owned(),
            },
            NOW,
        )
        .await
        .unwrap();
        assert!(blobs.deleted.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn upload_refuses_a_missing_user_before_touching_the_blob() {
        let reads = FakeReads(None);
        let writes = FakeWrites(AvatarPointerWrite::NoSuchUser);
        let blobs = RecordingBlobs {
            put_key: "new/key.png".to_owned(),
            ..Default::default()
        };
        let sink = FakeSink::new(false);
        let outcome = upload_avatar(
            &reads,
            &writes,
            &blobs,
            &sink,
            &user_id(),
            CandidateAvatar {
                bytes: vec![1],
                declared_content_type: "image/png".to_owned(),
            },
            NOW,
        )
        .await
        .unwrap();
        assert!(matches!(
            outcome,
            AvatarUploadOutcome::NoSuchUser {
                orphan_cleanup: BlobCleanup::NothingToClean
            }
        ));
        assert_eq!(
            blobs.puts.load(Ordering::SeqCst),
            0,
            "no blob write for a missing user"
        );
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn upload_rejects_bad_payload_after_existence_but_before_the_blob() {
        let reads = FakeReads(Some(record(None, 1)));
        let writes = FakeWrites(AvatarPointerWrite::NoSuchUser);
        let blobs = RecordingBlobs {
            put_key: "new/key.png".to_owned(),
            ..Default::default()
        };
        let sink = FakeSink::new(false);
        // Unsupported type.
        let outcome = upload_avatar(
            &reads,
            &writes,
            &blobs,
            &sink,
            &user_id(),
            CandidateAvatar {
                bytes: vec![1],
                declared_content_type: "text/plain".to_owned(),
            },
            NOW,
        )
        .await
        .unwrap();
        assert!(matches!(
            outcome,
            AvatarUploadOutcome::Rejected(AvatarRejection::UnsupportedType)
        ));
        assert_eq!(blobs.puts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn upload_reports_storage_failed_when_the_put_fails() {
        let reads = FakeReads(Some(record(None, 1)));
        let writes = FakeWrites(AvatarPointerWrite::NoSuchUser);
        let blobs = RecordingBlobs {
            fail_put: true,
            ..Default::default()
        };
        let sink = FakeSink::new(false);
        let outcome = upload_avatar(
            &reads,
            &writes,
            &blobs,
            &sink,
            &user_id(),
            CandidateAvatar {
                bytes: vec![1],
                declared_content_type: "image/png".to_owned(),
            },
            NOW,
        )
        .await
        .unwrap();
        assert!(matches!(outcome, AvatarUploadOutcome::StorageFailed(_)));
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn upload_row_vanished_mid_flight_cleans_up_the_orphan_and_reports_no_such_user() {
        let reads = FakeReads(Some(record(None, 1)));
        let writes = FakeWrites(AvatarPointerWrite::NoSuchUser);
        let blobs = RecordingBlobs {
            put_key: "new/key.png".to_owned(),
            ..Default::default()
        };
        let sink = FakeSink::new(false);
        let outcome = upload_avatar(
            &reads,
            &writes,
            &blobs,
            &sink,
            &user_id(),
            CandidateAvatar {
                bytes: vec![1],
                declared_content_type: "image/png".to_owned(),
            },
            NOW,
        )
        .await
        .unwrap();
        assert!(matches!(
            outcome,
            AvatarUploadOutcome::NoSuchUser {
                orphan_cleanup: BlobCleanup::Deleted
            }
        ));
        assert_eq!(
            blobs.puts.load(Ordering::SeqCst),
            1,
            "the new blob was written"
        );
        assert_eq!(
            *blobs.deleted.lock().unwrap(),
            vec!["new/key.png".to_owned()],
            "the orphaned new blob is cleaned up"
        );
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn upload_seals_off_a_write_that_did_not_stamp_now() {
        let reads = FakeReads(Some(record(None, 1)));
        let writes = FakeWrites(AvatarPointerWrite::Committed {
            user: record(Some(NOW - 1), NOW - 1), // stale updated_at
            prior_key: None,
        });
        let blobs = RecordingBlobs {
            put_key: "new/key.png".to_owned(),
            ..Default::default()
        };
        let sink = FakeSink::new(false);
        let result = upload_avatar(
            &reads,
            &writes,
            &blobs,
            &sink,
            &user_id(),
            CandidateAvatar {
                bytes: vec![1],
                declared_content_type: "image/png".to_owned(),
            },
            NOW,
        )
        .await;
        assert!(matches!(
            result,
            Err(AvatarWriteError::UntrustworthyWriteFact)
        ));
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn upload_carries_a_failed_announce_without_flipping_the_commit() {
        let reads = FakeReads(Some(record(None, 1)));
        let writes = FakeWrites(AvatarPointerWrite::Committed {
            user: record(Some(NOW), NOW),
            prior_key: None,
        });
        let blobs = RecordingBlobs {
            put_key: "new/key.png".to_owned(),
            ..Default::default()
        };
        let sink = FakeSink::new(true);
        let outcome = upload_avatar(
            &reads,
            &writes,
            &blobs,
            &sink,
            &user_id(),
            CandidateAvatar {
                bytes: vec![1],
                declared_content_type: "image/png".to_owned(),
            },
            NOW,
        )
        .await
        .unwrap();
        let AvatarUploadOutcome::Committed(committed) = outcome else {
            panic!("a failed announce must not turn the commit into a refusal");
        };
        let (_user, ann, _cleanup) = committed.into_parts();
        assert!(matches!(ann, UserChangedAnnounce::Failed(_)));
    }

    #[tokio::test]
    async fn upload_carries_a_failed_prior_blob_cleanup_without_flipping_the_commit() {
        let reads = FakeReads(Some(record(Some(1), 1)));
        let writes = FakeWrites(AvatarPointerWrite::Committed {
            user: record(Some(NOW), NOW),
            prior_key: Some(AvatarBlobPointer::parse("old/key.png").unwrap()),
        });
        let blobs = RecordingBlobs {
            put_key: "new/key.png".to_owned(),
            fail_delete: true,
            ..Default::default()
        };
        let sink = FakeSink::new(false);
        let outcome = upload_avatar(
            &reads,
            &writes,
            &blobs,
            &sink,
            &user_id(),
            CandidateAvatar {
                bytes: vec![1],
                declared_content_type: "image/png".to_owned(),
            },
            NOW,
        )
        .await
        .unwrap();
        let AvatarUploadOutcome::Committed(committed) = outcome else {
            panic!("a failed prior-blob delete must not turn the commit into a refusal");
        };
        let (user, ann, cleanup) = committed.into_parts();
        assert!(user.avatar.is_some());
        assert!(matches!(ann, UserChangedAnnounce::Delivered));
        assert!(
            matches!(cleanup, BlobCleanup::Failed(_)),
            "the leaked previous blob is carried as a named residue, not dropped"
        );
    }

    #[tokio::test]
    async fn upload_row_vanished_carries_a_failed_orphan_cleanup() {
        let reads = FakeReads(Some(record(None, 1)));
        let writes = FakeWrites(AvatarPointerWrite::NoSuchUser);
        let blobs = RecordingBlobs {
            put_key: "new/key.png".to_owned(),
            fail_delete: true,
            ..Default::default()
        };
        let sink = FakeSink::new(false);
        let outcome = upload_avatar(
            &reads,
            &writes,
            &blobs,
            &sink,
            &user_id(),
            CandidateAvatar {
                bytes: vec![1],
                declared_content_type: "image/png".to_owned(),
            },
            NOW,
        )
        .await
        .unwrap();
        assert!(
            matches!(
                outcome,
                AvatarUploadOutcome::NoSuchUser {
                    orphan_cleanup: BlobCleanup::Failed(_)
                }
            ),
            "the orphaned new blob's failed cleanup is a named residue on the dangling-pointer arm"
        );
    }

    // ---- clear ----

    #[tokio::test]
    async fn clear_of_a_present_avatar_deletes_the_blob_and_announces() {
        let writes = FakeWrites(AvatarPointerWrite::Committed {
            user: record(None, NOW),
            prior_key: Some(AvatarBlobPointer::parse("old/key.png").unwrap()),
        });
        let blobs = RecordingBlobs::default();
        let sink = FakeSink::new(false);
        let outcome = clear_avatar(&writes, &blobs, &sink, &user_id(), NOW)
            .await
            .unwrap();
        let AvatarUploadOutcome::Committed(committed) = outcome else {
            panic!("expected Committed");
        };
        let (user, ann, cleanup) = committed.into_parts();
        assert!(user.avatar.is_none());
        assert!(matches!(ann, UserChangedAnnounce::Delivered));
        assert!(matches!(cleanup, BlobCleanup::Deleted));
        assert_eq!(
            *blobs.deleted.lock().unwrap(),
            vec!["old/key.png".to_owned()]
        );
        assert_eq!(sink.calls(), 1);
    }

    #[tokio::test]
    async fn clear_of_an_already_clear_row_is_a_no_op_that_never_announces_or_deletes() {
        let writes = FakeWrites(AvatarPointerWrite::Committed {
            user: record(None, NOW - 100), // old updated_at kept
            prior_key: None,
        });
        let blobs = RecordingBlobs::default();
        let sink = FakeSink::new(false);
        let outcome = clear_avatar(&writes, &blobs, &sink, &user_id(), NOW)
            .await
            .unwrap();
        let AvatarUploadOutcome::Committed(committed) = outcome else {
            panic!("expected Committed");
        };
        let (user, ann, cleanup) = committed.into_parts();
        assert_eq!(
            user.updated_at,
            NOW - 100,
            "a no-op must not bump updated_at"
        );
        assert!(matches!(ann, UserChangedAnnounce::NotOwed));
        assert!(matches!(cleanup, BlobCleanup::NothingToClean));
        assert!(blobs.deleted.lock().unwrap().is_empty());
        assert_eq!(sink.calls(), 0);
    }

    #[tokio::test]
    async fn clear_of_a_missing_user_is_no_such_user() {
        let writes = FakeWrites(AvatarPointerWrite::NoSuchUser);
        let blobs = RecordingBlobs::default();
        let sink = FakeSink::new(false);
        let outcome = clear_avatar(&writes, &blobs, &sink, &user_id(), NOW)
            .await
            .unwrap();
        assert!(matches!(
            outcome,
            AvatarUploadOutcome::NoSuchUser {
                orphan_cleanup: BlobCleanup::NothingToClean
            }
        ));
        assert_eq!(sink.calls(), 0);
    }

    // ---- fetch ----

    #[derive(Clone)]
    struct FakeRefs(Option<AvatarStorageRef>);
    impl AvatarStorageRefRead for FakeRefs {
        async fn get_avatar_ref(
            &self,
            _id: &UserId,
        ) -> Result<Option<AvatarStorageRef>, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

    #[tokio::test]
    async fn fetch_serves_found_bytes_with_the_stored_type_and_filename() {
        let refs = FakeRefs(Some(AvatarStorageRef {
            pointer: AvatarBlobPointer::parse("users/u/avatars/k.jpeg").unwrap(),
            content_type: AvatarContentType::Jpeg,
        }));
        let blobs = RecordingBlobs {
            read: Some(AvatarBlobReadOutcome::Found(vec![7, 8, 9])),
            ..Default::default()
        };
        let outcome = fetch_avatar(&refs, &blobs, &user_id()).await.unwrap();
        let AvatarFetchOutcome::Found {
            bytes,
            content_type,
            filename,
        } = outcome
        else {
            panic!("expected Found");
        };
        assert_eq!(bytes, vec![7, 8, 9]);
        assert_eq!(content_type, AvatarContentType::Jpeg);
        assert_eq!(filename, "avatar.jpeg");
    }

    #[tokio::test]
    async fn fetch_is_not_found_when_the_ref_is_absent() {
        let refs = FakeRefs(None);
        let blobs = RecordingBlobs::default();
        let outcome = fetch_avatar(&refs, &blobs, &user_id()).await.unwrap();
        assert!(matches!(outcome, AvatarFetchOutcome::NotFound));
    }

    #[tokio::test]
    async fn fetch_is_storage_unavailable_when_the_blob_is_gone() {
        let refs = FakeRefs(Some(AvatarStorageRef {
            pointer: AvatarBlobPointer::parse("users/u/avatars/k.png").unwrap(),
            content_type: AvatarContentType::Png,
        }));
        let blobs = RecordingBlobs {
            read: Some(AvatarBlobReadOutcome::Missing),
            ..Default::default()
        };
        let outcome = fetch_avatar(&refs, &blobs, &user_id()).await.unwrap();
        assert!(matches!(
            outcome,
            AvatarFetchOutcome::StorageUnavailable { cause: None }
        ));
    }

    #[tokio::test]
    async fn fetch_storage_unavailable_carries_the_read_fault_cause() {
        let refs = FakeRefs(Some(AvatarStorageRef {
            pointer: AvatarBlobPointer::parse("users/u/avatars/k.png").unwrap(),
            content_type: AvatarContentType::Png,
        }));
        let blobs = RecordingBlobs {
            read_err: true,
            ..Default::default()
        };
        let outcome = fetch_avatar(&refs, &blobs, &user_id()).await.unwrap();
        assert!(
            matches!(
                outcome,
                AvatarFetchOutcome::StorageUnavailable { cause: Some(_) }
            ),
            "a hard blob-read fault carries its cause distinct from a clean Missing"
        );
    }
}
