//! Internal-agent attachment application facts and operation ports.
//!
//! Runtime authentication is already complete when these types are entered. The
//! first seal binds that runtime principal to the route's `aid`; later facts keep
//! the selected conversation, participant, capability source, attachment, and
//! creator coordinates attached until the HTTP consumer binds them back to the
//! same request. Upload target authorization intentionally follows bounded
//! multipart parsing because the existing wire carries `target` inside the form.

use std::{error::Error, future::Future};

use crate::{
    blob_store::{BlobAliasId, StoredBlob},
    identity::{AgentId, ConversationId},
    messaging::{AttachmentId, DirectPairAllocation, ResolvedStream},
    runtime_credential::RuntimePrincipal,
    wire_number::JsSafeInteger,
};

use super::{
    AttachmentChangedFact, AttachmentContentType, AttachmentCreator, AttachmentFilename,
    AttachmentRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttachmentRuntime {
    agent: AgentId,
    source: Option<ConversationId>,
}

impl AgentAttachmentRuntime {
    pub fn bind(
        principal: &RuntimePrincipal,
        path_agent: &AgentId,
    ) -> Result<Self, AgentAttachmentRuntimeMismatch> {
        if principal.agent() != path_agent {
            return Err(AgentAttachmentRuntimeMismatch);
        }
        Ok(Self {
            agent: path_agent.clone(),
            source: principal.source().cloned(),
        })
    }

    pub fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub fn source(&self) -> Option<&ConversationId> {
        self.source.as_ref()
    }

    pub const fn target_allocation(&self) -> DirectPairAllocation {
        if self.source.is_some() {
            DirectPairAllocation::Forbidden
        } else {
            DirectPairAllocation::Permitted
        }
    }

    fn may_write_to(&self, conversation: &ConversationId) -> bool {
        self.source
            .as_ref()
            .is_none_or(|source| source == conversation)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("runtime principal does not belong to the requested agent route")]
pub struct AgentAttachmentRuntimeMismatch;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttachmentTarget {
    agent: AgentId,
    conversation: ConversationId,
}

impl AgentAttachmentTarget {
    pub fn resolved(
        runtime: &AgentAttachmentRuntime,
        stream: ResolvedStream,
    ) -> Result<Self, AgentAttachmentTargetRefusal> {
        if stream.thread_root.is_some() {
            return Err(AgentAttachmentTargetRefusal::ThreadSuffixNotSupported);
        }
        if !runtime.may_write_to(&stream.conversation) {
            return Err(AgentAttachmentTargetRefusal::SlotOutOfScope);
        }
        Ok(Self {
            agent: runtime.agent.clone(),
            conversation: stream.conversation,
        })
    }

    pub fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AgentAttachmentTargetRefusal {
    #[error("attachment upload does not support a thread target")]
    ThreadSuffixNotSupported,
    #[error("runtime slot may not upload to the resolved conversation")]
    SlotOutOfScope,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentAttachmentAuthoritySource {
    WorkspaceGrant,
    AgentHomeOwner,
    DirectPairEndpoint,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AgentAttachmentAuthority {
    conversation: ConversationId,
    participant: AgentId,
    source: AgentAttachmentAuthoritySource,
}

impl AgentAttachmentAuthority {
    fn workspace(
        conversation: ConversationId,
        selected_participant: AgentId,
        selected_workspace_member: AgentId,
        selected_capability_holder: AgentId,
    ) -> Result<Self, AgentAttachmentIdentityMismatch> {
        if selected_participant != selected_workspace_member
            || selected_participant != selected_capability_holder
        {
            return Err(AgentAttachmentIdentityMismatch);
        }
        Ok(Self {
            conversation,
            participant: selected_participant,
            source: AgentAttachmentAuthoritySource::WorkspaceGrant,
        })
    }

    fn agent_home(
        conversation: ConversationId,
        selected_participant: AgentId,
        selected_owner: AgentId,
    ) -> Result<Self, AgentAttachmentIdentityMismatch> {
        if selected_participant != selected_owner {
            return Err(AgentAttachmentIdentityMismatch);
        }
        Ok(Self {
            conversation,
            participant: selected_participant,
            source: AgentAttachmentAuthoritySource::AgentHomeOwner,
        })
    }

    fn direct_pair(conversation: ConversationId, selected_endpoint: AgentId) -> Self {
        Self {
            conversation,
            participant: selected_endpoint,
            source: AgentAttachmentAuthoritySource::DirectPairEndpoint,
        }
    }

    fn matches(&self, agent: &AgentId, conversation: &ConversationId) -> bool {
        &self.participant == agent && &self.conversation == conversation
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttachmentUploadAdmission {
    authority: AgentAttachmentAuthority,
}

impl AgentAttachmentUploadAdmission {
    pub fn workspace(
        conversation: ConversationId,
        selected_participant: AgentId,
        selected_workspace_member: AgentId,
        selected_upload_capability_holder: AgentId,
    ) -> Result<Self, AgentAttachmentIdentityMismatch> {
        Ok(Self {
            authority: AgentAttachmentAuthority::workspace(
                conversation,
                selected_participant,
                selected_workspace_member,
                selected_upload_capability_holder,
            )?,
        })
    }

    pub fn agent_home(
        conversation: ConversationId,
        selected_participant: AgentId,
        selected_owner: AgentId,
    ) -> Result<Self, AgentAttachmentIdentityMismatch> {
        Ok(Self {
            authority: AgentAttachmentAuthority::agent_home(
                conversation,
                selected_participant,
                selected_owner,
            )?,
        })
    }

    pub fn direct_pair(conversation: ConversationId, selected_endpoint: AgentId) -> Self {
        Self {
            authority: AgentAttachmentAuthority::direct_pair(conversation, selected_endpoint),
        }
    }

    pub fn bind(
        self,
        target: &AgentAttachmentTarget,
    ) -> Result<BoundAgentAttachmentUploadAdmission, AgentAttachmentIdentityMismatch> {
        if !self
            .authority
            .matches(target.agent(), target.conversation())
        {
            return Err(AgentAttachmentIdentityMismatch);
        }
        Ok(BoundAgentAttachmentUploadAdmission(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAgentAttachmentUploadAdmission(AgentAttachmentUploadAdmission);

impl BoundAgentAttachmentUploadAdmission {
    pub fn agent(&self) -> &AgentId {
        &self.0.authority.participant
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.0.authority.conversation
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AgentAttachmentUploadRefusal {
    #[error("attachment target not found")]
    NotFound,
    #[error("agent lacks upload_attachments for the target")]
    CapabilityDenied,
}

pub trait AgentAttachmentUploadAdmissionPort {
    type Error: Error + Send + Sync + 'static;

    fn admit_upload(
        &self,
        agent: &AgentId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<
            Result<AgentAttachmentUploadAdmission, AgentAttachmentUploadRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttachmentCreateCommand {
    agent: AgentId,
    conversation: ConversationId,
    record: AttachmentRecord,
    alias: BlobAliasId,
}

impl AgentAttachmentCreateCommand {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        admitted: &BoundAgentAttachmentUploadAdmission,
        attachment: AttachmentId,
        filename: AttachmentFilename,
        size: i64,
        content_type: AttachmentContentType,
        blob: StoredBlob,
        created_at: i64,
    ) -> Result<Self, InvalidAgentAttachmentWriteCommand> {
        let size = JsSafeInteger::new(size).map_err(|_| InvalidAgentAttachmentWriteCommand)?;
        let created_at =
            JsSafeInteger::new(created_at).map_err(|_| InvalidAgentAttachmentWriteCommand)?;
        if size.get() < 1 || created_at.get() < 0 {
            return Err(InvalidAgentAttachmentWriteCommand);
        }
        let alias = BlobAliasId::from_semantic_id(attachment.as_str())
            .map_err(|_| InvalidAgentAttachmentWriteCommand)?;
        let record = AttachmentRecord::projected_safe(
            attachment,
            admitted.conversation().clone(),
            Some(admitted.conversation().clone()),
            filename,
            size,
            content_type,
            blob,
            JsSafeInteger::new(1).expect("one is wire-safe"),
            AttachmentCreator::Agent(admitted.agent().clone()),
            created_at,
        )
        .map_err(|_| InvalidAgentAttachmentWriteCommand)?;
        Ok(Self {
            agent: admitted.agent().clone(),
            conversation: admitted.conversation().clone(),
            record,
            alias,
        })
    }

    pub fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn record(&self) -> &AttachmentRecord {
        &self.record
    }

    pub fn alias(&self) -> &BlobAliasId {
        &self.alias
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttachmentCreatedFact {
    agent: AgentId,
    conversation: ConversationId,
    authority: AgentAttachmentAuthority,
    record: AttachmentRecord,
    alias: BlobAliasId,
}

impl AgentAttachmentCreatedFact {
    pub fn committed(
        command: &AgentAttachmentCreateCommand,
        selected: AgentAttachmentUploadAdmission,
        record: AttachmentRecord,
    ) -> Result<Self, AgentAttachmentIdentityMismatch> {
        if &record != command.record()
            || !selected
                .authority
                .matches(command.agent(), command.conversation())
            || !matches!(record.creator(), AttachmentCreator::Agent(owner) if owner == command.agent())
        {
            return Err(AgentAttachmentIdentityMismatch);
        }
        Ok(Self {
            agent: command.agent.clone(),
            conversation: command.conversation.clone(),
            authority: selected.authority,
            record,
            alias: command.alias.clone(),
        })
    }

    pub fn bind(
        self,
        runtime: &AgentAttachmentRuntime,
        requested: &ConversationId,
    ) -> Result<BoundAgentAttachmentCreated, AgentAttachmentIdentityMismatch> {
        if &self.agent != runtime.agent()
            || &self.conversation != requested
            || !self.authority.matches(runtime.agent(), requested)
            || self.record.channel() != requested
            || !runtime.may_write_to(requested)
        {
            return Err(AgentAttachmentIdentityMismatch);
        }
        Ok(BoundAgentAttachmentCreated(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAgentAttachmentCreated(AgentAttachmentCreatedFact);

impl BoundAgentAttachmentCreated {
    pub fn record(&self) -> &AttachmentRecord {
        &self.0.record
    }

    pub fn alias(&self) -> &BlobAliasId {
        &self.0.alias
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AgentAttachmentCreateRefusal {
    #[error("attachment target not found")]
    NotFound,
    #[error("agent lacks upload_attachments for the target")]
    CapabilityDenied,
}

pub trait AgentAttachmentCreateUnitOfWork {
    type Error: Error + Send + Sync + 'static;

    fn create_for_agent(
        &self,
        command: AgentAttachmentCreateCommand,
    ) -> impl Future<
        Output = Result<
            Result<AgentAttachmentCreatedFact, AgentAttachmentCreateRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttachmentUpdateAdmission {
    runtime: AgentAttachmentRuntime,
    authority: AgentAttachmentAuthority,
    record: AttachmentRecord,
}

impl AgentAttachmentUpdateAdmission {
    pub fn selected(
        runtime: &AgentAttachmentRuntime,
        authority: AgentAttachmentUploadAdmission,
        record: AttachmentRecord,
    ) -> Result<Result<Self, AgentAttachmentUpdateAdmissionRefusal>, AgentAttachmentIdentityMismatch>
    {
        if authority.authority.conversation != *record.channel()
            || record.source_conversation() != Some(record.channel())
            || authority.authority.participant != *runtime.agent()
        {
            return Err(AgentAttachmentIdentityMismatch);
        }
        if !runtime.may_write_to(record.channel()) {
            return Ok(Err(AgentAttachmentUpdateAdmissionRefusal::NotFound));
        }
        if !matches!(record.creator(), AttachmentCreator::Agent(owner) if owner == runtime.agent())
        {
            return Ok(Err(AgentAttachmentUpdateAdmissionRefusal::NotCreator));
        }
        Ok(Ok(Self {
            runtime: runtime.clone(),
            authority: authority.authority,
            record,
        }))
    }

    pub fn bind(
        self,
        runtime: &AgentAttachmentRuntime,
        requested: &AttachmentId,
    ) -> Result<BoundAgentAttachmentUpdateAdmission, AgentAttachmentIdentityMismatch> {
        if &self.runtime != runtime
            || self.record.id() != requested
            || !self
                .authority
                .matches(runtime.agent(), self.record.channel())
            || !runtime.may_write_to(self.record.channel())
        {
            return Err(AgentAttachmentIdentityMismatch);
        }
        Ok(BoundAgentAttachmentUpdateAdmission(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAgentAttachmentUpdateAdmission(AgentAttachmentUpdateAdmission);

impl BoundAgentAttachmentUpdateAdmission {
    pub fn agent(&self) -> &AgentId {
        &self.0.authority.participant
    }

    pub fn record(&self) -> &AttachmentRecord {
        &self.0.record
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AgentAttachmentUpdateAdmissionRefusal {
    #[error("attachment not found")]
    NotFound,
    #[error("agent lacks upload_attachments for the attachment conversation")]
    CapabilityDenied,
    #[error("attachment belongs to another uploader")]
    NotCreator,
}

pub trait AgentAttachmentUpdateAdmissionPort {
    type Error: Error + Send + Sync + 'static;

    fn admit_update(
        &self,
        runtime: &AgentAttachmentRuntime,
        attachment: &AttachmentId,
    ) -> impl Future<
        Output = Result<
            Result<AgentAttachmentUpdateAdmission, AgentAttachmentUpdateAdmissionRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttachmentContentUpdateCommand {
    runtime: AgentAttachmentRuntime,
    requested: AttachmentId,
    conversation: ConversationId,
    expected_content_type: AttachmentContentType,
    replacement_size: JsSafeInteger,
    replacement_blob: StoredBlob,
}

impl AgentAttachmentContentUpdateCommand {
    pub fn new(
        admitted: &BoundAgentAttachmentUpdateAdmission,
        replacement_size: i64,
        replacement_blob: StoredBlob,
    ) -> Result<Self, InvalidAgentAttachmentWriteCommand> {
        let replacement_size =
            JsSafeInteger::new(replacement_size).map_err(|_| InvalidAgentAttachmentWriteCommand)?;
        if replacement_size.get() < 1 {
            return Err(InvalidAgentAttachmentWriteCommand);
        }
        BlobAliasId::from_semantic_id(admitted.record().id().as_str())
            .map_err(|_| InvalidAgentAttachmentWriteCommand)?;
        Ok(Self {
            runtime: admitted.0.runtime.clone(),
            requested: admitted.record().id().clone(),
            conversation: admitted.record().channel().clone(),
            expected_content_type: admitted.record().content_type().clone(),
            replacement_size,
            replacement_blob,
        })
    }

    pub fn agent(&self) -> &AgentId {
        self.runtime.agent()
    }

    pub fn runtime(&self) -> &AgentAttachmentRuntime {
        &self.runtime
    }

    pub fn requested(&self) -> &AttachmentId {
        &self.requested
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn expected_content_type(&self) -> &AttachmentContentType {
        &self.expected_content_type
    }

    pub const fn replacement_size(&self) -> JsSafeInteger {
        self.replacement_size
    }

    pub fn replacement_blob(&self) -> &StoredBlob {
        &self.replacement_blob
    }
}

/// A committed update cannot produce its event until it is rebound to the
/// authenticated runtime and requested attachment.
///
/// ```compile_fail
/// use silverhand_backend_core::messaging::collaboration::attachment::AgentAttachmentContentUpdatedFact;
/// fn publish_without_binding(fact: &AgentAttachmentContentUpdatedFact) {
///     let _ = fact.changed();
/// }
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttachmentContentUpdatedFact {
    runtime: AgentAttachmentRuntime,
    requested: AttachmentId,
    conversation: ConversationId,
    authority: AgentAttachmentAuthority,
    before: AttachmentRecord,
    after: AttachmentRecord,
    alias: BlobAliasId,
}

impl AgentAttachmentContentUpdatedFact {
    pub fn committed(
        command: &AgentAttachmentContentUpdateCommand,
        selected: AgentAttachmentUpdateAdmission,
        before: AttachmentRecord,
        after: AttachmentRecord,
    ) -> Result<Self, AgentAttachmentIdentityMismatch> {
        let expected_revision = before
            .content_revision()
            .get()
            .checked_add(1)
            .and_then(|value| JsSafeInteger::new(value).ok())
            .ok_or(AgentAttachmentIdentityMismatch)?;
        if selected.record != before
            || selected.runtime != command.runtime
            || !selected
                .authority
                .matches(command.agent(), command.conversation())
            || before.id() != command.requested()
            || after.id() != command.requested()
            || before.channel() != after.channel()
            || before.channel() != command.conversation()
            || before.source_conversation() != after.source_conversation()
            || before.filename() != after.filename()
            || before.content_type() != after.content_type()
            || before.creator() != after.creator()
            || !matches!(before.creator(), AttachmentCreator::Agent(owner) if owner == command.agent())
            || before.created_at() != after.created_at()
            || before.blob().storage() != after.blob().storage()
            || before.blob().key() == after.blob().key()
            || before.content_type() != command.expected_content_type()
            || after.blob() != command.replacement_blob()
            || after.size() != command.replacement_size()
            || after.content_revision() != expected_revision
        {
            return Err(AgentAttachmentIdentityMismatch);
        }
        let alias = BlobAliasId::from_semantic_id(command.requested().as_str())
            .map_err(|_| AgentAttachmentIdentityMismatch)?;
        Ok(Self {
            runtime: command.runtime.clone(),
            requested: command.requested.clone(),
            conversation: command.conversation.clone(),
            authority: selected.authority,
            before,
            after,
            alias,
        })
    }

    pub fn bind(
        self,
        runtime: &AgentAttachmentRuntime,
        requested: &AttachmentId,
    ) -> Result<BoundAgentAttachmentContentUpdated, AgentAttachmentIdentityMismatch> {
        if &self.runtime != runtime
            || &self.requested != requested
            || self.before.id() != requested
            || self.after.id() != requested
            || !self.authority.matches(runtime.agent(), &self.conversation)
            || !runtime.may_write_to(&self.conversation)
        {
            return Err(AgentAttachmentIdentityMismatch);
        }
        Ok(BoundAgentAttachmentContentUpdated(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAgentAttachmentContentUpdated(AgentAttachmentContentUpdatedFact);

impl BoundAgentAttachmentContentUpdated {
    pub fn before(&self) -> &AttachmentRecord {
        &self.0.before
    }

    pub fn after(&self) -> &AttachmentRecord {
        &self.0.after
    }

    pub fn alias(&self) -> &BlobAliasId {
        &self.0.alias
    }

    pub fn changed(&self) -> AttachmentChangedFact {
        AttachmentChangedFact::from_agent_update(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AgentAttachmentContentUpdateRefusal {
    #[error("attachment not found")]
    NotFound,
    #[error("agent lacks upload_attachments for the attachment conversation")]
    CapabilityDenied,
    #[error("attachment belongs to another uploader")]
    NotCreator,
}

pub trait AgentAttachmentContentUpdateUnitOfWork {
    type Error: Error + Send + Sync + 'static;

    fn update_content_for_agent(
        &self,
        command: AgentAttachmentContentUpdateCommand,
    ) -> impl Future<
        Output = Result<
            Result<AgentAttachmentContentUpdatedFact, AgentAttachmentContentUpdateRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AgentAttachmentReadAuthority(AgentAttachmentAuthority);

impl AgentAttachmentReadAuthority {
    fn workspace(
        conversation: ConversationId,
        selected_participant: AgentId,
        selected_workspace_member: AgentId,
        selected_read_capability_holder: AgentId,
    ) -> Result<Self, AgentAttachmentIdentityMismatch> {
        Ok(Self(AgentAttachmentAuthority::workspace(
            conversation,
            selected_participant,
            selected_workspace_member,
            selected_read_capability_holder,
        )?))
    }

    fn agent_home(
        conversation: ConversationId,
        selected_participant: AgentId,
        selected_owner: AgentId,
    ) -> Result<Self, AgentAttachmentIdentityMismatch> {
        Ok(Self(AgentAttachmentAuthority::agent_home(
            conversation,
            selected_participant,
            selected_owner,
        )?))
    }

    fn direct_pair(conversation: ConversationId, selected_endpoint: AgentId) -> Self {
        Self(AgentAttachmentAuthority::direct_pair(
            conversation,
            selected_endpoint,
        ))
    }
}

macro_rules! agent_attachment_read_fact {
    ($fact:ident, $bound:ident) => {
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct $fact {
            authority: AgentAttachmentReadAuthority,
            record: AttachmentRecord,
        }

        impl $fact {
            pub fn workspace(
                record: AttachmentRecord,
                selected_participant: AgentId,
                selected_workspace_member: AgentId,
                selected_read_capability_holder: AgentId,
            ) -> Result<Self, AgentAttachmentIdentityMismatch> {
                if record.source_conversation() != Some(record.channel()) {
                    return Err(AgentAttachmentIdentityMismatch);
                }
                let authority = AgentAttachmentReadAuthority::workspace(
                    record.channel().clone(),
                    selected_participant,
                    selected_workspace_member,
                    selected_read_capability_holder,
                )?;
                Ok(Self { authority, record })
            }

            pub fn agent_home(
                record: AttachmentRecord,
                selected_participant: AgentId,
                selected_owner: AgentId,
            ) -> Result<Self, AgentAttachmentIdentityMismatch> {
                if record.source_conversation() != Some(record.channel()) {
                    return Err(AgentAttachmentIdentityMismatch);
                }
                let authority = AgentAttachmentReadAuthority::agent_home(
                    record.channel().clone(),
                    selected_participant,
                    selected_owner,
                )?;
                Ok(Self { authority, record })
            }

            pub fn direct_pair(
                record: AttachmentRecord,
                selected_endpoint: AgentId,
            ) -> Result<Self, AgentAttachmentIdentityMismatch> {
                if record.source_conversation() != Some(record.channel()) {
                    return Err(AgentAttachmentIdentityMismatch);
                }
                let authority = AgentAttachmentReadAuthority::direct_pair(
                    record.channel().clone(),
                    selected_endpoint,
                );
                Ok(Self { authority, record })
            }

            pub fn bind(
                self,
                runtime: &AgentAttachmentRuntime,
                requested: &AttachmentId,
            ) -> Result<$bound, AgentAttachmentIdentityMismatch> {
                if self.record.id() != requested
                    || !self
                        .authority
                        .0
                        .matches(runtime.agent(), self.record.channel())
                {
                    return Err(AgentAttachmentIdentityMismatch);
                }
                Ok($bound(self))
            }
        }

        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct $bound($fact);

        impl $bound {
            pub fn record(&self) -> &AttachmentRecord {
                &self.0.record
            }
        }
    };
}

agent_attachment_read_fact!(AgentAttachmentLocateFact, BoundAgentAttachmentLocate);
agent_attachment_read_fact!(AgentAttachmentDownloadFact, BoundAgentAttachmentDownload);

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AgentAttachmentReadRefusal {
    #[error("attachment not found")]
    NotFound,
    #[error("agent lacks read_attachments for the attachment conversation")]
    CapabilityDenied,
}

pub trait AgentAttachmentLocateReadPort {
    type Error: Error + Send + Sync + 'static;

    fn locate_for_agent(
        &self,
        agent: &AgentId,
        attachment: &AttachmentId,
    ) -> impl Future<
        Output = Result<Result<AgentAttachmentLocateFact, AgentAttachmentReadRefusal>, Self::Error>,
    > + Send;
}

pub trait AgentAttachmentDownloadReadPort {
    type Error: Error + Send + Sync + 'static;

    fn download_for_agent(
        &self,
        agent: &AgentId,
        attachment: &AttachmentId,
    ) -> impl Future<
        Output = Result<
            Result<AgentAttachmentDownloadFact, AgentAttachmentReadRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("internal-agent attachment fact differs from its authenticated coordinates")]
pub struct AgentAttachmentIdentityMismatch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("internal-agent attachment write command violates its bounded contract")]
pub struct InvalidAgentAttachmentWriteCommand;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        blob_store::{BlobStorageKey, StorageKind},
        identity::DaemonInstanceId,
        runtime_credential::{RuntimeCustody, RuntimeGeneration, RuntimeScope},
    };

    fn agent(raw: &str) -> AgentId {
        AgentId::parse(raw).unwrap()
    }

    fn conversation(raw: &str) -> ConversationId {
        ConversationId::parse(raw).unwrap()
    }

    fn attachment(raw: &str) -> AttachmentId {
        AttachmentId::parse(raw).unwrap()
    }

    fn runtime(scope: RuntimeScope) -> RuntimePrincipal {
        RuntimePrincipal::for_scope(
            scope,
            RuntimeCustody::new(
                RuntimeGeneration::new(1).unwrap(),
                DaemonInstanceId::parse("daemon-1").unwrap(),
            ),
        )
    }

    fn blob(key: &str) -> StoredBlob {
        StoredBlob::new(StorageKind::Local, BlobStorageKey::parse(key).unwrap())
    }

    fn record(
        id: &str,
        channel: &str,
        creator: &str,
        revision: i64,
        key: &str,
    ) -> AttachmentRecord {
        AttachmentRecord::projected(
            attachment(id),
            conversation(channel),
            Some(conversation(channel)),
            AttachmentFilename::parse("note.txt").unwrap(),
            5,
            AttachmentContentType::parse("text/plain").unwrap(),
            blob(key),
            revision,
            AttachmentCreator::Agent(agent(creator)),
            7,
        )
        .unwrap()
    }

    fn agent_slot(id: &str) -> AgentAttachmentRuntime {
        AgentAttachmentRuntime::bind(
            &runtime(RuntimeScope::AgentSlot { agent: agent(id) }),
            &agent(id),
        )
        .unwrap()
    }

    fn target(runtime: &AgentAttachmentRuntime, channel: &str) -> AgentAttachmentTarget {
        AgentAttachmentTarget::resolved(
            runtime,
            ResolvedStream {
                conversation: conversation(channel),
                thread_root: None,
            },
        )
        .unwrap()
    }

    fn upload_admission(agent_id: &str, channel: &str) -> AgentAttachmentUploadAdmission {
        AgentAttachmentUploadAdmission::workspace(
            conversation(channel),
            agent(agent_id),
            agent(agent_id),
            agent(agent_id),
        )
        .unwrap()
    }

    #[test]
    fn runtime_and_target_seals_reject_foreign_aid_threads_and_cross_source_writes() {
        let scoped = runtime(RuntimeScope::ConversationSlot {
            agent: agent("a"),
            source: conversation("source"),
        });
        assert!(AgentAttachmentRuntime::bind(&scoped, &agent("foreign")).is_err());
        let bound = AgentAttachmentRuntime::bind(&scoped, &agent("a")).unwrap();
        assert_eq!(bound.target_allocation(), DirectPairAllocation::Forbidden);
        assert_eq!(
            AgentAttachmentTarget::resolved(
                &bound,
                ResolvedStream {
                    conversation: conversation("foreign"),
                    thread_root: None,
                },
            ),
            Err(AgentAttachmentTargetRefusal::SlotOutOfScope)
        );
        assert_eq!(
            AgentAttachmentTarget::resolved(
                &bound,
                ResolvedStream {
                    conversation: conversation("source"),
                    thread_root: Some(crate::messaging::ThreadRootId::parse("thread").unwrap()),
                },
            ),
            Err(AgentAttachmentTargetRefusal::ThreadSuffixNotSupported)
        );
        assert!(target(&bound, "source").conversation() == &conversation("source"));

        let global = agent_slot("a");
        assert_eq!(global.target_allocation(), DirectPairAllocation::Permitted);
        assert!(target(&global, "foreign").conversation() == &conversation("foreign"));
    }

    #[test]
    fn upload_authority_binds_all_selected_workspace_coordinates() {
        let runtime = agent_slot("a");
        let target = target(&runtime, "c");
        assert!(
            AgentAttachmentUploadAdmission::workspace(
                conversation("c"),
                agent("a"),
                agent("foreign"),
                agent("a"),
            )
            .is_err()
        );
        assert!(
            AgentAttachmentUploadAdmission::workspace(
                conversation("c"),
                agent("a"),
                agent("a"),
                agent("foreign"),
            )
            .is_err()
        );
        assert!(upload_admission("a", "c").bind(&target).is_ok());
        assert!(upload_admission("foreign", "c").bind(&target).is_err());
    }

    #[test]
    fn update_admission_seals_creator_and_runtime_write_reach() {
        assert!(
            AgentAttachmentUpdateAdmission::selected(
                &agent_slot("a"),
                upload_admission("a", "c"),
                record("id", "c", "foreign", 1, "attachments/id/old.txt"),
            )
            .unwrap()
            .is_err()
        );
        let selected = AgentAttachmentUpdateAdmission::selected(
            &agent_slot("a"),
            upload_admission("a", "c"),
            record("id", "c", "a", 1, "attachments/id/old.txt"),
        )
        .unwrap();
        let selected = selected.unwrap();
        let foreign_source = AgentAttachmentRuntime::bind(
            &runtime(RuntimeScope::ConversationSlot {
                agent: agent("a"),
                source: conversation("foreign"),
            }),
            &agent("a"),
        )
        .unwrap();
        assert_eq!(
            AgentAttachmentUpdateAdmission::selected(
                &foreign_source,
                upload_admission("a", "c"),
                record("id", "c", "a", 1, "attachments/id/old.txt"),
            )
            .unwrap(),
            Err(AgentAttachmentUpdateAdmissionRefusal::NotFound)
        );
        assert!(
            selected
                .clone()
                .bind(&foreign_source, &attachment("id"))
                .is_err()
        );
        assert!(selected.bind(&agent_slot("a"), &attachment("id")).is_ok());
    }

    #[test]
    fn committed_create_and_update_reject_authority_or_row_splices() {
        let runtime = agent_slot("a");
        let admitted = upload_admission("a", "c")
            .bind(&target(&runtime, "c"))
            .unwrap();
        let create = AgentAttachmentCreateCommand::new(
            &admitted,
            attachment("id"),
            AttachmentFilename::parse("note.txt").unwrap(),
            5,
            AttachmentContentType::parse("text/plain").unwrap(),
            blob("attachments/id/new.txt"),
            7,
        )
        .unwrap();
        assert!(
            AgentAttachmentCreatedFact::committed(
                &create,
                upload_admission("foreign", "c"),
                create.record().clone(),
            )
            .is_err()
        );
        assert!(
            AgentAttachmentCreatedFact::committed(
                &create,
                upload_admission("a", "c"),
                record("id", "c", "foreign", 1, "attachments/id/new.txt"),
            )
            .is_err()
        );

        let before = record("id", "c", "a", 1, "attachments/id/old.txt");
        let selected = AgentAttachmentUpdateAdmission::selected(
            &runtime,
            upload_admission("a", "c"),
            before.clone(),
        )
        .unwrap()
        .unwrap();
        let bound = selected.clone().bind(&runtime, &attachment("id")).unwrap();
        let command =
            AgentAttachmentContentUpdateCommand::new(&bound, 5, blob("attachments/id/new.txt"))
                .unwrap();
        let after = record("id", "c", "a", 2, "attachments/id/new.txt");
        let fact = AgentAttachmentContentUpdatedFact::committed(&command, selected, before, after)
            .unwrap();
        assert!(
            fact.clone()
                .bind(&agent_slot("foreign"), &attachment("id"))
                .is_err()
        );
        assert_eq!(
            fact.bind(&runtime, &attachment("id"))
                .unwrap()
                .changed()
                .content_revision()
                .get(),
            2
        );
    }

    #[test]
    fn locate_and_download_facts_are_independently_coordinate_bound() {
        let runtime = agent_slot("a");
        let located = AgentAttachmentLocateFact::workspace(
            record("id", "c", "other", 1, "attachments/id/blob.txt"),
            agent("a"),
            agent("a"),
            agent("a"),
        )
        .unwrap();
        assert!(
            located
                .clone()
                .bind(&runtime, &attachment("foreign"))
                .is_err()
        );
        assert!(located.bind(&runtime, &attachment("id")).is_ok());

        let downloaded = AgentAttachmentDownloadFact::direct_pair(
            record("id", "c", "other", 1, "attachments/id/blob.txt"),
            agent("foreign"),
        )
        .unwrap();
        assert!(downloaded.bind(&runtime, &attachment("id")).is_err());
    }

    #[test]
    fn persisted_source_conversation_is_part_of_every_object_fact() {
        let malformed = AttachmentRecord::projected(
            attachment("id"),
            conversation("c"),
            Some(conversation("foreign")),
            AttachmentFilename::parse("note.txt").unwrap(),
            5,
            AttachmentContentType::parse("text/plain").unwrap(),
            blob("attachments/id/blob.txt"),
            1,
            AttachmentCreator::Agent(agent("a")),
            7,
        )
        .unwrap();
        assert!(
            AgentAttachmentLocateFact::workspace(
                malformed.clone(),
                agent("a"),
                agent("a"),
                agent("a"),
            )
            .is_err()
        );
        assert!(
            AgentAttachmentUpdateAdmission::selected(
                &agent_slot("a"),
                upload_admission("a", "c"),
                malformed,
            )
            .is_err()
        );
    }
}
