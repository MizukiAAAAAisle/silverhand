//! The transport half of an availability read: whether the delivery path holds
//! an attachment for one host.
//!
//! This port lives in the SERVER crate, not `backend-core`, on purpose. The
//! attachment fact is owned by the delivery transport ([`DaemonDeliveryController`]),
//! which is a server concern; core states only the SHAPE the reachability rule
//! consumes ([`HostAttachmentFacts`]) and the obligation that this fact come from
//! the delivery gate's own registry. This is where that obligation is discharged.
//!
//! The method is SYNC because the registry read is a lock, not I/O, and fallible
//! because that lock can be poisoned — a poisoned lock is an infrastructure fault
//! ([`PersistenceFailure`]), never a detached host. A genuinely absent attachment
//! is `attached: false`, which is a fact the reachability rule reads as `Detached`.

use silverhand_backend_core::{
    foundation::identity::HostId, foundation::persistence::PersistenceFailure,
    host_runtime::availability::HostAttachmentFacts,
};

use crate::daemon_delivery::DaemonDeliveryController;

/// Whether the delivery transport holds an attachment for one host, read from the
/// SAME registry the delivery dispatch gate consults so the read face and the
/// `agent_availability_changed` event face observe one fact.
pub trait HostAttachment {
    fn host_attachment(&self, host: &HostId) -> Result<HostAttachmentFacts, PersistenceFailure>;
}

impl HostAttachment for DaemonDeliveryController {
    fn host_attachment(&self, host: &HostId) -> Result<HostAttachmentFacts, PersistenceFailure> {
        let attached = self
            .host_attached(host.as_str())
            .map_err(PersistenceFailure::from_source)?;
        Ok(HostAttachmentFacts {
            host_id: host.clone(),
            attached,
        })
    }
}
