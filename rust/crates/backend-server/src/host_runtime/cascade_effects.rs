//! Production aftermath for a committed computer cascade.
//!
//! The composer joins three existing authorities without copying any of them:
//! daemon attachment custody for exact-seat stop and host-local purge, the local
//! blob store for physical deletion, and an injected identity-event producer. The
//! event producer remains a dependency because its shared `agent_deleted` bytes are
//! owned by the event lane; this module neither restates nor stubs that event.

use std::{error::Error, fmt, future::Future, sync::Arc, time::Duration};

use serde_json::{Value, json};

use silverhand_backend_core::{
    application_orchestration::teardown::{
        agent_delete_resume::{AgentDeletionFence, AgentDeletionResidue, QuiescePurgeFailure},
        computer_delete::ComputerCascadeEffects,
        facts::{AgentRuntimeSessionFacts, StoredBlobRef},
        intent::AgentDeletionLifecyclePort,
    },
    foundation::blob_store::{BlobStorageKey, BlobStore, StorageKind, StoredBlob},
    foundation::identity::{AgentId, HostId},
    host_runtime::aftermath::CustodyEffectFailure,
};
use silverhand_backend_filesystem::foundation::blob_store::{LocalBlobStore, LocalBlobStoreError};

use crate::{
    application_orchestration::daemon_delivery::{
        DaemonDeliveryController, HostDataPlaneCustody, HostDataPlaneFailure, HostDataPlaneRequest,
        OwningHostDataPlane, command,
    },
    foundation::scope_event_transport::ScopeEventHub,
    host_runtime::daemon_runtime_codecs::runtime_stop::{
        self, RuntimeStopCodecError, RuntimeStopCommand,
    },
    host_runtime::host_agent_background::agent_deletion_resumer::AgentDeletionResumer,
};

const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const HOST_LOCAL_PURGE_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) const AGENT_FILES_PURGE_CAPABILITY_CODES: [&str; 2] =
    ["quiesce_failed", "partial_purge"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AgentFilesPurgeRefusalCode {
    QuiesceFailed,
    PartialPurge,
}

impl AgentFilesPurgeRefusalCode {
    pub(crate) fn parse(raw: &str) -> Option<Self> {
        if !AGENT_FILES_PURGE_CAPABILITY_CODES.contains(&raw) {
            return None;
        }
        match raw {
            "quiesce_failed" => Some(Self::QuiesceFailed),
            "partial_purge" => Some(Self::PartialPurge),
            _ => None,
        }
    }
}

pub(crate) fn admits_agent_files_purge_refusal(raw: &str) -> bool {
    AgentFilesPurgeRefusalCode::parse(raw).is_some()
}

/// Teardown's typed daemon adapter. It can express only exact-seat stop and
/// agent-home purge; registry ownership and raw websocket dispatch remain behind
/// the sealed owning-host data plane.
#[derive(Clone)]
pub struct DaemonCascadeEffects {
    data_plane: OwningHostDataPlane,
}

impl DaemonCascadeEffects {
    pub(crate) fn new(data_plane: OwningHostDataPlane) -> Self {
        Self { data_plane }
    }

    pub(crate) async fn stop_runtime_seat(
        &self,
        computer: &HostId,
        seat: &AgentRuntimeSessionFacts,
    ) -> Result<(), CustodyEffectFailure> {
        let custody = self.custody(computer)?;
        let encoded =
            RuntimeStopCommand::encode(&seat.scope, seat.generation).map_err(|source| {
                CustodyEffectFailure::from_source(CascadeDaemonError::InvalidRuntimeStopRequest(
                    source,
                ))
            })?;
        let result = self
            .dispatch(
                custody,
                command::runtime_stop(encoded.into_params()),
                DEFAULT_COMMAND_TIMEOUT,
            )
            .await?;
        if !runtime_stop::valid_result(&result) {
            return Err(CustodyEffectFailure::from_source(
                CascadeDaemonError::InvalidRuntimeStopResponse,
            ));
        }
        Ok(())
    }

    pub(crate) async fn purge_host_local_files(
        &self,
        computer: &HostId,
        agent: &AgentId,
    ) -> Result<(), CustodyEffectFailure> {
        let custody = self.custody(computer)?;
        self.purge(custody, agent).await
    }

    pub(crate) async fn purge_host_local_files_on_generation(
        &self,
        custody: HostDataPlaneCustody,
        agent: &AgentId,
    ) -> Result<(), CustodyEffectFailure> {
        self.purge(custody, agent).await
    }

    fn custody(&self, computer: &HostId) -> Result<HostDataPlaneCustody, CustodyEffectFailure> {
        self.data_plane
            .resolve(computer)
            .map_err(|source| {
                CustodyEffectFailure::from_source(CascadeDaemonError::Registry(source))
            })?
            .ok_or_else(|| CustodyEffectFailure::from_source(CascadeDaemonError::NoCurrentDaemon))
    }

    async fn purge(
        &self,
        custody: HostDataPlaneCustody,
        agent: &AgentId,
    ) -> Result<(), CustodyEffectFailure> {
        let result = self
            .dispatch(
                custody,
                command::agent_files_purge(
                    json!({ "agent_id": agent.as_str() }),
                    admits_agent_files_purge_refusal,
                ),
                HOST_LOCAL_PURGE_TIMEOUT,
            )
            .await?;
        if !valid_agent_files_purge_result(&result) {
            return Err(CustodyEffectFailure::from_source(
                CascadeDaemonError::InvalidAgentFilesPurgeResponse,
            ));
        }
        Ok(())
    }

    async fn dispatch(
        &self,
        custody: HostDataPlaneCustody,
        command: crate::foundation::daemon_command::EncodedDaemonCommand,
        timeout: Duration,
    ) -> Result<Value, CustodyEffectFailure> {
        let answer = self
            .data_plane
            .dispatch(HostDataPlaneRequest {
                custody: custody.clone(),
                command,
                timeout,
            })
            .await
            .map_err(|source| {
                CustodyEffectFailure::from_source(CascadeDaemonError::Command(source))
            })?;
        answer
            .into_result_for(&custody)
            .map_err(|_| CustodyEffectFailure::from_source(CascadeDaemonError::Answer))
    }
}

/// Read-only generation view used by deletion recovery. A fence retains only the
/// sealed data plane plus the exact custody it observed.
#[derive(Clone)]
pub struct DaemonHostConnections {
    data_plane: OwningHostDataPlane,
}

impl DaemonHostConnections {
    pub(crate) fn new(data_plane: OwningHostDataPlane) -> Self {
        Self { data_plane }
    }
}

impl crate::host_runtime::host_agent_background::agent_deletion_resumer::DeletionFenceBinder
    for DaemonHostConnections
{
    type Fence = DaemonAgentDeletionFence;

    fn bind(&self, host: &HostId, connection_id: &str) -> Option<Self::Fence> {
        let custody = self.data_plane.resolve(host).ok().flatten()?;
        if custody.connection_id() != connection_id {
            return None;
        }
        Some(DaemonAgentDeletionFence {
            effects: DaemonCascadeEffects::new(self.data_plane.clone()),
            custody,
        })
    }

    fn current_generation(&self, host: &HostId) -> Option<String> {
        self.data_plane
            .resolve(host)
            .ok()
            .flatten()
            .map(|custody| custody.connection_id().to_owned())
    }
}

#[derive(Clone)]
pub struct DaemonAgentDeletionFence {
    effects: DaemonCascadeEffects,
    custody: HostDataPlaneCustody,
}

impl AgentDeletionFence for DaemonAgentDeletionFence {
    async fn quiesce_and_purge(&self, agent: &AgentId) -> Result<(), QuiescePurgeFailure> {
        self.effects
            .purge_host_local_files_on_generation(self.custody.clone(), agent)
            .await
            .map_err(QuiescePurgeFailure::from_source)
    }
}

impl DaemonDeliveryController {
    pub fn host_connections(&self) -> DaemonHostConnections {
        DaemonHostConnections::new(self.owning_host_data_plane())
    }

    pub fn cascade_daemon_effects(&self) -> DaemonCascadeEffects {
        DaemonCascadeEffects::new(self.owning_host_data_plane())
    }
}

fn valid_agent_files_purge_result(result: &Value) -> bool {
    let Some(object) = result.as_object() else {
        return false;
    };
    object.len() == 3
        && object.get("ok").and_then(Value::as_bool) == Some(true)
        && object
            .get("purged_count")
            .and_then(Value::as_i64)
            .is_some_and(|count| count >= 0)
        && object
            .get("quiesced_count")
            .and_then(Value::as_i64)
            .is_some_and(|count| count >= 0)
}

#[derive(Debug)]
enum CascadeDaemonError {
    Registry(crate::application_orchestration::daemon_delivery::DaemonRegistryError),
    NoCurrentDaemon,
    Command(HostDataPlaneFailure),
    Answer,
    InvalidRuntimeStopRequest(RuntimeStopCodecError),
    InvalidRuntimeStopResponse,
    InvalidAgentFilesPurgeResponse,
}

impl fmt::Display for CascadeDaemonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Registry(_) => "daemon attachment registry is unavailable",
            Self::NoCurrentDaemon => "host has no attached daemon",
            Self::Command(_) => "daemon cascade command failed",
            Self::Answer => "daemon cascade answer changed custody",
            Self::InvalidRuntimeStopRequest(_) => "daemon runtime_stop target is not wire-safe",
            Self::InvalidRuntimeStopResponse => "daemon returned an invalid runtime_stop response",
            Self::InvalidAgentFilesPurgeResponse => {
                "daemon returned an invalid agent_files_purge response"
            }
        })
    }
}

impl Error for CascadeDaemonError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Registry(source) => Some(source),
            Self::Command(source) => Some(source),
            Self::InvalidRuntimeStopRequest(source) => Some(source),
            Self::NoCurrentDaemon
            | Self::Answer
            | Self::InvalidRuntimeStopResponse
            | Self::InvalidAgentFilesPurgeResponse => None,
        }
    }
}

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

impl ScopeEventHub {
    pub fn agent_deleted_announcer(&self) -> HubAgentDeletedAnnouncer {
        HubAgentDeletedAnnouncer::new(self.clone())
    }
}

impl HubAgentDeletedAnnouncer {
    /// Adapt the one process hub into the cascade's announcement seam. The hub is the
    /// same instance every other producer publishes on; this adapter mints none of its own.
    pub(crate) fn new(hub: ScopeEventHub) -> Self {
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
/// mapping [`DeletionRunOutcome`](crate::host_runtime::host_agent_background::agent_deletion_resumer::DeletionRunOutcome)
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
    Storage(silverhand_backend_core::foundation::blob_store::UnknownStorageKind),
    Key(silverhand_backend_core::foundation::blob_store::InvalidBlobStorageKey),
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
