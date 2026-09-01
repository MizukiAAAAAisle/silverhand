//! Attachment application facts, ports, and use cases.

mod agent;
mod read;
mod write;

pub use agent::{
    AgentAttachmentContentUpdateCommand, AgentAttachmentContentUpdateRefusal,
    AgentAttachmentContentUpdateUnitOfWork, AgentAttachmentContentUpdatedFact,
    AgentAttachmentCreateCommand, AgentAttachmentCreateRefusal, AgentAttachmentCreateUnitOfWork,
    AgentAttachmentCreatedFact, AgentAttachmentDownloadFact, AgentAttachmentDownloadReadPort,
    AgentAttachmentIdentityMismatch, AgentAttachmentLocateFact, AgentAttachmentLocateReadPort,
    AgentAttachmentReadRefusal, AgentAttachmentRuntime, AgentAttachmentRuntimeMismatch,
    AgentAttachmentTarget, AgentAttachmentTargetRefusal, AgentAttachmentUpdateAdmission,
    AgentAttachmentUpdateAdmissionPort, AgentAttachmentUpdateAdmissionRefusal,
    AgentAttachmentUploadAdmission, AgentAttachmentUploadAdmissionPort,
    AgentAttachmentUploadRefusal, BoundAgentAttachmentContentUpdated, BoundAgentAttachmentCreated,
    BoundAgentAttachmentDownload, BoundAgentAttachmentLocate, BoundAgentAttachmentUpdateAdmission,
    BoundAgentAttachmentUploadAdmission, InvalidAgentAttachmentWriteCommand,
};
pub use read::*;
pub use write::*;
