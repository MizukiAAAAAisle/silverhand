//! Identity & Access — the driver-free application boundary for who may join a
//! workspace and how that membership is written. No persistence or wire types
//! enter here; adapters in the sibling crates implement the ports below.

mod agent_enrollment;

pub use agent_enrollment::{
    AddAgentMemberError, AgentAuthorityFacts, AgentEnrollmentReadPort, AgentEnrollmentUnitOfWork,
    AgentMembershipTx, AgentWorkspaceMembership, EnrollmentKey, MembershipInsertOutcome, Principal,
    add_workspace_agent_member, can_enroll_agent, enroll_agent_into_workspace,
};
