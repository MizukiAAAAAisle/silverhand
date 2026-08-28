//! The public agent-avatar byte fetch — `GET /api/agents/{id}/avatar`.
//!
//! This is the agent analog of the `users` avatar fetch ([`crate::avatar`]). It
//! reuses the STORAGE-GENERIC avatar vocabulary — the content-type allowlist
//! ([`AvatarContentType`]), the blob read outcome ([`AvatarBlobReadOutcome`]) and the
//! storage-fault type ([`AvatarStorageFailure`]) — because none of those name a
//! custody. It does NOT reuse the user path's blob POINTER: `users.avatar_storage_key`
//! and `agents.avatar_storage_key` are two distinct custodies (one minted per
//! [`crate::identity::UserId`], one per [`AgentId`]), so this bounded context owns its
//! own opaque [`AgentAvatarBlobPointer`] and its own read capability
//! ([`AgentAvatarBlobRead`]). The two pointers never share a domain type; only the
//! production adapter's private key→bytes plumbing is shared.
//!
//! ## The four states of the stored `(avatar_storage_key, avatar_content_type)` pair
//!
//! The two columns are decoded as ONE typed row shape — never each on its own — so a
//! below-write-path corruption can never masquerade as "no avatar":
//!
//!  1. NO ROW (the agents row was deleted between the visibility gate and this read)
//!     → [`AgentAvatarServeRef::NoRow`], reported as `avatar not found` (404).
//!  2. A ROW with BOTH columns `NULL` → [`AgentAvatarRow::Absent`], also reported as
//!     `avatar not found` (404). A legitimately avatar-less agent carries a clear
//!     both-`NULL`, never an empty string.
//!  3. A ROW with BOTH present, the key non-empty and the content type an allowlist
//!     member → [`AgentAvatarRow::Present`], the serve coordinate.
//!  4. ANY other combination — exactly one side present, an empty key, a content type
//!     outside the allowlist, or an unreadable row id — is [`AgentAvatarRowCorruption`]:
//!     a below-write-path integrity fault surfaced as a [`PersistenceFailure`] (a safe
//!     `500` carrying its cause), NEVER folded into the `avatar not found` of states 1
//!     and 2. The schema CHECK couples the two columns' NULL-ness, so a half-populated
//!     pair is unreachable through the write path; it is treated as corruption
//!     precisely because only corruption could produce it.
//!
//! ## Every row fact is source-bound before the blob is touched
//!
//! The visibility gate ([`crate::capability::agent_view`]) binds the DETAIL facts to
//! the requested id. This serve-ref read is a SEPARATE port, so it carries its OWN
//! read-back source id ([`AgentAvatarServeRef::Row`]'s `source`), and
//! [`fetch_agent_avatar`] binds `source == requested` BEFORE any blob read. A
//! cross-wired adapter that let request `A` clear visibility and then handed back `B`'s
//! pointer would otherwise splice `B`'s bytes onto an `A`-authorized response; the bind
//! makes that a safe `500` with the blob untouched. `WHERE id = ?` in the adapter does
//! not discharge this — the PORT contract must carry the identity, not the SQL.
//!
//! ## A dangling pointer is a storage inconsistency, not "no avatar"
//!
//! Access precedes product: an admitted caller reaches this read only after the
//! visibility authority passed. Once a `Present` row is bound, its bytes MUST exist —
//! the row asserts they do. A blob that resolves to [`AvatarBlobReadOutcome::Missing`]
//! is therefore a storage inconsistency (the DB says the avatar exists), reported as
//! [`AgentAvatarFetchOutcome::StorageUnavailable`] → a safe `500` with cause, exactly
//! as the TypeScript route's uncaught `blobStorage.serve` fails when `stat` hits
//! `ENOENT`. Only states 1 and 2 (no row / both-`NULL`) are the product `avatar not
//! found`.

use std::future::Future;

use thiserror::Error;

use crate::{
    avatar::{AvatarBlobReadOutcome, AvatarContentType, AvatarStorageFailure},
    identity::AgentId,
    persistence::PersistenceFailure,
};

/// The opaque pointer to an AGENT avatar blob (`agents.avatar_storage_key`).
///
/// A distinct custody from the user avatar pointer ([`crate::avatar::AvatarBlobPointer`]):
/// same underlying storage backend, different namespace and different lifecycle owner.
/// This is the canonical agent-avatar pointer #2225 publishes for downstream consumers;
/// it stays a domain newtype rather than a bare string so the two custodies can never
/// be passed for one another. Parsing rejects only the empty string — the stored key is
/// otherwise opaque.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAvatarBlobPointer(String);

/// The empty-string rejection from [`AgentAvatarBlobPointer::parse`].
#[derive(Debug, Error)]
#[error("agent avatar blob pointer must not be empty")]
pub struct EmptyAgentAvatarBlobPointer;

impl AgentAvatarBlobPointer {
    pub fn parse(raw: impl Into<String>) -> Result<Self, EmptyAgentAvatarBlobPointer> {
        let raw = raw.into();
        if raw.is_empty() {
            return Err(EmptyAgentAvatarBlobPointer);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// An agent avatar blob coordinate BOUND to the agent that owns it. The read and delete
/// capabilities accept ONLY this — never a bare [`AgentAvatarBlobPointer`] — so custody is
/// carried by the value, not asserted by a convention at the call site. A bare pointer is
/// a "some agent's key" token; this pairs it with the SPECIFIC owner whose row (or `put`
/// subject) produced it. The production adapter verifies the physical key lies in THIS
/// owner's namespace before it touches the store, so a cross-wired or corrupted
/// `agents.avatar_storage_key` holding another agent's OTHERWISE-legal key can never read
/// or delete that agent's blob through this custody.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnedAgentAvatarBlob {
    owner: AgentId,
    pointer: AgentAvatarBlobPointer,
}

impl OwnedAgentAvatarBlob {
    /// Bind `pointer` to the `owner` agent that vouches for it (the requested id on a
    /// serve, the write subject on a cleanup). The binding is a CLAIM the adapter must
    /// verify against the physical key; this constructor does not itself parse paths.
    pub fn new(owner: AgentId, pointer: AgentAvatarBlobPointer) -> Self {
        Self { owner, pointer }
    }

    pub fn owner(&self) -> &AgentId {
        &self.owner
    }

    pub fn pointer(&self) -> &AgentAvatarBlobPointer {
        &self.pointer
    }
}

/// The narrow READ capability for agent avatar blobs, keyed by the owner-bound
/// [`OwnedAgentAvatarBlob`]. It is deliberately read-only and agent-specific: the
/// byte fetch never mints or deletes, and never sees the user pointer. The
/// production adapter shares its key→bytes plumbing with the user read, but it
/// verifies the key belongs to the bound owner BEFORE reading, so the domain
/// capability is its own and its custody is per-owner, not merely per-family.
pub trait AgentAvatarBlobRead: Clone + Send + Sync + 'static {
    fn read(
        &self,
        blob: &OwnedAgentAvatarBlob,
    ) -> impl Future<Output = Result<AvatarBlobReadOutcome, AvatarStorageFailure>> + Send;
}

/// The full agent-avatar blob capability: the narrow [`AgentAvatarBlobRead`] plus the
/// mutating `put`/`delete` the upload and clear routes own. Distinct from the user
/// [`crate::avatar::AvatarBlobStore`]: the two custodies never share a domain type, and
/// the production adapter MUST mint agent keys under a DIFFERENT static namespace than
/// user keys — so even if an [`AgentId`] and a [`crate::identity::UserId`] carry the
/// same raw string, their blobs never collide. `put` mints a FRESH physical key on
/// every call (re-uploading identical bytes never clobbers or cache-hits), returning
/// the agent-owned [`AgentAvatarBlobPointer`]; only the private `StoredBlob`
/// read/delete plumbing is shared with the user adapter.
pub trait AgentAvatarBlobStore: AgentAvatarBlobRead {
    /// Store `bytes` for `agent_id` under a fresh key and return its pointer.
    fn put(
        &self,
        agent_id: &AgentId,
        content_type: AvatarContentType,
        bytes: Vec<u8>,
    ) -> impl Future<Output = Result<AgentAvatarBlobPointer, AvatarStorageFailure>> + Send;

    /// Best-effort delete of an OWNER-BOUND blob. A failure never flips an
    /// already-committed pointer write (the DB pointer is authoritative), but the
    /// orchestration CARRIES its fate for the boundary to log rather than dropping it. A
    /// key outside the bound owner's namespace is REFUSED before the store is touched, so
    /// a cross-wired pointer can never delete another agent's blob.
    fn delete(
        &self,
        blob: &OwnedAgentAvatarBlob,
    ) -> impl Future<Output = Result<(), AvatarStorageFailure>> + Send;
}

/// The avatar an upload asks the row to carry: a fresh blob pointer paired with its
/// validated content type. It is exactly the payload of [`AgentAvatarRow::Present`],
/// named on its own because it is the `Set` arm of the avatar column edit — the two
/// coupled columns are always written and cleared together.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAvatarAssignment {
    pub pointer: AgentAvatarBlobPointer,
    pub content_type: AvatarContentType,
}

/// The avatar coordinate held by an EXISTING agents row, decoded as one typed shape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentAvatarRow {
    /// Both columns are `NULL`: the agent carries no avatar.
    Absent,
    /// Both columns are present, the key non-empty and the content type an allowlist
    /// member: the serve coordinate.
    Present {
        pointer: AgentAvatarBlobPointer,
        content_type: AvatarContentType,
    },
}

/// The serve-ref read result, decoded under the strict four-state contract. A row that
/// exists is always source-bound; a row that does not is [`Self::NoRow`]. Corruption is
/// NOT an arm — it is a [`PersistenceFailure`] — so a value of this type is always a
/// trustworthy clean state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentAvatarServeRef {
    /// No agents row for the id — a race where the row was deleted after the
    /// visibility gate. The product result is `avatar not found`.
    NoRow,
    /// A row exists, carrying its read-back source id for the pre-blob bind and its
    /// decoded avatar state. `source` present iff a row exists — the invariant is
    /// unrepresentable when violated.
    Row {
        source: AgentId,
        avatar: AgentAvatarRow,
    },
}

/// A stored agent avatar pair that could not have come from the write path: an
/// unreadable row id, exactly one column present, an empty storage key, or a content
/// type outside the allowlist. Each arm names the specific integrity violation for the
/// boundary log; all map to the same safe `500`.
#[derive(Debug, Error)]
pub enum AgentAvatarRowCorruption {
    #[error("agents row has an unreadable id")]
    UnreadableRowId,
    #[error("agents row has an avatar_content_type but no avatar_storage_key")]
    ContentTypeWithoutKey,
    #[error("agents row has an avatar_storage_key but no avatar_content_type")]
    KeyWithoutContentType,
    #[error("agents row stores an empty avatar_storage_key")]
    EmptyStorageKey,
    #[error("agents row stores an avatar_content_type outside the allowlist")]
    UnknownContentType,
}

impl From<EmptyAgentAvatarBlobPointer> for AgentAvatarRowCorruption {
    fn from(_: EmptyAgentAvatarBlobPointer) -> Self {
        Self::EmptyStorageKey
    }
}

/// Decode ONE existing agents row: its read-back `id` plus the stored
/// `(avatar_storage_key, avatar_content_type)` pair, under the strict four-state
/// contract (see the module docs). The columns arrive exactly as the row holds them:
/// `None` for SQL `NULL`, `Some` otherwise. A caller with NO row must report
/// [`AgentAvatarServeRef::NoRow`] directly rather than calling this.
pub fn decode_agent_avatar_row(
    row_id: &str,
    storage_key: Option<&str>,
    content_type: Option<&str>,
) -> Result<AgentAvatarServeRef, AgentAvatarRowCorruption> {
    // The row id is read back so the serve fact can be bound to the request; an id
    // that no longer parses is corruption, never a silent unbound serve.
    let source = AgentId::parse(row_id).map_err(|_| AgentAvatarRowCorruption::UnreadableRowId)?;
    let avatar = match (storage_key, content_type) {
        (None, None) => AgentAvatarRow::Absent,
        (Some(_), None) => return Err(AgentAvatarRowCorruption::KeyWithoutContentType),
        (None, Some(_)) => return Err(AgentAvatarRowCorruption::ContentTypeWithoutKey),
        (Some(key), Some(content_type)) => {
            // An empty key never came from the writer (a clear NULLs both columns), so
            // it is corruption — not the user path's cosmetic "no avatar" fold.
            let pointer = AgentAvatarBlobPointer::parse(key)?;
            let content_type = AvatarContentType::parse(content_type)
                .ok_or(AgentAvatarRowCorruption::UnknownContentType)?;
            AgentAvatarRow::Present {
                pointer,
                content_type,
            }
        }
    };
    Ok(AgentAvatarServeRef::Row { source, avatar })
}

/// Resolve an agent's avatar serve ref by id, decoded under the strict four-state
/// contract. A missing row is [`AgentAvatarServeRef::NoRow`]; an existing row is always
/// source-bound; corruption is a [`PersistenceFailure`], never a clean arm.
pub trait AgentAvatarServeRefRead: Clone + Send + Sync + 'static {
    fn read_agent_avatar_serve_ref(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<AgentAvatarServeRef, PersistenceFailure>> + Send;
}

/// The closed outcome of [`fetch_agent_avatar`].
#[derive(Debug)]
pub enum AgentAvatarFetchOutcome {
    /// Serve these bytes with this content type and download filename.
    Found {
        bytes: Vec<u8>,
        content_type: AvatarContentType,
        filename: String,
    },
    /// The agent has no row, or the row carries no avatar (both columns `NULL`): the
    /// product `avatar not found` (404). A dangling pointer is NOT here — that is a
    /// storage inconsistency, below.
    NotFound,
    /// A `Present` row's bytes could not be served: either the blob backend read
    /// FAULTED, or the pointer cleanly resolved to [`AvatarBlobReadOutcome::Missing`]
    /// while the row asserts the avatar exists. Both are storage inconsistencies the
    /// route maps to a safe `500` with `cause` logged; never a product answer.
    StorageUnavailable { cause: AvatarStorageFailure },
}

/// A serve fact whose read-back source id does not match the requested agent: a
/// cross-wired serve-ref adapter. Surfaced as a [`PersistenceFailure`] (safe `500`)
/// with the blob left untouched.
#[derive(Debug, Error)]
#[error(
    "agent avatar serve ref resolved for {} but {} was requested",
    .served.as_str(),
    .requested.as_str()
)]
struct AgentAvatarSourceMismatch {
    requested: AgentId,
    served: AgentId,
}

/// A `Present` row whose blob resolved to no stored bytes: the DB asserts the avatar
/// exists but the backend has none. Carries the pointer for the boundary log.
#[derive(Debug, Error)]
#[error("agent avatar pointer {0} resolved to no stored bytes")]
struct DanglingAgentAvatarBlob(String);

/// Fetch an agent's avatar bytes by id. The caller must already have passed the agent
/// visibility authority; this touches the blob only for an admitted request whose
/// serve-ref row is source-bound to the request.
pub async fn fetch_agent_avatar<R, B>(
    refs: &R,
    blobs: &B,
    agent: &AgentId,
) -> Result<AgentAvatarFetchOutcome, PersistenceFailure>
where
    R: AgentAvatarServeRefRead,
    B: AgentAvatarBlobRead,
{
    let (source, avatar) = match refs.read_agent_avatar_serve_ref(agent).await? {
        AgentAvatarServeRef::NoRow => return Ok(AgentAvatarFetchOutcome::NotFound),
        AgentAvatarServeRef::Row { source, avatar } => (source, avatar),
    };
    // Bind the read-back row id to the request BEFORE any blob read: a serve fact for
    // another agent is a resolver defect (safe-500), never B's bytes on A's response.
    if &source != agent {
        return Err(PersistenceFailure::from_source(AgentAvatarSourceMismatch {
            requested: agent.clone(),
            served: source,
        }));
    }
    let (pointer, content_type) = match avatar {
        AgentAvatarRow::Absent => return Ok(AgentAvatarFetchOutcome::NotFound),
        AgentAvatarRow::Present {
            pointer,
            content_type,
        } => (pointer, content_type),
    };
    // Bind the pointer to the requested (== source) owner: the adapter verifies the
    // physical key lies in THIS agent's namespace before reading, so a cross-wired key
    // inside A's own row that physically addresses B's blob is refused, not served.
    let owned = OwnedAgentAvatarBlob::new(agent.clone(), pointer);
    match blobs.read(&owned).await {
        Ok(AvatarBlobReadOutcome::Found(bytes)) => Ok(AgentAvatarFetchOutcome::Found {
            bytes,
            content_type,
            filename: content_type.download_filename(),
        }),
        // A present row asserts its bytes exist; a clean Missing is therefore a storage
        // inconsistency (safe-500), matching the TS route's uncaught serve() ENOENT —
        // NOT the product 404 an absent pointer gets.
        Ok(AvatarBlobReadOutcome::Missing) => Ok(AgentAvatarFetchOutcome::StorageUnavailable {
            cause: AvatarStorageFailure::from_source(DanglingAgentAvatarBlob(
                owned.pointer().as_str().to_owned(),
            )),
        }),
        Err(cause) => Ok(AgentAvatarFetchOutcome::StorageUnavailable { cause }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_id() -> AgentId {
        AgentId::parse("agent-1").unwrap()
    }

    // ---- the four-state decode ----

    #[test]
    fn a_row_with_both_columns_null_is_absent_and_source_bound() {
        let decoded = decode_agent_avatar_row("agent-1", None, None).unwrap();
        assert_eq!(
            decoded,
            AgentAvatarServeRef::Row {
                source: agent_id(),
                avatar: AgentAvatarRow::Absent,
            }
        );
    }

    #[test]
    fn both_present_and_valid_is_the_serve_coordinate() {
        let decoded = decode_agent_avatar_row(
            "agent-1",
            Some("agents/a1/avatars/blob-0.png"),
            Some("image/png"),
        )
        .unwrap();
        let AgentAvatarServeRef::Row {
            source,
            avatar:
                AgentAvatarRow::Present {
                    pointer,
                    content_type,
                },
        } = decoded
        else {
            panic!("expected Row/Present");
        };
        assert_eq!(source, agent_id());
        assert_eq!(pointer.as_str(), "agents/a1/avatars/blob-0.png");
        assert_eq!(content_type, AvatarContentType::Png);
    }

    #[test]
    fn a_half_populated_pair_is_corruption_not_missing() {
        assert!(matches!(
            decode_agent_avatar_row("agent-1", Some("agents/a1/avatars/blob-0.png"), None),
            Err(AgentAvatarRowCorruption::KeyWithoutContentType)
        ));
        assert!(matches!(
            decode_agent_avatar_row("agent-1", None, Some("image/png")),
            Err(AgentAvatarRowCorruption::ContentTypeWithoutKey)
        ));
    }

    #[test]
    fn an_empty_key_is_corruption_unlike_the_users_no_avatar_fold() {
        assert!(matches!(
            decode_agent_avatar_row("agent-1", Some(""), Some("image/png")),
            Err(AgentAvatarRowCorruption::EmptyStorageKey)
        ));
    }

    #[test]
    fn a_content_type_outside_the_allowlist_is_corruption() {
        assert!(matches!(
            decode_agent_avatar_row(
                "agent-1",
                Some("agents/a1/avatars/blob-0.svg"),
                Some("image/svg+xml")
            ),
            Err(AgentAvatarRowCorruption::UnknownContentType)
        ));
        assert!(matches!(
            decode_agent_avatar_row("agent-1", Some("agents/a1/avatars/blob-0"), Some("")),
            Err(AgentAvatarRowCorruption::UnknownContentType)
        ));
    }

    #[test]
    fn an_unreadable_row_id_is_corruption() {
        assert!(matches!(
            decode_agent_avatar_row("", None, None),
            Err(AgentAvatarRowCorruption::UnreadableRowId)
        ));
    }

    // ---- fetch orchestration ----

    #[derive(Clone)]
    struct FakeRefs(Result<AgentAvatarServeRef, ()>);
    impl AgentAvatarServeRefRead for FakeRefs {
        async fn read_agent_avatar_serve_ref(
            &self,
            _agent: &AgentId,
        ) -> Result<AgentAvatarServeRef, PersistenceFailure> {
            self.0.clone().map_err(|()| {
                PersistenceFailure::from_source(std::io::Error::other("ref read down"))
            })
        }
    }

    #[derive(Clone)]
    struct FakeBlob {
        outcome: Option<AvatarBlobReadOutcome>,
        fail: bool,
        read: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }
    impl FakeBlob {
        fn new(outcome: Option<AvatarBlobReadOutcome>, fail: bool) -> Self {
            Self {
                outcome,
                fail,
                read: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }
        }
        fn reads(&self) -> usize {
            self.read.load(std::sync::atomic::Ordering::SeqCst)
        }
    }
    impl AgentAvatarBlobRead for FakeBlob {
        async fn read(
            &self,
            _blob: &OwnedAgentAvatarBlob,
        ) -> Result<AvatarBlobReadOutcome, AvatarStorageFailure> {
            self.read.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail {
                #[derive(Debug, Error)]
                #[error("read fault")]
                struct ReadFault;
                return Err(AvatarStorageFailure::from_source(ReadFault));
            }
            Ok(self
                .outcome
                .clone()
                .unwrap_or(AvatarBlobReadOutcome::Missing))
        }
    }

    fn present_row_for(source: &str) -> AgentAvatarServeRef {
        AgentAvatarServeRef::Row {
            source: AgentId::parse(source).unwrap(),
            avatar: AgentAvatarRow::Present {
                pointer: AgentAvatarBlobPointer::parse("agents/a1/avatars/blob-0.jpeg").unwrap(),
                content_type: AvatarContentType::Jpeg,
            },
        }
    }

    #[tokio::test]
    async fn fetch_serves_found_bytes_with_the_stored_type_and_filename() {
        let refs = FakeRefs(Ok(present_row_for("agent-1")));
        let blobs = FakeBlob::new(Some(AvatarBlobReadOutcome::Found(vec![7, 8, 9])), false);
        let AgentAvatarFetchOutcome::Found {
            bytes,
            content_type,
            filename,
        } = fetch_agent_avatar(&refs, &blobs, &agent_id())
            .await
            .unwrap()
        else {
            panic!("expected Found");
        };
        assert_eq!(bytes, vec![7, 8, 9]);
        assert_eq!(content_type, AvatarContentType::Jpeg);
        assert_eq!(filename, "avatar.jpeg");
    }

    #[tokio::test]
    async fn fetch_is_not_found_for_no_row() {
        let refs = FakeRefs(Ok(AgentAvatarServeRef::NoRow));
        let blobs = FakeBlob::new(None, false);
        assert!(matches!(
            fetch_agent_avatar(&refs, &blobs, &agent_id())
                .await
                .unwrap(),
            AgentAvatarFetchOutcome::NotFound
        ));
        assert_eq!(blobs.reads(), 0);
    }

    #[tokio::test]
    async fn fetch_is_not_found_when_the_row_carries_no_avatar() {
        let refs = FakeRefs(Ok(AgentAvatarServeRef::Row {
            source: agent_id(),
            avatar: AgentAvatarRow::Absent,
        }));
        let blobs = FakeBlob::new(None, false);
        assert!(matches!(
            fetch_agent_avatar(&refs, &blobs, &agent_id())
                .await
                .unwrap(),
            AgentAvatarFetchOutcome::NotFound
        ));
        assert_eq!(blobs.reads(), 0);
    }

    #[tokio::test]
    async fn a_clean_blob_missing_is_a_storage_inconsistency_not_a_404() {
        let refs = FakeRefs(Ok(present_row_for("agent-1")));
        let blobs = FakeBlob::new(Some(AvatarBlobReadOutcome::Missing), false);
        assert!(
            matches!(
                fetch_agent_avatar(&refs, &blobs, &agent_id())
                    .await
                    .unwrap(),
                AgentAvatarFetchOutcome::StorageUnavailable { .. }
            ),
            "a present row asserts its bytes exist; a Missing blob is a safe-500, not `avatar not found`"
        );
    }

    #[tokio::test]
    async fn a_hard_blob_read_fault_is_storage_unavailable_with_a_cause() {
        let refs = FakeRefs(Ok(present_row_for("agent-1")));
        let blobs = FakeBlob::new(None, true);
        assert!(matches!(
            fetch_agent_avatar(&refs, &blobs, &agent_id())
                .await
                .unwrap(),
            AgentAvatarFetchOutcome::StorageUnavailable { .. }
        ));
    }

    #[tokio::test]
    async fn a_serve_ref_for_another_agent_is_a_safe_500_with_the_blob_untouched() {
        // Request agent-1, serve fact source=agent-2: the source-bind refuses it before
        // any blob read, so B's bytes never splice onto A's response.
        let refs = FakeRefs(Ok(present_row_for("agent-2")));
        let blobs = FakeBlob::new(Some(AvatarBlobReadOutcome::Found(vec![9, 9, 9])), false);
        fetch_agent_avatar(&refs, &blobs, &agent_id())
            .await
            .expect_err("a serve fact resolved for another agent has no product answer");
        assert_eq!(
            blobs.reads(),
            0,
            "the blob must not be touched on a source mismatch"
        );
    }

    #[tokio::test]
    async fn a_ref_read_failure_propagates_as_a_persistence_failure() {
        let refs = FakeRefs(Err(()));
        let blobs = FakeBlob::new(None, false);
        fetch_agent_avatar(&refs, &blobs, &agent_id())
            .await
            .expect_err("a corrupt/failed ref read has no product answer");
    }
}
