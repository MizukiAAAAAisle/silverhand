//! The production avatar blob adapter: satisfy the avatar routes' narrow blob
//! capabilities by driving the generic content-addressed [`BlobStore`] (in production,
//! the filesystem `LocalBlobStore` from #2221) under one ambient storage kind.
//!
//! It serves the full user capability ([`AvatarBlobStore`]: put/read/delete keyed by
//! [`UserId`]) and the read-only agent capability ([`AgentAvatarBlobRead`], keyed by the
//! agent-owned [`OwnedAgentAvatarBlob`]). The two pointer custodies are DISTINCT
//! domain types; only this adapter's private key→bytes plumbing
//! ([`SingleKindAvatarBlobs::read_stored_key`]) is shared, because physical resolution
//! under the ambient kind is identical. Custody is not left to the newtype alone: the
//! agent read/delete capabilities enforce it here ([`ensure_owner_custody`]), refusing
//! any key outside the BOUND owner's namespace BEFORE it touches the store, so a
//! cross-wired or corrupted
//! `agents.avatar_storage_key` can never reach another agent's (or a user's) blob.
//!
//! The avatar leaf ships no blob backend of its own and depends only on the
//! narrow [`AvatarBlobStore`] capability; the storage KIND is the adapter's,
//! never crossing the DB or the wire (`silverhand_backend_core::identity_access::avatar` doc). This adapter therefore
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
    foundation::blob_store::{
        BlobNamespace, BlobReadOutcome, BlobStorageKey, BlobStore, StorageKind, StoredBlob,
    },
    foundation::identity::{AgentId, UserId},
    identity_access::agent_avatar::{
        AgentAvatarBlobPointer, AgentAvatarBlobRead, AgentAvatarBlobStore, OwnedAgentAvatarBlob,
    },
    identity_access::avatar::{
        AvatarBlobPointer, AvatarBlobRead, AvatarBlobReadOutcome, AvatarBlobStore,
        AvatarContentType, AvatarStorageFailure,
    },
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

/// Enforce that a raw blob key belongs to a SPECIFIC agent owner's custody BEFORE it is
/// resolved against the backing store. Custody is a real per-owner persistence-boundary
/// check, not merely a newtype name and not merely a family bucket: the key must lie in
/// exactly THIS `owner`'s namespace — the new Rust agent-avatar namespace this adapter
/// mints (`ensure_agent_custody` reconstructs the exact prefix `put` would use), or the
/// legacy TS layout `agents/<owner id>/avatars/...`. A key in a DIFFERENT agent's
/// otherwise-legal namespace — or the USER scope, or any unknown scope — is refused here,
/// so a cross-wired or corrupted `agents.avatar_storage_key` can never read or delete
/// another agent's (or a user's) blob through the agent capability. Default-deny: a key
/// whose owner cannot be positively matched is refused, never resolved.
fn ensure_owner_custody(owner: &AgentId, key: &str) -> Result<(), AvatarStorageFailure> {
    if key_belongs_to_owner(owner, key) {
        return Ok(());
    }
    /// A blob key presented to the agent capability that is not in the bound owner's
    /// custody — another agent's namespace, a user scope, or an unknown scope. Refused
    /// before touching the store. `thiserror` is only a dev-dependency of this crate, so
    /// the `Display`/`Error` impls are hand-written for this production error type.
    #[derive(Debug)]
    struct ForeignCustody {
        owner: String,
        key: String,
    }
    impl std::fmt::Display for ForeignCustody {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(
                f,
                "blob key {:?} is not in agent {:?}'s avatar custody",
                self.key, self.owner
            )
        }
    }
    impl std::error::Error for ForeignCustody {}
    Err(AvatarStorageFailure::from_source(ForeignCustody {
        owner: owner.as_str().to_owned(),
        key: key.to_owned(),
    }))
}

/// Does `key` physically lie in `owner`'s agent-avatar namespace? Matched two ways, both
/// segment-exact so one agent's key can never be a string-prefix false-positive for
/// another:
///  - NEW Rust namespace: the leading segments equal what [`AgentAvatarBlobStore::put`]
///    mints for this owner (`for_semantic_id(AGENT_AVATAR_SCOPE, owner)`), with at least
///    one further segment (the blob file).
///  - LEGACY TS namespace: `agents/<owner raw id>/avatars/...`.
fn key_belongs_to_owner(owner: &AgentId, key: &str) -> bool {
    let key_segments: Vec<&str> = key.split('/').collect();

    // New Rust namespace: rebuild the exact prefix `put` uses for this owner and require
    // the key's leading segments to equal it, plus at least the trailing blob segment.
    if let Ok(namespace) = BlobNamespace::for_semantic_id(AGENT_AVATAR_SCOPE, owner.as_str()) {
        let namespace_segments: Vec<&str> = namespace.as_str().split('/').collect();
        if key_segments.len() > namespace_segments.len()
            && key_segments[..namespace_segments.len()] == namespace_segments[..]
        {
            return true;
        }
    }

    // Legacy TS namespace: `agents/<owner raw id>/avatars/...`. The owner id is the exact
    // second segment; a different agent's legacy key has a different second segment.
    matches!(
        key_segments.as_slice(),
        [scope, id, "avatars", ..]
            if *scope == LEGACY_AGENT_AVATAR_SCOPE && *id == owner.as_str()
    )
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
        blob: &OwnedAgentAvatarBlob,
    ) -> Result<AvatarBlobReadOutcome, AvatarStorageFailure> {
        // Custody is enforced HERE, at the physical boundary, against the BOUND owner: a
        // key outside this owner's namespace (another agent's, or a user's) is refused
        // before it can resolve to (and read) a foreign blob.
        ensure_owner_custody(blob.owner(), blob.pointer().as_str())?;
        self.read_stored_key(blob.pointer().as_str()).await
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

    async fn delete(&self, blob: &OwnedAgentAvatarBlob) -> Result<(), AvatarStorageFailure> {
        // Enforce custody before deleting: the agent capability must never delete a blob
        // outside the bound owner's namespace (e.g. another agent's blob a corrupted DB
        // key points at).
        ensure_owner_custody(blob.owner(), blob.pointer().as_str())?;
        let stored = self.stored_from_key(blob.pointer().as_str())?;
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

    use silverhand_backend_core::foundation::blob_store::{BlobDeleteOutcome, BlobRead};

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
    async fn a_user_scope_key_is_refused_by_the_agent_capability_before_touching_storage() {
        // The production-adapter custody discriminator against the USER scope. A real user
        // blob exists under the user scope. Its key, bound to an agent owner (the newtype
        // alone does NOT enforce custody), must be refused by BOTH the agent read and
        // delete capabilities BEFORE the backing store is touched — so a cross-wired
        // `agents.avatar_storage_key` can never read or delete a user's blob — and the
        // user blob must survive intact.
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

        let foreign = OwnedAgentAvatarBlob::new(
            AgentId::parse("agent-1").unwrap(),
            AgentAvatarBlobPointer::parse(user_pointer.as_str()).unwrap(),
        );
        assert!(
            AgentAvatarBlobRead::read(&adapter, &foreign).await.is_err(),
            "the agent read capability must refuse a user-scope key"
        );
        assert!(
            AgentAvatarBlobStore::delete(&adapter, &foreign)
                .await
                .is_err(),
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
    async fn one_agents_key_is_refused_in_another_agents_custody_across_read_and_delete() {
        // Cindy's per-owner discriminator: the intra-family custody the vertical claims.
        // Mint TWO real agent blobs, A and B, each in its OWN namespace. Presenting B's
        // otherwise-legal agent key bound to owner A must be refused by BOTH A's read and
        // A's delete BEFORE the store is touched — a mere user/agent bucket check would let
        // it through. B's blob survives and stays readable by B; A's own blob is unharmed.
        let backend = MemoryBlobs::new(StorageKind::Local);
        let adapter = SingleKindAvatarBlobs::new(backend.clone(), StorageKind::Local);
        let a = AgentId::parse("agent-a").unwrap();
        let b = AgentId::parse("agent-b").unwrap();

        let a_key = AgentAvatarBlobStore::put(&adapter, &a, AvatarContentType::Png, vec![1])
            .await
            .unwrap();
        let b_key = AgentAvatarBlobStore::put(&adapter, &b, AvatarContentType::Png, vec![2])
            .await
            .unwrap();
        assert_eq!(backend.live(), 2);

        // B's real key, bound to A: refused on BOTH faces (read and the clear/replace
        // delete face) before the store is touched.
        let b_under_a = OwnedAgentAvatarBlob::new(a.clone(), b_key.clone());
        assert!(
            AgentAvatarBlobRead::read(&adapter, &b_under_a)
                .await
                .is_err(),
            "A must not read B's blob through a cross-wired key"
        );
        assert!(
            AgentAvatarBlobStore::delete(&adapter, &b_under_a)
                .await
                .is_err(),
            "A's clear/replace must not delete B's blob through a cross-wired key"
        );
        assert_eq!(
            backend.live(),
            2,
            "a cross-agent refusal must delete nothing"
        );

        // B still reads its own blob; A still reads its own — the refusal is per-owner,
        // not a blanket agent-scope denial.
        let b_owned = OwnedAgentAvatarBlob::new(b, b_key);
        assert!(matches!(
            AgentAvatarBlobRead::read(&adapter, &b_owned).await.unwrap(),
            AvatarBlobReadOutcome::Found(bytes) if bytes == vec![2]
        ));
        let a_owned = OwnedAgentAvatarBlob::new(a, a_key);
        assert!(matches!(
            AgentAvatarBlobRead::read(&adapter, &a_owned).await.unwrap(),
            AvatarBlobReadOutcome::Found(bytes) if bytes == vec![1]
        ));
    }

    #[tokio::test]
    async fn both_the_new_and_legacy_agent_scopes_are_reachable_for_their_owner() {
        let backend = MemoryBlobs::new(StorageKind::Local);
        let adapter = SingleKindAvatarBlobs::new(backend.clone(), StorageKind::Local);
        let owner = AgentId::parse("agent-1").unwrap();

        // A new-namespace agent blob (minted by the agent put) reads back through the
        // agent capability when bound to its owner.
        let fresh = AgentAvatarBlobStore::put(&adapter, &owner, AvatarContentType::Png, vec![9])
            .await
            .unwrap();
        assert!(fresh.as_str().starts_with("agent-avatars/"));
        let fresh_owned = OwnedAgentAvatarBlob::new(owner.clone(), fresh);
        let read = AgentAvatarBlobRead::read(&adapter, &fresh_owned)
            .await
            .unwrap();
        assert!(matches!(read, AvatarBlobReadOutcome::Found(bytes) if bytes == vec![9]));

        // A legacy TS-shaped key `agents/<owner>/avatars/...` bound to that owner is
        // accepted as agent custody: it REACHES the store (resolving to Missing here), it
        // is not refused.
        let legacy = OwnedAgentAvatarBlob::new(
            owner,
            AgentAvatarBlobPointer::parse("agents/agent-1/avatars/legacy.png").unwrap(),
        );
        let read = AgentAvatarBlobRead::read(&adapter, &legacy).await.unwrap();
        assert!(matches!(read, AvatarBlobReadOutcome::Missing));
    }

    #[tokio::test]
    async fn a_legacy_key_for_a_different_owner_is_refused() {
        // A legacy TS key is bound to the WRONG owner: `agents/agent-b/avatars/...`
        // presented as agent-a's custody. The second segment is the owner id, so it is
        // refused — legacy compatibility never widens to cross-owner access.
        let adapter =
            SingleKindAvatarBlobs::new(MemoryBlobs::new(StorageKind::Local), StorageKind::Local);
        let wrong = OwnedAgentAvatarBlob::new(
            AgentId::parse("agent-a").unwrap(),
            AgentAvatarBlobPointer::parse("agents/agent-b/avatars/legacy.png").unwrap(),
        );
        assert!(AgentAvatarBlobRead::read(&adapter, &wrong).await.is_err());
        assert!(
            AgentAvatarBlobStore::delete(&adapter, &wrong)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn the_agent_put_uses_a_distinct_scope_and_round_trips_and_deletes() {
        let backend = MemoryBlobs::new(StorageKind::Local);
        let adapter = SingleKindAvatarBlobs::new(backend.clone(), StorageKind::Local);
        let agent = AgentId::parse("agent-1").unwrap();

        let pointer =
            AgentAvatarBlobStore::put(&adapter, &agent, AvatarContentType::Png, vec![7, 8])
                .await
                .unwrap();
        assert!(
            pointer.as_str().starts_with("agent-avatars/"),
            "agent blobs live under their own scope, never the user `avatars/` scope: {}",
            pointer.as_str()
        );
        assert_eq!(backend.live(), 1);

        let owned = OwnedAgentAvatarBlob::new(agent, pointer);
        let read = AgentAvatarBlobRead::read(&adapter, &owned).await.unwrap();
        assert!(matches!(read, AvatarBlobReadOutcome::Found(bytes) if bytes == vec![7, 8]));

        AgentAvatarBlobStore::delete(&adapter, &owned)
            .await
            .unwrap();
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
