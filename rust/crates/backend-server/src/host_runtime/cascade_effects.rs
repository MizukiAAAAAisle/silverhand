//! Production aftermath for a committed computer cascade.
//!
//! The composer joins three existing authorities without copying any of them:
//! daemon attachment custody for exact-seat stop and host-local purge, the local
//! blob store for physical deletion, and an injected identity-event producer. The
//! event producer remains a dependency because its shared `agent_deleted` bytes are
//! owned by the event lane; this module neither restates nor stubs that event.

use std::{error::Error, fmt, future::Future, sync::Arc};

use silverhand_backend_core::{
    blob_store::{BlobStorageKey, BlobStore, StorageKind, StoredBlob},
    host_runtime::aftermath::CustodyEffectFailure,
    identity::{AgentId, HostId},
    teardown::{
        agent_delete_resume::AgentDeletionResidue,
        computer_delete::ComputerCascadeEffects,
        facts::{AgentRuntimeSessionFacts, StoredBlobRef},
        intent::AgentDeletionLifecyclePort,
    },
};
use silverhand_backend_filesystem::blob_store::{LocalBlobStore, LocalBlobStoreError};

use crate::{
    daemon_delivery::{DaemonCascadeEffects, DaemonHostConnections},
    host_agent_background::agent_deletion_resumer::AgentDeletionResumer,
    scope_events::ScopeEventHub,
};

/// The one cross-lane dependency: publish the terminal identity event for a
/// deleted agent. Its concrete producer owns the event name, bytes and audience.
pub trait AgentDeletedAnnouncement: Send + Sync + 'static {
    fn agent_deleted(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<(), CustodyEffectFailure>> + Send;
}

/// The crate-local production producer for that terminal event. Per the ratified A/B
/// decision, a deleted agent reuses the shared app-scope `agent_changed` bytes rather
/// than minting a distinct `agent_deleted` wire event, so this adapter names no new
/// event: it forwards to the one [`ScopeEventHub`], which owns the event name, bytes and
/// audience. A hub failure reaches the cascade as the original `ScopeEventHubError`
/// preserved beneath [`CustodyEffectFailure`], never a new opaque error — so the teardown
/// still refuses safely instead of reporting a phantom success.
#[derive(Clone)]
pub struct HubAgentDeletedAnnouncer {
    hub: ScopeEventHub,
}

impl HubAgentDeletedAnnouncer {
    /// Adapt the one process hub into the cascade's announcement seam. The hub is the
    /// same instance every other producer publishes on; this adapter mints none of its own.
    pub fn new(hub: ScopeEventHub) -> Self {
        Self { hub }
    }
}

impl AgentDeletedAnnouncement for HubAgentDeletedAnnouncer {
    async fn agent_deleted(&self, agent: &AgentId) -> Result<(), CustodyEffectFailure> {
        self.hub
            .publish_agent_changed(agent)
            .map_err(CustodyEffectFailure::from_source)
    }
}

/// Complete production implementation of [`ComputerCascadeEffects`].
///
/// `Clone` shares one component set behind `Arc`; it does not clone the injected
/// producer or mint a second daemon registry/blob root. The only public constructor
/// consumes handles that their owning components already produced.
pub struct ProductionComputerCascadeEffects<A> {
    inner: Arc<Components<A>>,
}

struct Components<A> {
    announcements: A,
    daemon: DaemonCascadeEffects,
    blobs: LocalBlobStore,
}

impl<A> Clone for ProductionComputerCascadeEffects<A> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<A> ProductionComputerCascadeEffects<A> {
    pub fn new(announcements: A, daemon: DaemonCascadeEffects, blobs: LocalBlobStore) -> Self {
        Self {
            inner: Arc::new(Components {
                announcements,
                daemon,
                blobs,
            }),
        }
    }
}

impl<A> ComputerCascadeEffects for ProductionComputerCascadeEffects<A>
where
    A: AgentDeletedAnnouncement,
{
    async fn agent_deleted(&self, agent: &AgentId) -> Result<(), CustodyEffectFailure> {
        self.inner.announcements.agent_deleted(agent).await
    }

    async fn stop_runtime_seat(
        &self,
        computer: &HostId,
        seat: &AgentRuntimeSessionFacts,
    ) -> Result<(), CustodyEffectFailure> {
        self.inner.daemon.stop_runtime_seat(computer, seat).await
    }

    async fn purge_host_local_files(
        &self,
        computer: &HostId,
        agent: &AgentId,
    ) -> Result<(), CustodyEffectFailure> {
        self.inner
            .daemon
            .purge_host_local_files(computer, agent)
            .await
    }

    async fn forget_stored_blob(&self, blob: &StoredBlobRef) -> Result<(), CustodyEffectFailure> {
        let storage = StorageKind::parse(&blob.storage).map_err(|source| {
            CustodyEffectFailure::from_source(BlobForgetError::Storage(source))
        })?;
        let key = BlobStorageKey::parse(blob.storage_key.clone())
            .map_err(|source| CustodyEffectFailure::from_source(BlobForgetError::Key(source)))?;
        self.inner
            .blobs
            .delete(&StoredBlob::new(storage, key))
            .await
            .map(|_| ())
            .map_err(|source| CustodyEffectFailure::from_source(BlobForgetError::Delete(source)))
    }
}

/// The single-agent deletion resumer reuses this ONE composite for its post-commit
/// residue face rather than composing a second announcer or blob adapter. The purge that
/// fences the agent before commit is NOT reached through this value at all: it travels a
/// generation-pinned `DaemonAgentDeletionFence` the resumer's fence binder mints, so a
/// resumer wired here cannot reach the per-seat stop or the bare-host purge the
/// [`ComputerCascadeEffects`] face also carries. The single-agent fence-then-commit order
/// (a generation-verified purge quiesces every child; complete deletes the rows; residue
/// announces and sweeps) is enforced by which methods are callable, not by a test.
impl<A> AgentDeletionResidue for ProductionComputerCascadeEffects<A>
where
    A: AgentDeletedAnnouncement,
{
    async fn agent_deleted(&self, agent: &AgentId) -> Result<(), CustodyEffectFailure> {
        <Self as ComputerCascadeEffects>::agent_deleted(self, agent).await
    }

    async fn forget_stored_blob(&self, blob: &StoredBlobRef) -> Result<(), CustodyEffectFailure> {
        <Self as ComputerCascadeEffects>::forget_stored_blob(self, blob).await
    }
}

/// Assemble the production single-agent deletion resumer over already-composed
/// authorities: the durable lifecycle port, the daemon fence binder (which mints the
/// generation-pinned purge fence from the one registry), and the cascade composite's
/// residue face (cloned — never a second root).
///
/// This is the mountable root, and it is deliberately left UNMOUNTED here. The final
/// integration wires it in three places it must not reach from this crate: call
/// [`recover`](AgentDeletionResumer::recover) once after boot; call
/// [`on_host_ready`](AgentDeletionResumer::on_host_ready) from the daemon attach path;
/// and drive [`try_now`](AgentDeletionResumer::try_now) from the public delete endpoint,
/// mapping [`DeletionRunOutcome`](crate::host_agent_background::agent_deletion_resumer::DeletionRunOutcome)
/// to the response. Shutdown calls [`close`](AgentDeletionResumer::close).
pub fn production_agent_deletion_resumer<L, A>(
    lifecycle: L,
    effects: ProductionComputerCascadeEffects<A>,
    connections: DaemonHostConnections,
) -> AgentDeletionResumer<L, DaemonHostConnections, ProductionComputerCascadeEffects<A>>
where
    L: AgentDeletionLifecyclePort,
    A: AgentDeletedAnnouncement,
{
    AgentDeletionResumer::new(lifecycle, connections, effects)
}

#[derive(Debug)]
enum BlobForgetError {
    Storage(silverhand_backend_core::blob_store::UnknownStorageKind),
    Key(silverhand_backend_core::blob_store::InvalidBlobStorageKey),
    Delete(LocalBlobStoreError),
}

impl fmt::Display for BlobForgetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Storage(_) => "stored blob names an unsupported storage authority",
            Self::Key(_) => "stored blob key is not a safe relative coordinate",
            Self::Delete(_) => "stored blob could not be forgotten",
        })
    }
}

impl Error for BlobForgetError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Storage(source) => Some(source),
            Self::Key(source) => Some(source),
            Self::Delete(source) => Some(source),
        }
    }
}
