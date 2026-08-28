//! The production avatar blob adapter: satisfy the avatar routes' narrow blob
//! capabilities by driving the generic content-addressed [`BlobStore`] (in production,
//! the filesystem `LocalBlobStore` from #2221) under one ambient storage kind.
//!
//! It serves the full user capability ([`AvatarBlobStore`]: put/read/delete keyed by
//! [`UserId`]) and the read-only agent capability ([`AgentAvatarBlobRead`], keyed by the
//! agent-owned [`AgentAvatarBlobPointer`]). The two pointer custodies are DISTINCT
//! domain types; only this adapter's private key→bytes plumbing
//! ([`SingleKindAvatarBlobs::read_stored_key`]) is shared, because physical resolution
//! under the ambient kind is identical. Custody is not left to the newtype alone: the
//! agent read/delete capabilities enforce it here ([`ensure_agent_custody`]), refusing
//! any key outside agent scope BEFORE it touches the store, so a cross-wired or corrupted
//! `agents.avatar_storage_key` can never reach a user's blob.
//!
//! The avatar leaf ships no blob backend of its own and depends only on the
//! narrow [`AvatarBlobStore`] capability; the storage KIND is the adapter's,
//! never crossing the DB or the wire (`crate::avatar` doc). This adapter therefore
//! owns that single kind: every `put` stores the bytes under a fixed static scope
//! (`avatars`), namespaced per user via [`BlobNamespace::for_semantic_id`] so an
//! opaque user id carrying separators never becomes a path component, and returns
//! the minted physical key AS the opaque [`AvatarBlobPointer`]; `read`/`delete`
//! reconstruct the [`StoredBlob`] from that key under the ambient kind.
//!
//! The ambient [`StorageKind`] is an explicit construction input rather than a
//! hardcoded constant, so this adapter is a pure anti-corruption layer over ANY
//! single-backend [`BlobStore`] (a test drives it with an in-memory double). The
//! composition root's contract is to pair the kind with the backend it actually
//! wraps — production supplies [`StorageKind::Local`] alongside the local
//! filesystem store. A mismatch is a composition wiring error, not a runtime
//! condition: it surfaces at once as a read that resolves to `Missing` (the key
//! rebuilt under the wrong kind finds no bytes), never silent data corruption.

use silverhand_backend_core::{
    agent_avatar::{AgentAvatarBlobPointer, AgentAvatarBlobRead, AgentAvatarBlobStore},
    avatar::{
        AvatarBlobPointer, AvatarBlobRead, AvatarBlobReadOutcome, AvatarBlobStore,
        AvatarContentType, AvatarStorageFailure,
    },
    blob_store::{
        BlobNamespace, BlobReadOutcome, BlobStorageKey, BlobStore, StorageKind, StoredBlob,
    },
    identity::{AgentId, UserId},
};

/// The fixed static scope every USER avatar blob is namespaced under. The per-user
/// segment is derived losslessly from the opaque user id by the namespace builder.
const AVATAR_SCOPE: &str = "avatars";

/// The fixed static scope every AGENT avatar blob is namespaced under — DISTINCT from
/// [`AVATAR_SCOPE`] so the two custodies never collide even when an [`AgentId`] and a
/// [`UserId`] carry the same raw string: their blobs live under different scope
/// prefixes. The mutating agent capability owns its own namespace, mirroring the
/// separation of the [`AgentAvatarBlobPointer`] domain type from the user pointer.
const AGENT_AVATAR_SCOPE: &str = "agent-avatars";

/// The legacy TS agent-avatar scope: keys minted before the Rust migration live under
/// `agents/<id>/avatars/...`. Accepted as agent custody so migrated rows keep resolving.
const LEGACY_AGENT_AVATAR_SCOPE: &str = "agents";

/// Enforce that a raw blob key belongs to AGENT custody BEFORE it is resolved against
/// the backing store. Custody is a real persistence-boundary check, not merely a newtype
/// name: a key's first path segment (its scope) must be the new Rust agent scope or the
/// legacy TS agent scope. Any other scope — notably the USER [`AVATAR_SCOPE`] — is
/// refused here, so a cross-wired or corrupted `agents.avatar_storage_key` can never read
/// or delete a user's blob through the agent capability. Default-deny: an unknown scope
/// is refused, never resolved.
fn ensure_agent_custody(key: &str) -> Result<(), AvatarStorageFailure> {
    let scope = key.split('/').next().unwrap_or_default();
    if scope == AGENT_AVATAR_SCOPE || scope == LEGACY_AGENT_AVATAR_SCOPE {
        return Ok(());
    }
    /// A blob key presented to the agent capability that is not in agent custody — a
    /// foreign (user or unknown) scope. Refused before touching the store. `thiserror`
    /// is only a dev-dependency of this crate, so the `Display`/`Error` impls are
    /// hand-written for this production error type.
    #[derive(Debug)]
    struct ForeignCustody {
        key: String,
    }
    impl std::fmt::Display for ForeignCustody {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "blob key {:?} is not in agent avatar custody", self.key)
        }
    }
    impl std::error::Error for ForeignCustody {}
    Err(AvatarStorageFailure::from_source(ForeignCustody {
        key: key.to_owned(),
    }))
}

/// Drives a single-backend [`BlobStore`] as the avatar leaf's [`AvatarBlobStore`].
/// `kind` is the one storage kind the wrapped backend reports; it is reconstructed
/// into every [`StoredBlob`] on read/delete because the pointer persists only the
/// key (the kind is ambient and never leaves this adapter).
#[derive(Clone)]
pub struct SingleKindAvatarBlobs<B> {
    blobs: B,
    kind: StorageKind,
}

impl<B> SingleKindAvatarBlobs<B> {
    /// Wrap `blobs` under its ambient `kind`. The caller must pass the storage kind
    /// the backend actually produces (production: [`StorageKind::Local`] with the
    /// filesystem store).
    pub fn new(blobs: B, kind: StorageKind) -> Self {
        Self { blobs, kind }
    }
}

impl<B: BlobStore> SingleKindAvatarBlobs<B> {
    /// Rebuild the physical [`StoredBlob`] coordinate from a stored key under the
    /// ambient kind. A key that is not valid (a corrupt DB row) is a storage fault,
    /// not a product answer. Shared by both custody pointers — the domain types differ,
    /// but the physical key resolution is identical.
    fn stored_from_key(&self, key: &str) -> Result<StoredBlob, AvatarStorageFailure> {
        let key = BlobStorageKey::parse(key).map_err(AvatarStorageFailure::from_source)?;
        Ok(StoredBlob::new(self.kind, key))
    }

    /// Read the bytes at a stored key under the ambient kind. The private plumbing both
    /// the user ([`AvatarBlobRead`]) and agent ([`AgentAvatarBlobRead`]) read
    /// capabilities delegate to; the custody distinction lives in the pointer types,
    /// never here.
    async fn read_stored_key(
        &self,
        key: &str,
    ) -> Result<AvatarBlobReadOutcome, AvatarStorageFailure> {
        let stored = self.stored_from_key(key)?;
        match self
            .blobs
            .read(&stored)
            .await
            .map_err(AvatarStorageFailure::from_source)?
        {
            BlobReadOutcome::Found(read) => Ok(AvatarBlobReadOutcome::Found(read.into_bytes())),
            BlobReadOutcome::Missing => Ok(AvatarBlobReadOutcome::Missing),
        }
    }
}

impl<B: BlobStore> AvatarBlobRead for SingleKindAvatarBlobs<B> {
    async fn read(
        &self,
        pointer: &AvatarBlobPointer,
    ) -> Result<AvatarBlobReadOutcome, AvatarStorageFailure> {
        self.read_stored_key(pointer.as_str()).await
    }
}

impl<B: BlobStore> AgentAvatarBlobRead for SingleKindAvatarBlobs<B> {
    async fn read(
        &self,
        pointer: &AgentAvatarBlobPointer,
    ) -> Result<AvatarBlobReadOutcome, AvatarStorageFailure> {
        // Custody is enforced HERE, at the physical boundary: a key outside agent custody
        // is refused before it can resolve to (and read) a foreign blob.
        ensure_agent_custody(pointer.as_str())?;
        self.read_stored_key(pointer.as_str()).await
    }
}

impl<B: BlobStore> AgentAvatarBlobStore for SingleKindAvatarBlobs<B> {
    async fn put(
        &self,
        agent_id: &AgentId,
        content_type: AvatarContentType,
        bytes: Vec<u8>,
    ) -> Result<AgentAvatarBlobPointer, AvatarStorageFailure> {
        // The agent custody's OWN static scope, never the user `AVATAR_SCOPE`: an agent
        // and a user sharing a raw id still get disjoint blob keys. The minted key is in
        // agent custody by construction.
        let namespace = BlobNamespace::for_semantic_id(AGENT_AVATAR_SCOPE, agent_id.as_str())
            .map_err(AvatarStorageFailure::from_source)?;
        let stored = self
            .blobs
            .put(&namespace, content_type.as_str(), bytes)
            .await
            .map_err(AvatarStorageFailure::from_source)?;
        AgentAvatarBlobPointer::parse(stored.key().as_str())
            .map_err(AvatarStorageFailure::from_source)
    }

    async fn delete(&self, pointer: &AgentAvatarBlobPointer) -> Result<(), AvatarStorageFailure> {
        // Enforce custody before deleting: the agent capability must never delete a blob
        // outside agent custody (e.g. a user blob a corrupted DB key points at).
        ensure_agent_custody(pointer.as_str())?;
        let stored = self.stored_from_key(pointer.as_str())?;
        self.blobs
            .delete(&stored)
            .await
            .map(|_| ())
            .map_err(AvatarStorageFailure::from_source)
    }
}

impl<B: BlobStore> AvatarBlobStore for SingleKindAvatarBlobs<B> {
    async fn put(
        &self,
        user_id: &UserId,
        content_type: AvatarContentType,
        bytes: Vec<u8>,
    ) -> Result<AvatarBlobPointer, AvatarStorageFailure> {
        let namespace = BlobNamespace::for_semantic_id(AVATAR_SCOPE, user_id.as_str())
            .map_err(AvatarStorageFailure::from_source)?;
        let stored = self
            .blobs
            .put(&namespace, content_type.as_str(), bytes)
            .await
            .map_err(AvatarStorageFailure::from_source)?;
        AvatarBlobPointer::parse(stored.key().as_str()).map_err(AvatarStorageFailure::from_source)
    }

    async fn delete(&self, pointer: &AvatarBlobPointer) -> Result<(), AvatarStorageFailure> {
        let stored = self.stored_from_key(pointer.as_str())?;
        self.blobs
            .delete(&stored)
            .await
            .map(|_| ())
            .map_err(AvatarStorageFailure::from_source)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use silverhand_backend_core::blob_store::{BlobDeleteOutcome, BlobRead};

    use super::*;

    /// The in-memory double's store: each entry is a minted physical key paired with
    /// the bytes put under it, shared behind one `Arc<Mutex<_>>` so clones observe the
    /// same state.
    type MemoryEntries = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

    /// An in-memory [`BlobStore`] double: it mints a fresh sequential key under the
    /// requested namespace on every `put`, stores the bytes, and reports its ambient
    /// kind on the returned blob. It fails on nothing, so the adapter's own mapping —
    /// not the backend — is what the test observes.
    #[derive(Clone)]
    struct MemoryBlobs {
        kind: StorageKind,
        entries: MemoryEntries,
        next: Arc<AtomicUsize>,
    }

    impl MemoryBlobs {
        fn new(kind: StorageKind) -> Self {
            Self {
                kind,
                entries: Arc::new(Mutex::new(Vec::new())),
                next: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn live(&self) -> usize {
            self.entries.lock().unwrap().len()
        }
    }

    impl BlobStore for MemoryBlobs {
        type Error = Infallible;

        async fn put(
            &self,
            namespace: &BlobNamespace,
            _normalized_content_type: &str,
            bytes: Vec<u8>,
        ) -> Result<StoredBlob, Self::Error> {
            let n = self.next.fetch_add(1, Ordering::SeqCst);
            let raw = format!("{}/blob-{n}", namespace.as_str());
            self.entries.lock().unwrap().push((raw.clone(), bytes));
            Ok(StoredBlob::new(
                self.kind,
                BlobStorageKey::parse(raw).unwrap(),
            ))
        }

        async fn read(&self, blob: &StoredBlob) -> Result<BlobReadOutcome, Self::Error> {
            let entries = self.entries.lock().unwrap();
            Ok(
                match entries.iter().find(|(key, _)| key == blob.key().as_str()) {
                    Some((_, bytes)) => BlobReadOutcome::Found(BlobRead::exact(bytes.clone())),
                    None => BlobReadOutcome::Missing,
                },
            )
        }

        async fn delete(&self, blob: &StoredBlob) -> Result<BlobDeleteOutcome, Self::Error> {
            let mut entries = self.entries.lock().unwrap();
            let before = entries.len();
            entries.retain(|(key, _)| key != blob.key().as_str());
            Ok(if entries.len() < before {
                BlobDeleteOutcome::Deleted
            } else {
                BlobDeleteOutcome::AlreadyMissing
            })
        }
    }

    #[tokio::test]
    async fn put_then_read_round_trips_bytes_and_delete_makes_it_missing() {
        let backend = MemoryBlobs::new(StorageKind::Local);
        let adapter = SingleKindAvatarBlobs::new(backend.clone(), StorageKind::Local);
        // An opaque id carrying a separator: the namespace builder must encode it
        // losslessly rather than let it become a path component.
        let user = UserId::parse("user/with-sep").unwrap();

        let pointer = AvatarBlobStore::put(&adapter, &user, AvatarContentType::Png, vec![1, 2, 3])
            .await
            .unwrap();
        assert_eq!(backend.live(), 1);

        let read = AvatarBlobRead::read(&adapter, &pointer).await.unwrap();
        assert!(matches!(read, AvatarBlobReadOutcome::Found(bytes) if bytes == vec![1, 2, 3]));

        AvatarBlobStore::delete(&adapter, &pointer).await.unwrap();
        assert_eq!(backend.live(), 0);
        assert!(matches!(
            AvatarBlobRead::read(&adapter, &pointer).await.unwrap(),
            AvatarBlobReadOutcome::Missing
        ));
    }

    #[tokio::test]
    async fn each_put_mints_a_fresh_pointer_so_a_reupload_never_clobbers() {
        let adapter =
            SingleKindAvatarBlobs::new(MemoryBlobs::new(StorageKind::Local), StorageKind::Local);
        let user = UserId::parse("stable-user").unwrap();

        let first = AvatarBlobStore::put(&adapter, &user, AvatarContentType::Png, vec![9])
            .await
            .unwrap();
        let second = AvatarBlobStore::put(&adapter, &user, AvatarContentType::Png, vec![9])
            .await
            .unwrap();
        assert_ne!(
            first.as_str(),
            second.as_str(),
            "identical re-upload bytes must mint a distinct physical key"
        );
    }

    #[tokio::test]
    async fn a_foreign_custody_key_is_refused_by_the_agent_capability_before_touching_storage() {
        // The production-adapter custody discriminator. A real user blob exists under the
        // user scope. Its key, re-wrapped as an agent pointer (the newtype alone does NOT
        // enforce custody), must be refused by BOTH the agent read and delete capabilities
        // BEFORE the backing store is touched — so a cross-wired `agents.avatar_storage_key`
        // can never read or delete a user's blob — and the user blob must survive intact.
        let backend = MemoryBlobs::new(StorageKind::Local);
        let adapter = SingleKindAvatarBlobs::new(backend.clone(), StorageKind::Local);
        let user = UserId::parse("victim").unwrap();
        let user_pointer =
            AvatarBlobStore::put(&adapter, &user, AvatarContentType::Png, vec![1, 2, 3])
                .await
                .unwrap();
        assert_eq!(backend.live(), 1);
        assert!(
            user_pointer.as_str().starts_with("avatars/"),
            "the user blob lives under the user scope: {}",
            user_pointer.as_str()
        );

        let foreign = AgentAvatarBlobPointer::parse(user_pointer.as_str()).unwrap();
        assert!(
            AgentAvatarBlobRead::read(&adapter, &foreign).await.is_err(),
            "the agent read capability must refuse a user-scope key"
        );
        assert!(
            AgentAvatarBlobStore::delete(&adapter, &foreign).await.is_err(),
            "the agent delete capability must refuse a user-scope key"
        );
        assert_eq!(
            backend.live(),
            1,
            "the agent capability must never delete a user blob"
        );
        let read = AvatarBlobRead::read(&adapter, &user_pointer).await.unwrap();
        assert!(matches!(read, AvatarBlobReadOutcome::Found(bytes) if bytes == vec![1, 2, 3]));
    }

    #[tokio::test]
    async fn both_the_new_and_legacy_agent_scopes_are_reachable_agent_custody() {
        let backend = MemoryBlobs::new(StorageKind::Local);
        let adapter = SingleKindAvatarBlobs::new(backend.clone(), StorageKind::Local);

        // A new-namespace agent blob (minted by the agent put) reads back through the
        // agent capability.
        let fresh = AgentAvatarBlobStore::put(
            &adapter,
            &AgentId::parse("agent-1").unwrap(),
            AvatarContentType::Png,
            vec![9],
        )
        .await
        .unwrap();
        assert!(fresh.as_str().starts_with("agent-avatars/"));
        let read = AgentAvatarBlobRead::read(&adapter, &fresh).await.unwrap();
        assert!(matches!(read, AvatarBlobReadOutcome::Found(bytes) if bytes == vec![9]));

        // A legacy TS-shaped key `agents/<id>/avatars/...` is accepted as agent custody:
        // it REACHES the store (resolving to Missing here), it is not refused.
        let legacy = AgentAvatarBlobPointer::parse("agents/agent-1/avatars/legacy.png").unwrap();
        let read = AgentAvatarBlobRead::read(&adapter, &legacy).await.unwrap();
        assert!(matches!(read, AvatarBlobReadOutcome::Missing));
    }

    #[tokio::test]
    async fn the_agent_put_uses_a_distinct_scope_and_round_trips_and_deletes() {
        let backend = MemoryBlobs::new(StorageKind::Local);
        let adapter = SingleKindAvatarBlobs::new(backend.clone(), StorageKind::Local);
        let agent = AgentId::parse("agent-1").unwrap();

        let pointer = AgentAvatarBlobStore::put(&adapter, &agent, AvatarContentType::Png, vec![7, 8])
            .await
            .unwrap();
        assert!(
            pointer.as_str().starts_with("agent-avatars/"),
            "agent blobs live under their own scope, never the user `avatars/` scope: {}",
            pointer.as_str()
        );
        assert_eq!(backend.live(), 1);

        let read = AgentAvatarBlobRead::read(&adapter, &pointer).await.unwrap();
        assert!(matches!(read, AvatarBlobReadOutcome::Found(bytes) if bytes == vec![7, 8]));

        AgentAvatarBlobStore::delete(&adapter, &pointer).await.unwrap();
        assert_eq!(backend.live(), 0);
    }

    #[tokio::test]
    async fn an_agent_and_a_user_sharing_a_raw_id_get_disjoint_blob_keys() {
        let adapter =
            SingleKindAvatarBlobs::new(MemoryBlobs::new(StorageKind::Local), StorageKind::Local);
        let shared = "shared-id";
        let user_pointer = AvatarBlobStore::put(
            &adapter,
            &UserId::parse(shared).unwrap(),
            AvatarContentType::Png,
            vec![1],
        )
        .await
        .unwrap();
        let agent_pointer = AgentAvatarBlobStore::put(
            &adapter,
            &AgentId::parse(shared).unwrap(),
            AvatarContentType::Png,
            vec![1],
        )
        .await
        .unwrap();
        assert_ne!(
            user_pointer.as_str(),
            agent_pointer.as_str(),
            "the two custodies must never collide even on an identical raw id"
        );
    }
}
