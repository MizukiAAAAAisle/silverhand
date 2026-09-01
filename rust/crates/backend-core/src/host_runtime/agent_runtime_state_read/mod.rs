//! The stored facts one `GET /api/agents/{id}/runtime-state` read needs, and the
//! pure projection that redacts them for a viewer.
//!
//! This is the READ dual of the runtime-switch write saga: it mints no write
//! authority, holds no lifecycle state, and answers the route from ONE snapshot.
//! It composes the SAME visibility ACL as availability/detail
//! ([`crate::identity_access::capability::agent_view`]) with a projection of the agent's
//! participations and durable seats, so the route and its tests share one
//! authority without a driver.
//!
//! The single leaf [`model`] carries the snapshot facts, the pure projection, the
//! wire views, and the read-model port; this namespace only re-exports it. See
//! that leaf for the one-snapshot/source-bound, redaction, and generation-guarded
//! focus contracts.

mod model;

pub use model::{
    AgentRuntimeStateFacts, AgentRuntimeStateReadModel, AgentRuntimeStateView, PresentationFocus,
    RuntimeFocusView, RuntimeParticipationFact, RuntimeParticipationView, RuntimeSeatFact,
    RuntimeSeatScopeFact, RuntimeSeatScopeView, RuntimeSeatView,
};
