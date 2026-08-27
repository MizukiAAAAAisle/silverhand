//! Identity & Access — the driver-free application boundary for who may join a
//! workspace and how that membership is written. No persistence or wire types
//! enter here; adapters in the sibling crates implement the ports below.

mod agent_enrollment;
mod clock;
mod governance;
mod human_enrollment;
mod role;

pub use agent_enrollment::{
    AddAgentMemberError, AgentAuthorityFacts, AgentEnrollmentReadPort, AgentEnrollmentUnitOfWork,
    AgentWorkspaceMembership, Capability, DEFAULT_AGENT_CAPABILITIES, EnrollmentKey,
    add_workspace_agent_member, can_enroll_agent,
};
pub use clock::{EnrollmentClock, unix_millis};
pub use governance::{
    WorkspaceAccessPolicy, WorkspaceGovernance, WorkspaceGovernanceFacts,
    WorkspaceGovernanceFactsRead, WorkspaceGovernanceFloor, governance_ceiling,
    governance_floor_verdict,
};
pub use human_enrollment::{
    AddHumanMemberError, HumanEnrollmentCommit, HumanEnrollmentKey, HumanEnrollmentOutcome,
    HumanEnrollmentReadPort, HumanEnrollmentUnitOfWork, HumanUser, ViewerAnnounce,
    ViewerAnnounceFailure, ViewerWorkspacesChangedSink, WorkspaceUserMembership,
    add_workspace_human_member, human_enrollment_authorized,
};
pub use role::{WorkspaceRole, role_governs_workspace};
