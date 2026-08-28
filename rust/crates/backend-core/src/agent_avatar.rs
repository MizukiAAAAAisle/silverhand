//! The public agent-avatar byte fetch — `GET /api/agents/{id}/avatar`.
//!
//! This is the agent analog of the `users` avatar fetch ([`crate::avatar`]), and it
//! reuses that leaf's avatar VOCABULARY wholesale: the content-type allowlist
//! ([`AvatarContentType`]), the opaque blob pointer ([`AvatarBlobPointer`]), and the
//! narrow read capability ([`AvatarBlobRead`]). What it does NOT reuse is the user
//! path's serve-ref read: the agents row is decoded under a STRICTER four-state
//! contract, so its own narrow read authority is defined here.
//!
//! ## The four states of the stored `(avatar_storage_key, avatar_content_type)` pair
//!
//! The two columns are decoded as ONE typed row shape — never each on its own — so a
//! below-write-path corruption can never masquerade as "no avatar":
//!
//!  1. BOTH absent (`NULL`/`NULL`, or no row at all) → [`AgentAvatarServeRef::Absent`],
//!     which the fetch reports as the product `avatar not found` (404).
//!  2. BOTH present, the key non-empty and the content type a member of the allowlist
//!     → [`AgentAvatarServeRef::Present`], the serve coordinate.
//!  3. ANY other combination — exactly one side present, an empty key, or a stored
//!     content type outside the allowlist — is [`AgentAvatarRowCorruption`]: a
//!     below-write-path integrity fault the adapter surfaces as a
//!     [`PersistenceFailure`] (a safe `500` carrying its cause), NEVER folded into
//!     the `avatar not found` of state 1. The schema CHECK couples the two columns'
//!     NULL-ness, so a half-populated pair is unreachable through the write path; it
//!     is treated as corruption precisely because only corruption could produce it.
//!
//! The only production writer of these columns stores a non-empty admitted key and an
//! allowlisted content type together, so a legitimately avatar-less agent carries
//! BOTH columns `NULL` (a clear NULLs both) — never an empty string. That is why an
//! empty key is corruption here, unlike the `users` DTO's cosmetic `avatar_url` fold,
//! which merely omits a link.
//!
//! ## The blob is not touched until visibility is settled
//!
//! Access precedes product: the server route runs the agent VISIBILITY authority
//! FIRST (an absent, invisible, or hidden-stage agent is one anti-enumeration `404`),
//! and only an admitted caller reaches this read at all. A clean blob `Missing` —
//! the row points at bytes that are gone — collapses to the SAME `avatar not found`
//! as an absent pointer; only a hard blob-backend read FAULT is the safe `500`, with
//! its cause carried to the boundary log.

use std::future::Future;

use thiserror::Error;

use crate::{
    avatar::{
        AvatarBlobPointer, AvatarBlobRead, AvatarBlobReadOutcome, AvatarContentType,
        AvatarStorageFailure, EmptyAvatarBlobPointer,
    },
    identity::AgentId,
    persistence::PersistenceFailure,
};

/// The agent-row avatar coordinate for the byte fetch, decoded as ONE typed shape.
/// Corruption is NOT an arm: a half-populated or malformed pair is an
/// [`AgentAvatarRowCorruption`] the read surfaces as a [`PersistenceFailure`], so a
/// value of this type is always a trustworthy clean state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentAvatarServeRef {
    /// Both columns are absent (or there is no row). The agent carries no avatar;
    /// the fetch reports `avatar not found`.
    Absent,
    /// Both columns are present, the key non-empty and the content type an allowlist
    /// member: the serve coordinate.
    Present {
        pointer: AvatarBlobPointer,
        content_type: AvatarContentType,
    },
}

/// A stored agent avatar pair that could not have come from the write path: exactly
/// one column present, an empty storage key, or a content type outside the
/// allowlist. Each arm names the specific integrity violation for the boundary log;
/// all map to the same safe `500`.
#[derive(Debug, Error)]
pub enum AgentAvatarRowCorruption {
    #[error("agents row has an avatar_content_type but no avatar_storage_key")]
    ContentTypeWithoutKey,
    #[error("agents row has an avatar_storage_key but no avatar_content_type")]
    KeyWithoutContentType,
    #[error("agents row stores an empty avatar_storage_key")]
    EmptyStorageKey,
    #[error("agents row stores an avatar_content_type outside the allowlist")]
    UnknownContentType,
}

impl From<EmptyAvatarBlobPointer> for AgentAvatarRowCorruption {
    fn from(_: EmptyAvatarBlobPointer) -> Self {
        Self::EmptyStorageKey
    }
}

/// Decode the stored `(avatar_storage_key, avatar_content_type)` pair as ONE typed
/// shape under the strict four-state contract (see the module docs). The two columns
/// arrive exactly as the row holds them: `None` for SQL `NULL`, `Some` otherwise.
pub fn decode_agent_avatar_serve_ref(
    storage_key: Option<&str>,
    content_type: Option<&str>,
) -> Result<AgentAvatarServeRef, AgentAvatarRowCorruption> {
    match (storage_key, content_type) {
        (None, None) => Ok(AgentAvatarServeRef::Absent),
        (Some(_), None) => Err(AgentAvatarRowCorruption::KeyWithoutContentType),
        (None, Some(_)) => Err(AgentAvatarRowCorruption::ContentTypeWithoutKey),
        (Some(key), Some(content_type)) => {
            // An empty key never came from the writer (a clear NULLs both columns), so
            // it is corruption — not the user path's "no avatar" fold.
            let pointer = AvatarBlobPointer::parse(key)?;
            let content_type = AvatarContentType::parse(content_type)
                .ok_or(AgentAvatarRowCorruption::UnknownContentType)?;
            Ok(AgentAvatarServeRef::Present {
                pointer,
                content_type,
            })
        }
    }
}

/// Resolve an agent's avatar serve ref by id, decoded under the strict four-state
/// contract. A missing row is [`AgentAvatarServeRef::Absent`] (the same as a both-NULL
/// pair); corruption is a [`PersistenceFailure`], never a clean arm.
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
    /// The agent carries no avatar, OR the row's pointer resolved to no stored bytes
    /// (a clean blob `Missing`): both are the product `avatar not found` (404). A
    /// clean Missing is NOT a safe-500 here — that is the deliberate divergence from
    /// the `users` fetch, which treats a Missing blob as a storage inconsistency.
    NotFound,
    /// A hard blob-backend read FAULT — the read itself failed, distinct from a
    /// pointer that cleanly resolved to nothing. The route maps it to a safe `500`
    /// and logs `cause`; it is never a product answer.
    StorageUnavailable { cause: AvatarStorageFailure },
}

/// Fetch an agent's avatar bytes by id. The caller must already have passed the
/// agent visibility authority; this touches the blob only for an admitted request.
pub async fn fetch_agent_avatar<R, B>(
    refs: &R,
    blobs: &B,
    agent: &AgentId,
) -> Result<AgentAvatarFetchOutcome, PersistenceFailure>
where
    R: AgentAvatarServeRefRead,
    B: AvatarBlobRead,
{
    match refs.read_agent_avatar_serve_ref(agent).await? {
        AgentAvatarServeRef::Absent => Ok(AgentAvatarFetchOutcome::NotFound),
        AgentAvatarServeRef::Present {
            pointer,
            content_type,
        } => match blobs.read(&pointer).await {
            Ok(AvatarBlobReadOutcome::Found(bytes)) => Ok(AgentAvatarFetchOutcome::Found {
                bytes,
                content_type,
                filename: content_type.download_filename(),
            }),
            // A clean Missing collapses to `avatar not found`, exactly like an absent
            // pointer; only a hard read fault is the safe-500.
            Ok(AvatarBlobReadOutcome::Missing) => Ok(AgentAvatarFetchOutcome::NotFound),
            Err(cause) => Ok(AgentAvatarFetchOutcome::StorageUnavailable { cause }),
        },
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
    fn both_absent_is_the_absent_ref() {
        assert_eq!(
            decode_agent_avatar_serve_ref(None, None).unwrap(),
            AgentAvatarServeRef::Absent
        );
    }

    #[test]
    fn both_present_and_valid_is_the_serve_coordinate() {
        let decoded = decode_agent_avatar_serve_ref(
            Some("agents/a1/avatars/blob-0.png"),
            Some("image/png"),
        )
        .unwrap();
        let AgentAvatarServeRef::Present {
            pointer,
            content_type,
        } = decoded
        else {
            panic!("expected Present");
        };
        assert_eq!(pointer.as_str(), "agents/a1/avatars/blob-0.png");
        assert_eq!(content_type, AvatarContentType::Png);
    }

    #[test]
    fn a_half_populated_pair_is_corruption_not_missing() {
        // Only one column present, either way, is corruption — never folded into the
        // both-absent `avatar not found`.
        assert!(matches!(
            decode_agent_avatar_serve_ref(Some("agents/a1/avatars/blob-0.png"), None),
            Err(AgentAvatarRowCorruption::KeyWithoutContentType)
        ));
        assert!(matches!(
            decode_agent_avatar_serve_ref(None, Some("image/png")),
            Err(AgentAvatarRowCorruption::ContentTypeWithoutKey)
        ));
    }

    #[test]
    fn an_empty_key_is_corruption_unlike_the_users_no_avatar_fold() {
        // A clear NULLs both columns, so an empty key never came from the writer.
        assert!(matches!(
            decode_agent_avatar_serve_ref(Some(""), Some("image/png")),
            Err(AgentAvatarRowCorruption::EmptyStorageKey)
        ));
    }

    #[test]
    fn a_content_type_outside_the_allowlist_is_corruption() {
        assert!(matches!(
            decode_agent_avatar_serve_ref(Some("agents/a1/avatars/blob-0.svg"), Some("image/svg+xml")),
            Err(AgentAvatarRowCorruption::UnknownContentType)
        ));
        // A present-but-empty content type is equally out of the set.
        assert!(matches!(
            decode_agent_avatar_serve_ref(Some("agents/a1/avatars/blob-0"), Some("")),
            Err(AgentAvatarRowCorruption::UnknownContentType)
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
    }
    impl AvatarBlobRead for FakeBlob {
        async fn read(
            &self,
            _pointer: &AvatarBlobPointer,
        ) -> Result<AvatarBlobReadOutcome, AvatarStorageFailure> {
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

    fn present_ref() -> AgentAvatarServeRef {
        AgentAvatarServeRef::Present {
            pointer: AvatarBlobPointer::parse("agents/a1/avatars/blob-0.jpeg").unwrap(),
            content_type: AvatarContentType::Jpeg,
        }
    }

    #[tokio::test]
    async fn fetch_serves_found_bytes_with_the_stored_type_and_filename() {
        let refs = FakeRefs(Ok(present_ref()));
        let blobs = FakeBlob {
            outcome: Some(AvatarBlobReadOutcome::Found(vec![7, 8, 9])),
            fail: false,
        };
        let AgentAvatarFetchOutcome::Found {
            bytes,
            content_type,
            filename,
        } = fetch_agent_avatar(&refs, &blobs, &agent_id()).await.unwrap()
        else {
            panic!("expected Found");
        };
        assert_eq!(bytes, vec![7, 8, 9]);
        assert_eq!(content_type, AvatarContentType::Jpeg);
        assert_eq!(filename, "avatar.jpeg");
    }

    #[tokio::test]
    async fn fetch_is_not_found_when_the_ref_is_absent() {
        let refs = FakeRefs(Ok(AgentAvatarServeRef::Absent));
        let blobs = FakeBlob {
            outcome: None,
            fail: false,
        };
        assert!(matches!(
            fetch_agent_avatar(&refs, &blobs, &agent_id()).await.unwrap(),
            AgentAvatarFetchOutcome::NotFound
        ));
    }

    #[tokio::test]
    async fn a_clean_blob_missing_is_not_found_not_a_safe_500() {
        let refs = FakeRefs(Ok(present_ref()));
        let blobs = FakeBlob {
            outcome: Some(AvatarBlobReadOutcome::Missing),
            fail: false,
        };
        assert!(
            matches!(
                fetch_agent_avatar(&refs, &blobs, &agent_id()).await.unwrap(),
                AgentAvatarFetchOutcome::NotFound
            ),
            "a clean Missing collapses to `avatar not found`, the agent-face divergence"
        );
    }

    #[tokio::test]
    async fn a_hard_blob_read_fault_is_storage_unavailable_with_a_cause() {
        let refs = FakeRefs(Ok(present_ref()));
        let blobs = FakeBlob {
            outcome: None,
            fail: true,
        };
        assert!(matches!(
            fetch_agent_avatar(&refs, &blobs, &agent_id()).await.unwrap(),
            AgentAvatarFetchOutcome::StorageUnavailable { .. }
        ));
    }

    #[tokio::test]
    async fn a_ref_read_failure_propagates_as_a_persistence_failure() {
        let refs = FakeRefs(Err(()));
        let blobs = FakeBlob {
            outcome: None,
            fail: false,
        };
        fetch_agent_avatar(&refs, &blobs, &agent_id())
            .await
            .expect_err("a corrupt/failed ref read has no product answer");
    }
}
