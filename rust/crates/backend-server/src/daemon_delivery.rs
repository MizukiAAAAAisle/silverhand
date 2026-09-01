//! Compatibility facade for daemon delivery.
//!
//! The map-owned assembly lives in
//! [`crate::application_orchestration::daemon_delivery`]. Existing public paths
//! remain stable while callers migrate to their context owners.

pub(crate) use crate::application_orchestration::daemon_delivery::{
    CommandRefusal, DaemonRefusalCode, HostDataPlaneAnswerMismatch, HostDataPlaneFailure,
    HostDataPlaneRequest, PARSED_EVENT_KINDS, command,
};
pub use crate::application_orchestration::daemon_delivery::{
    ConnectedHostNameView, DaemonAgentDeletionFence, DaemonCascadeEffects,
    DaemonConnectionControlHandle, DaemonDeliveryBuildError, DaemonDeliveryConfig,
    DaemonDeliveryController, DaemonDeliveryEffects, DaemonDeliveryError, DaemonDeliveryRuntime,
    DaemonHostConnections, DaemonRegistryError, DaemonRotationDeliveryError, DaemonTokenRotation,
    HOST_PROTOCOL_VERSION, HOST_WEBSOCKET_PATH, HostDataPlaneCustody, OUTBOUND_PROTOCOL_VERSION,
    OnboardingDeliveryAdapter, OwningHostDataPlane, UPDATE_REQUIRED_CLOSE_REASON,
};
