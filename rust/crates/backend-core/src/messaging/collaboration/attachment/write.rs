//! Attachment write commands, committed facts, and persistence ports.
//!
//! Blob bytes are written before these units of work. Each SQLite write then
//! re-reads authority under its writer reservation and either refuses without a
//! pointer change or returns a fact sealed to the committed row. Blob cleanup is
//! deliberately driven from those facts after commit; a cleanup failure can
//! leave residue, but cannot compensate or relabel the committed database fact.

use std::{error::Error, future::Future};

use crate::{
    blob_store::{BlobAliasId, StoredBlob},
    identity::{ConversationId, UserId},
    messaging::AttachmentId,
};

use super::{
    ATTACHMENT_WIRE_MAX_SAFE_INTEGER, AttachmentContentType, AttachmentCreator, AttachmentFilename,
    AttachmentReadIdentityMismatch, AttachmentRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentWriteAuthority {
    conversation: ConversationId,
    participant: UserId,
    source: AttachmentWriteAuthoritySource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttachmentWriteAuthoritySource {
    WorkspaceSeatAndMembership,
    DirectPairEndpoint,
}

impl AttachmentWriteAuthority {
    pub fn workspace(
        conversation: ConversationId,
        selected_seat: UserId,
        selected_workspace_member: UserId,
    ) -> Result<Self, AttachmentWriteIdentityMismatch> {
        if selected_seat != selected_workspace_member {
            return Err(AttachmentWriteIdentityMismatch);
        }
        Ok(Self {
            conversation,
            participant: selected_seat,
            source: AttachmentWriteAuthoritySource::WorkspaceSeatAndMembership,
        })
    }

    pub fn direct_pair(conversation: ConversationId, selected_endpoint: UserId) -> Self {
        Self {
            conversation,
            participant: selected_endpoint,
            source: AttachmentWriteAuthoritySource::DirectPairEndpoint,
        }
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn participant(&self) -> &UserId {
        &self.participant
    }

    pub const fn source(&self) -> AttachmentWriteAuthoritySource {
        self.source
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentCreateAdmission {
    authority: AttachmentWriteAuthority,
}

impl AttachmentCreateAdmission {
    pub fn selected(authority: AttachmentWriteAuthority) -> Self {
        Self { authority }
    }

    pub fn bind(
        self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> Result<BoundAttachmentCreateAdmission, AttachmentWriteIdentityMismatch> {
        if self.authority.participant() != viewer || self.authority.conversation() != conversation {
            return Err(AttachmentWriteIdentityMismatch);
        }
        Ok(BoundAttachmentCreateAdmission(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAttachmentCreateAdmission(AttachmentCreateAdmission);

impl BoundAttachmentCreateAdmission {
    pub fn authority(&self) -> &AttachmentWriteAuthority {
        &self.0.authority
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentMutationAdmission {
    authority: AttachmentWriteAuthority,
    record: AttachmentRecord,
}

impl AttachmentMutationAdmission {
    pub fn selected(
        authority: AttachmentWriteAuthority,
        record: AttachmentRecord,
    ) -> Result<Self, AttachmentWriteIdentityMismatch> {
        if authority.conversation() != record.channel()
            || !matches!(record.creator(), AttachmentCreator::Human(owner) if owner == authority.participant())
        {
            return Err(AttachmentWriteIdentityMismatch);
        }
        Ok(Self { authority, record })
    }

    pub fn bind(
        self,
        viewer: &UserId,
        attachment: &AttachmentId,
    ) -> Result<BoundAttachmentMutationAdmission, AttachmentWriteIdentityMismatch> {
        if self.authority.participant() != viewer || self.record.id() != attachment {
            return Err(AttachmentWriteIdentityMismatch);
        }
        Ok(BoundAttachmentMutationAdmission(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAttachmentMutationAdmission(AttachmentMutationAdmission);

impl BoundAttachmentMutationAdmission {
    pub fn authority(&self) -> &AttachmentWriteAuthority {
        &self.0.authority
    }

    pub fn record(&self) -> &AttachmentRecord {
        &self.0.record
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AttachmentWriteAdmissionRefusal {
    #[error("attachment write target not found")]
    NotFound,
    #[error("viewer cannot mutate the attachment target")]
    Forbidden,
}

pub trait AttachmentWriteAdmissionPort {
    type Error: Error + Send + Sync + 'static;

    fn admit_create(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<
            Result<AttachmentCreateAdmission, AttachmentWriteAdmissionRefusal>,
            Self::Error,
        >,
    > + Send;

    fn admit_mutation(
        &self,
        viewer: &UserId,
        attachment: &AttachmentId,
    ) -> impl Future<
        Output = Result<
            Result<AttachmentMutationAdmission, AttachmentWriteAdmissionRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentCreateCommand {
    viewer: UserId,
    requested: ConversationId,
    record: AttachmentRecord,
    alias: BlobAliasId,
}

impl AttachmentCreateCommand {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        viewer: UserId,
        requested: ConversationId,
        attachment: AttachmentId,
        filename: AttachmentFilename,
        size: i64,
        content_type: AttachmentContentType,
        blob: StoredBlob,
        created_at: i64,
    ) -> Result<Self, InvalidAttachmentWriteCommand> {
        if size == 0 {
            return Err(InvalidAttachmentWriteCommand);
        }
        let alias = BlobAliasId::from_semantic_id(attachment.as_str())
            .map_err(|_| InvalidAttachmentWriteCommand)?;
        let record = AttachmentRecord::projected(
            attachment,
            requested.clone(),
            Some(requested.clone()),
            filename,
            size,
            content_type,
            blob,
            1,
            AttachmentCreator::Human(viewer.clone()),
            created_at,
        )
        .map_err(|_| InvalidAttachmentWriteCommand)?;
        Ok(Self {
            viewer,
            requested,
            record,
            alias,
        })
    }

    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }

    pub fn requested(&self) -> &ConversationId {
        &self.requested
    }

    pub fn record(&self) -> &AttachmentRecord {
        &self.record
    }

    pub fn alias(&self) -> &BlobAliasId {
        &self.alias
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentContentUpdateCommand {
    viewer: UserId,
    requested: AttachmentId,
    expected_content_type: AttachmentContentType,
    replacement_size: i64,
    replacement_blob: StoredBlob,
}

impl AttachmentContentUpdateCommand {
    pub fn new(
        viewer: UserId,
        requested: AttachmentId,
        expected_content_type: AttachmentContentType,
        replacement_size: i64,
        replacement_blob: StoredBlob,
    ) -> Result<Self, InvalidAttachmentWriteCommand> {
        if !(1..=ATTACHMENT_WIRE_MAX_SAFE_INTEGER).contains(&replacement_size) {
            return Err(InvalidAttachmentWriteCommand);
        }
        BlobAliasId::from_semantic_id(requested.as_str())
            .map_err(|_| InvalidAttachmentWriteCommand)?;
        Ok(Self {
            viewer,
            requested,
            expected_content_type,
            replacement_size,
            replacement_blob,
        })
    }

    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }

    pub fn requested(&self) -> &AttachmentId {
        &self.requested
    }

    pub fn expected_content_type(&self) -> &AttachmentContentType {
        &self.expected_content_type
    }

    pub const fn replacement_size(&self) -> i64 {
        self.replacement_size
    }

    pub fn replacement_blob(&self) -> &StoredBlob {
        &self.replacement_blob
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentDeleteCommand {
    viewer: UserId,
    requested: AttachmentId,
}

impl AttachmentDeleteCommand {
    pub fn new(viewer: UserId, requested: AttachmentId) -> Self {
        Self { viewer, requested }
    }

    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }

    pub fn requested(&self) -> &AttachmentId {
        &self.requested
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("attachment write command violates its bounded coordinate contract")]
pub struct InvalidAttachmentWriteCommand;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentCreatedFact {
    viewer: UserId,
    requested: ConversationId,
    authority: AttachmentWriteAuthority,
    record: AttachmentRecord,
    alias: BlobAliasId,
}

impl AttachmentCreatedFact {
    pub fn committed(
        command: &AttachmentCreateCommand,
        authority: &AttachmentWriteAuthority,
        record: AttachmentRecord,
    ) -> Result<Self, AttachmentWriteIdentityMismatch> {
        if &record != command.record()
            || authority.participant() != command.viewer()
            || authority.conversation() != command.requested()
            || !matches!(record.creator(), AttachmentCreator::Human(owner) if owner == authority.participant())
        {
            return Err(AttachmentWriteIdentityMismatch);
        }
        Ok(Self {
            viewer: command.viewer.clone(),
            requested: command.requested.clone(),
            authority: authority.clone(),
            record,
            alias: command.alias.clone(),
        })
    }

    pub fn bind(
        self,
        viewer: &UserId,
        requested: &ConversationId,
    ) -> Result<BoundAttachmentCreated, AttachmentWriteIdentityMismatch> {
        if &self.viewer != viewer
            || &self.requested != requested
            || self.authority.participant() != viewer
            || self.authority.conversation() != requested
            || self.record.channel() != requested
        {
            return Err(AttachmentWriteIdentityMismatch);
        }
        Ok(BoundAttachmentCreated(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAttachmentCreated(AttachmentCreatedFact);

impl BoundAttachmentCreated {
    pub fn record(&self) -> &AttachmentRecord {
        &self.0.record
    }

    pub fn authority(&self) -> &AttachmentWriteAuthority {
        &self.0.authority
    }
}

/// A committed update remains unpublishable until a consumer binds it to the
/// authenticated request coordinate.
///
/// ```compile_fail
/// use silverhand_backend_core::messaging::collaboration::attachment::AttachmentContentUpdatedFact;
/// fn publish_without_binding(fact: &AttachmentContentUpdatedFact) {
///     let _ = fact.changed();
/// }
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentContentUpdatedFact {
    viewer: UserId,
    requested: AttachmentId,
    authority: AttachmentWriteAuthority,
    before: AttachmentRecord,
    after: AttachmentRecord,
    alias: BlobAliasId,
}

impl AttachmentContentUpdatedFact {
    pub fn committed(
        command: &AttachmentContentUpdateCommand,
        authority: &AttachmentWriteAuthority,
        before: AttachmentRecord,
        after: AttachmentRecord,
    ) -> Result<Self, AttachmentWriteIdentityMismatch> {
        let expected_revision = before
            .content_revision()
            .checked_add(1)
            .filter(|value| *value <= ATTACHMENT_WIRE_MAX_SAFE_INTEGER)
            .ok_or(AttachmentWriteIdentityMismatch)?;
        if authority.participant() != command.viewer()
            || authority.conversation() != before.channel()
            || before.id() != command.requested()
            || after.id() != command.requested()
            || before.channel() != after.channel()
            || before.source_conversation() != after.source_conversation()
            || before.filename() != after.filename()
            || before.content_type() != after.content_type()
            || before.creator() != after.creator()
            || !matches!(before.creator(), AttachmentCreator::Human(owner) if owner == authority.participant())
            || before.created_at() != after.created_at()
            || before.blob().storage() != after.blob().storage()
            || before.blob().key() == after.blob().key()
            || before.content_type() != command.expected_content_type()
            || after.blob() != command.replacement_blob()
            || after.size() != command.replacement_size()
            || after.content_revision() != expected_revision
        {
            return Err(AttachmentWriteIdentityMismatch);
        }
        let alias = BlobAliasId::from_semantic_id(command.requested().as_str())
            .map_err(|_| AttachmentWriteIdentityMismatch)?;
        Ok(Self {
            viewer: command.viewer().clone(),
            requested: command.requested().clone(),
            authority: authority.clone(),
            before,
            after,
            alias,
        })
    }

    pub fn bind(
        self,
        viewer: &UserId,
        requested: &AttachmentId,
    ) -> Result<BoundAttachmentContentUpdated, AttachmentWriteIdentityMismatch> {
        if &self.viewer != viewer
            || &self.requested != requested
            || self.authority.participant() != viewer
            || self.authority.conversation() != self.before.channel()
            || self.before.id() != requested
            || self.after.id() != requested
        {
            return Err(AttachmentWriteIdentityMismatch);
        }
        Ok(BoundAttachmentContentUpdated(self))
    }

    fn changed(&self) -> AttachmentChangedFact {
        AttachmentChangedFact {
            attachment: self.requested.clone(),
            conversation: self.after.channel().clone(),
            content_revision: self.after.content_revision(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAttachmentContentUpdated(AttachmentContentUpdatedFact);

impl BoundAttachmentContentUpdated {
    pub fn before(&self) -> &AttachmentRecord {
        &self.0.before
    }

    pub fn after(&self) -> &AttachmentRecord {
        &self.0.after
    }

    pub fn alias(&self) -> &BlobAliasId {
        &self.0.alias
    }

    pub fn authority(&self) -> &AttachmentWriteAuthority {
        &self.0.authority
    }

    pub fn changed(&self) -> AttachmentChangedFact {
        self.0.changed()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentChangedFact {
    attachment: AttachmentId,
    conversation: ConversationId,
    content_revision: i64,
}

impl AttachmentChangedFact {
    pub(super) fn from_agent_update(
        bound: &super::agent::BoundAgentAttachmentContentUpdated,
    ) -> Self {
        Self {
            attachment: bound.after().id().clone(),
            conversation: bound.after().channel().clone(),
            content_revision: bound.after().content_revision(),
        }
    }

    pub fn attachment(&self) -> &AttachmentId {
        &self.attachment
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub const fn content_revision(&self) -> i64 {
        self.content_revision
    }
}

/// Capability-local sink for the cursor-inert `attachment_changed` signal.
/// The shared transport adapter and app mount live outside this capability;
/// this port can only be called with the sealed committed fact produced above.
pub trait AttachmentChangedPublisher {
    type Error: Error + Send + Sync + 'static;

    fn publish(
        &self,
        fact: &AttachmentChangedFact,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentDeletedFact {
    viewer: UserId,
    requested: AttachmentId,
    authority: AttachmentWriteAuthority,
    deleted: AttachmentRecord,
    alias: BlobAliasId,
}

impl AttachmentDeletedFact {
    pub fn committed(
        command: &AttachmentDeleteCommand,
        authority: &AttachmentWriteAuthority,
        deleted: AttachmentRecord,
    ) -> Result<Self, AttachmentWriteIdentityMismatch> {
        if authority.participant() != command.viewer()
            || authority.conversation() != deleted.channel()
            || deleted.id() != command.requested()
            || !matches!(deleted.creator(), AttachmentCreator::Human(owner) if owner == authority.participant())
        {
            return Err(AttachmentWriteIdentityMismatch);
        }
        let alias = BlobAliasId::from_semantic_id(command.requested().as_str())
            .map_err(|_| AttachmentWriteIdentityMismatch)?;
        Ok(Self {
            viewer: command.viewer().clone(),
            requested: command.requested().clone(),
            authority: authority.clone(),
            deleted,
            alias,
        })
    }

    pub fn bind(
        self,
        viewer: &UserId,
        requested: &AttachmentId,
    ) -> Result<BoundAttachmentDeleted, AttachmentWriteIdentityMismatch> {
        if &self.viewer != viewer
            || &self.requested != requested
            || self.authority.participant() != viewer
            || self.authority.conversation() != self.deleted.channel()
            || self.deleted.id() != requested
        {
            return Err(AttachmentWriteIdentityMismatch);
        }
        Ok(BoundAttachmentDeleted(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundAttachmentDeleted(AttachmentDeletedFact);

impl BoundAttachmentDeleted {
    pub fn deleted(&self) -> &AttachmentRecord {
        &self.0.deleted
    }

    pub fn alias(&self) -> &BlobAliasId {
        &self.0.alias
    }

    pub fn authority(&self) -> &AttachmentWriteAuthority {
        &self.0.authority
    }
}

/// Attachment-specific post-commit blob policy.
///
/// An update implementation must relink the stable alias to `after` before it
/// deletes `before`; if relinking is not confirmed it retains `before`. A delete
/// implementation removes the physical blob and then its generation-bound alias.
/// Both operations are maintenance after the database fact has committed, so an
/// error is residue to report, never authority to compensate the row mutation.
pub trait AttachmentPostCommitMaintenance {
    type Error: Error + Send + Sync + 'static;

    fn updated(
        &self,
        before: &StoredBlob,
        after: &StoredBlob,
        alias: &BlobAliasId,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;

    fn deleted(
        &self,
        deleted: &StoredBlob,
        alias: &BlobAliasId,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

#[derive(Debug)]
pub struct AttachmentPostCommitOutcome<F, E> {
    committed: F,
    maintenance: Result<(), E>,
}

impl<F, E> AttachmentPostCommitOutcome<F, E> {
    pub fn committed(&self) -> &F {
        &self.committed
    }

    pub fn maintenance(&self) -> Result<(), &E> {
        self.maintenance.as_ref().map(|_| ())
    }

    pub fn into_parts(self) -> (F, Result<(), E>) {
        (self.committed, self.maintenance)
    }
}

pub async fn maintain_committed_update<M: AttachmentPostCommitMaintenance>(
    committed: BoundAttachmentContentUpdated,
    maintenance: &M,
) -> AttachmentPostCommitOutcome<BoundAttachmentContentUpdated, M::Error> {
    let result = maintenance
        .updated(
            committed.before().blob(),
            committed.after().blob(),
            committed.alias(),
        )
        .await;
    AttachmentPostCommitOutcome {
        committed,
        maintenance: result,
    }
}

pub async fn maintain_committed_delete<M: AttachmentPostCommitMaintenance>(
    committed: BoundAttachmentDeleted,
    maintenance: &M,
) -> AttachmentPostCommitOutcome<BoundAttachmentDeleted, M::Error> {
    let result = maintenance
        .deleted(committed.deleted().blob(), committed.alias())
        .await;
    AttachmentPostCommitOutcome {
        committed,
        maintenance: result,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("attachment committed fact differs from its command or persisted row")]
pub struct AttachmentWriteIdentityMismatch;

impl From<AttachmentReadIdentityMismatch> for AttachmentWriteIdentityMismatch {
    fn from(_: AttachmentReadIdentityMismatch) -> Self {
        Self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AttachmentCreateRefusal {
    #[error("conversation not found")]
    NotFound,
    #[error("viewer cannot upload to the conversation")]
    Forbidden,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AttachmentContentUpdateRefusal {
    #[error("attachment not found")]
    NotFound,
    #[error("viewer cannot update the attachment")]
    Forbidden,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AttachmentDeleteRefusal {
    #[error("attachment not found")]
    NotFound,
    #[error("viewer cannot delete the attachment")]
    Forbidden,
    #[error("attachment is referenced by a persisted message")]
    InUse,
}

pub trait AttachmentCreateUnitOfWork {
    type Error: Error + Send + Sync + 'static;

    fn create(
        &self,
        command: AttachmentCreateCommand,
    ) -> impl Future<
        Output = Result<Result<AttachmentCreatedFact, AttachmentCreateRefusal>, Self::Error>,
    > + Send;
}

pub trait AttachmentContentUpdateUnitOfWork {
    type Error: Error + Send + Sync + 'static;

    fn update_content(
        &self,
        command: AttachmentContentUpdateCommand,
    ) -> impl Future<
        Output = Result<
            Result<AttachmentContentUpdatedFact, AttachmentContentUpdateRefusal>,
            Self::Error,
        >,
    > + Send;
}

pub trait AttachmentDeleteUnitOfWork {
    type Error: Error + Send + Sync + 'static;

    fn delete(
        &self,
        command: AttachmentDeleteCommand,
    ) -> impl Future<
        Output = Result<Result<AttachmentDeletedFact, AttachmentDeleteRefusal>, Self::Error>,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_store::{BlobStorageKey, StorageKind};

    #[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
    #[error("maintenance failed")]
    struct MaintenanceFailed;

    struct FailingMaintenance;

    impl AttachmentPostCommitMaintenance for FailingMaintenance {
        type Error = MaintenanceFailed;

        async fn updated(
            &self,
            _before: &StoredBlob,
            _after: &StoredBlob,
            _alias: &BlobAliasId,
        ) -> Result<(), Self::Error> {
            Err(MaintenanceFailed)
        }

        async fn deleted(
            &self,
            _deleted: &StoredBlob,
            _alias: &BlobAliasId,
        ) -> Result<(), Self::Error> {
            Err(MaintenanceFailed)
        }
    }

    fn record_for(creator: &str, revision: i64, key: &str) -> AttachmentRecord {
        AttachmentRecord::projected(
            AttachmentId::parse("a").unwrap(),
            ConversationId::parse("c").unwrap(),
            Some(ConversationId::parse("c").unwrap()),
            AttachmentFilename::parse("a.png").unwrap(),
            4,
            AttachmentContentType::parse("image/png").unwrap(),
            StoredBlob::new(StorageKind::Local, BlobStorageKey::parse(key).unwrap()),
            revision,
            AttachmentCreator::Human(UserId::parse(creator).unwrap()),
            1,
        )
        .unwrap()
    }

    fn record(revision: i64, key: &str) -> AttachmentRecord {
        record_for("u", revision, key)
    }

    fn authority(participant: &str) -> AttachmentWriteAuthority {
        AttachmentWriteAuthority::workspace(
            ConversationId::parse("c").unwrap(),
            UserId::parse(participant).unwrap(),
            UserId::parse(participant).unwrap(),
        )
        .unwrap()
    }

    fn update_command(key: &str) -> AttachmentContentUpdateCommand {
        AttachmentContentUpdateCommand::new(
            UserId::parse("u").unwrap(),
            AttachmentId::parse("a").unwrap(),
            AttachmentContentType::parse("image/png").unwrap(),
            4,
            StoredBlob::new(StorageKind::Local, BlobStorageKey::parse(key).unwrap()),
        )
        .unwrap()
    }

    #[test]
    fn body_admission_facts_bind_selected_authority_and_attachment_owner() {
        let viewer = UserId::parse("u").unwrap();
        let other = UserId::parse("other").unwrap();
        let conversation = ConversationId::parse("c").unwrap();
        let attachment = AttachmentId::parse("a").unwrap();

        assert!(
            AttachmentCreateAdmission::selected(authority("u"))
                .bind(&viewer, &conversation)
                .is_ok()
        );
        assert!(
            AttachmentCreateAdmission::selected(authority("other"))
                .bind(&viewer, &conversation)
                .is_err()
        );

        let selected = AttachmentMutationAdmission::selected(
            authority("u"),
            record(1, "attachments/a/old.png"),
        )
        .unwrap();
        assert!(selected.clone().bind(&viewer, &attachment).is_ok());
        assert!(selected.bind(&other, &attachment).is_err());
        assert!(
            AttachmentMutationAdmission::selected(
                authority("u"),
                record_for("other", 1, "attachments/a/old.png"),
            )
            .is_err()
        );
    }

    #[test]
    fn committed_update_seals_locked_fields_revision_and_displaced_blob() {
        let fact = AttachmentContentUpdatedFact::committed(
            &update_command("attachments/a/new.png"),
            &authority("u"),
            record(1, "attachments/a/old.png"),
            record(2, "attachments/a/new.png"),
        )
        .unwrap();
        let bound = fact
            .bind(
                &UserId::parse("u").unwrap(),
                &AttachmentId::parse("a").unwrap(),
            )
            .unwrap();
        assert_eq!(bound.changed().content_revision(), 2);
        assert_eq!(
            bound.authority().source(),
            AttachmentWriteAuthoritySource::WorkspaceSeatAndMembership
        );

        assert!(
            AttachmentContentUpdatedFact::committed(
                &update_command("attachments/a/new.png"),
                &authority("u"),
                record(1, "attachments/a/old.png"),
                record(3, "attachments/a/new.png"),
            )
            .is_err()
        );
    }

    #[test]
    fn revision_at_safe_integer_ceiling_cannot_produce_a_commit_fact() {
        assert!(
            AttachmentContentUpdatedFact::committed(
                &update_command("attachments/a/new.png"),
                &authority("u"),
                record(ATTACHMENT_WIRE_MAX_SAFE_INTEGER, "attachments/a/old.png"),
                record(ATTACHMENT_WIRE_MAX_SAFE_INTEGER, "attachments/a/new.png"),
            )
            .is_err()
        );
    }

    #[test]
    fn committed_facts_reject_command_authority_and_creator_splices() {
        assert!(
            AttachmentWriteAuthority::workspace(
                ConversationId::parse("c").unwrap(),
                UserId::parse("u").unwrap(),
                UserId::parse("other").unwrap(),
            )
            .is_err(),
            "a conversation seat cannot be relabelled as another workspace member"
        );
        let update = update_command("attachments/a/new.png");
        assert!(
            AttachmentContentUpdatedFact::committed(
                &update,
                &authority("other"),
                record(1, "attachments/a/old.png"),
                record(2, "attachments/a/new.png"),
            )
            .is_err()
        );
        assert!(
            AttachmentContentUpdatedFact::committed(
                &update,
                &authority("u"),
                record_for("other", 1, "attachments/a/old.png"),
                record_for("other", 2, "attachments/a/new.png"),
            )
            .is_err()
        );

        let delete = AttachmentDeleteCommand::new(
            UserId::parse("u").unwrap(),
            AttachmentId::parse("a").unwrap(),
        );
        assert!(
            AttachmentDeletedFact::committed(
                &delete,
                &authority("other"),
                record(1, "attachments/a/old.png"),
            )
            .is_err()
        );
        assert!(
            AttachmentDeletedFact::committed(
                &delete,
                &authority("u"),
                record_for("other", 1, "attachments/a/old.png"),
            )
            .is_err()
        );

        let create = AttachmentCreateCommand::new(
            UserId::parse("u").unwrap(),
            ConversationId::parse("c").unwrap(),
            AttachmentId::parse("a").unwrap(),
            AttachmentFilename::parse("a.png").unwrap(),
            4,
            AttachmentContentType::parse("image/png").unwrap(),
            StoredBlob::new(
                StorageKind::Local,
                BlobStorageKey::parse("attachments/a/new.png").unwrap(),
            ),
            1,
        )
        .unwrap();
        assert!(
            AttachmentCreatedFact::committed(
                &create,
                &authority("other"),
                create.record().clone(),
            )
            .is_err()
        );
        assert!(
            AttachmentCreatedFact::committed(&create, &authority("u"), create.record().clone(),)
                .is_ok()
        );
    }

    #[tokio::test]
    async fn post_commit_maintenance_failure_preserves_the_committed_fact() {
        let viewer = UserId::parse("u").unwrap();
        let requested = AttachmentId::parse("a").unwrap();
        let command = AttachmentDeleteCommand::new(viewer.clone(), requested.clone());
        let committed = AttachmentDeletedFact::committed(
            &command,
            &authority("u"),
            record(1, "attachments/a/old.png"),
        )
        .unwrap()
        .bind(&viewer, &requested)
        .unwrap();
        let outcome = maintain_committed_delete(committed, &FailingMaintenance).await;
        assert!(outcome.maintenance().is_err());
        assert_eq!(outcome.committed().deleted().id(), &requested);
    }
}
