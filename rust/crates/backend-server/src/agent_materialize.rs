//! Compatibility facade; the materialization adapter is owned by host runtime.

#[cfg(test)]
pub(crate) use crate::host_runtime::agent_materialize::{
    AGENT_MATERIALIZE_CAPABILITY_CODES, admits_agent_materialize_refusal, materialize_captured,
};
pub use crate::host_runtime::agent_materialize::{
    AgentMaterializeFailure, ProductionAgentMaterialize,
};
