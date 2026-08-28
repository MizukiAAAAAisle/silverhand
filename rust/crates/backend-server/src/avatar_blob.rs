//! The production avatar blob adapter: satisfy the avatar routes' narrow blob
//! capabilities by driving the generic content-addressed [`BlobStore`] (in production,
//! the filesystem `LocalBlobStore` from #2221) under one ambient storage kind.
//!
//! It serves the full user capability ([`AvatarBlobStore`]: put/read/delete keyed by
//! [`UserId`]) and the read-only agent capability ([`AgentAvatarBlobRead`], keyed by the
//! agent-owned [`AgentAvatarBlobPointer`]). The two pointer custodies are DISTINCT
//! domain types; only this adapter's private key→bytes plumbing
//! ([`SingleKindAvatarBlobs::read_stored_key`]) is shared, because physical resolution
//! under the ambient kind is identical.
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
    agent_avatar::{AgentAvatarBlobPointer, AgentAvatarBlobRead},
    avatar::{
        AvatarBlobPointer, AvatarBlobRead, AvatarBlobReadOutcome, AvatarBlobStore,
        AvatarContentType, AvatarStorageFailure,
    },
    blob_store::{
        BlobNamespace, BlobReadOutcome, BlobStorageKey, BlobStore, StorageKind, StoredBlob,
    },
    identity::UserId,
};

/// The fixed static scope every avatar blob is namespaced under. The per-user
/// segment is derived losslessly from the opaque user id by the namespace builder.
const AVATAR_SCOPE: &str = "avatars";

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
        self.read_stored_key(pointer.as_str()).await
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

        let pointer = adapter
            .put(&user, AvatarContentType::Png, vec![1, 2, 3])
            .await
            .unwrap();
        assert_eq!(backend.live(), 1);

        let read = AvatarBlobRead::read(&adapter, &pointer).await.unwrap();
        assert!(matches!(read, AvatarBlobReadOutcome::Found(bytes) if bytes == vec![1, 2, 3]));

        adapter.delete(&pointer).await.unwrap();
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

        let first = adapter
            .put(&user, AvatarContentType::Png, vec![9])
            .await
            .unwrap();
        let second = adapter
            .put(&user, AvatarContentType::Png, vec![9])
            .await
            .unwrap();
        assert_ne!(
            first.as_str(),
            second.as_str(),
            "identical re-upload bytes must mint a distinct physical key"
        );
    }

    #[tokio::test]
    async fn the_agent_read_capability_resolves_bytes_through_the_shared_plumbing() {
        // The two custody pointers are distinct domain types but resolve identically at
        // the physical layer: bytes stored under a key are readable through the agent
        // read capability given the agent-owned pointer for that key.
        let backend = MemoryBlobs::new(StorageKind::Local);
        let adapter = SingleKindAvatarBlobs::new(backend.clone(), StorageKind::Local);
        let user = UserId::parse("agent-owner").unwrap();
        let user_pointer = adapter
            .put(&user, AvatarContentType::Png, vec![4, 5, 6])
            .await
            .unwrap();

        let agent_pointer = AgentAvatarBlobPointer::parse(user_pointer.as_str()).unwrap();
        let read = AgentAvatarBlobRead::read(&adapter, &agent_pointer)
            .await
            .unwrap();
        assert!(matches!(read, AvatarBlobReadOutcome::Found(bytes) if bytes == vec![4, 5, 6]));

        // A pointer to no stored bytes is a clean Missing, left for the core to price.
        let dangling = AgentAvatarBlobPointer::parse("agents/ghost/avatars/blob-0.png").unwrap();
        assert!(matches!(
            AgentAvatarBlobRead::read(&adapter, &dangling).await.unwrap(),
            AvatarBlobReadOutcome::Missing
        ));
    }
}
