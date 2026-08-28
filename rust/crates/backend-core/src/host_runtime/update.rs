//! Naming a computer, including the one-time finalize transition after first attach.
//!
//! The decision is a callback the persistence adapter runs only after it has taken
//! its root write lock and read the computer inside that lock. This keeps ownership,
//! revocation, lifecycle and input ordering in the domain without asking an adapter
//! to mint a verdict, while making it impossible to decide from a pre-lock snapshot.

use std::future::Future;

use crate::{
    identity::{HostId, UserId},
    persistence::PersistenceFailure,
};

use super::{
    computer::{ComputerDisplayLabel, ComputerRecord},
    read::find_owned_computer,
};

/// The parsed PATCH body. Invalid input remains an explicit arm so ownership is
/// decided before a `400` may reveal anything about the named computer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpdateComputerInput {
    Invalid,
    Valid {
        /// `None` is both JSON `null` and a string normalized to empty after the
        /// JavaScript-compatible trim rule.
        display_label: Option<ComputerDisplayLabel>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateComputerCommand {
    pub computer: HostId,
    pub requester: UserId,
    pub input: UpdateComputerInput,
    /// The process clock's one reading for a finalize committed by this call.
    pub at: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpdateComputerRefusal {
    NotFound,
    Revoked,
    InvalidInput,
    PendingAttach,
    LabelRequired,
}

/// The decision handed back to the transaction driver while its write lock is
/// still held. A refusal performs no write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpdateComputerDecision {
    Refuse(UpdateComputerRefusal),
    Write {
        display_label: Option<String>,
        finalized_at: Option<i64>,
    },
}

/// What the transaction committed. The adapter reports the record it read back
/// under the same lock; it does not decide whether the write was a rename or a
/// finalize.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpdateComputerTransaction {
    Refused(UpdateComputerRefusal),
    Updated {
        computer: ComputerRecord,
        finalized_now: bool,
    },
}

pub trait UpdateComputerUnitOfWork: Clone + Send + Sync + 'static {
    /// Take the write lock, read `computer`, run `decide` against that in-lock
    /// record, apply its write if any, and read the resulting record back before
    /// commit.
    fn update_computer<D>(
        &self,
        computer: HostId,
        decide: D,
    ) -> impl Future<Output = Result<UpdateComputerTransaction, PersistenceFailure>> + Send
    where
        D: FnOnce(Option<ComputerRecord>) -> UpdateComputerDecision + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpdateComputerOutcome {
    Refused(UpdateComputerRefusal),
    Renamed(ComputerRecord),
    Finalized(ComputerRecord),
}

#[derive(Clone)]
pub struct UpdateComputer<U> {
    unit_of_work: U,
}

impl<U> UpdateComputer<U>
where
    U: UpdateComputerUnitOfWork,
{
    pub fn new(unit_of_work: U) -> Self {
        Self { unit_of_work }
    }

    pub async fn execute(
        &self,
        command: UpdateComputerCommand,
    ) -> Result<UpdateComputerOutcome, PersistenceFailure> {
        let computer = command.computer.clone();
        let transaction = self
            .unit_of_work
            .update_computer(computer, move |record| decide(&command, record))
            .await?;
        Ok(match transaction {
            UpdateComputerTransaction::Refused(refusal) => UpdateComputerOutcome::Refused(refusal),
            UpdateComputerTransaction::Updated {
                computer,
                finalized_now: true,
            } => UpdateComputerOutcome::Finalized(computer),
            UpdateComputerTransaction::Updated {
                computer,
                finalized_now: false,
            } => UpdateComputerOutcome::Renamed(computer),
        })
    }
}

fn decide(
    command: &UpdateComputerCommand,
    record: Option<ComputerRecord>,
) -> UpdateComputerDecision {
    // The anti-enumeration gate comes before body validity. Both missing and
    // foreign records therefore earn the same answer for a malformed body too.
    let Some(owned) = find_owned_computer(&command.requester, record) else {
        return UpdateComputerDecision::Refuse(UpdateComputerRefusal::NotFound);
    };
    let record = owned.record();
    if record.revoked_at.is_some() {
        return UpdateComputerDecision::Refuse(UpdateComputerRefusal::Revoked);
    }
    let UpdateComputerInput::Valid { display_label } = &command.input else {
        return UpdateComputerDecision::Refuse(UpdateComputerRefusal::InvalidInput);
    };

    let finalizing = record.is_user_managed() && record.finalized_at.is_none();
    if finalizing {
        if record.activated_at.is_none() {
            return UpdateComputerDecision::Refuse(UpdateComputerRefusal::PendingAttach);
        }
        if display_label.is_none() {
            return UpdateComputerDecision::Refuse(UpdateComputerRefusal::LabelRequired);
        }
    }

    UpdateComputerDecision::Write {
        display_label: display_label
            .as_ref()
            .map(|label| label.as_str().to_owned()),
        finalized_at: finalizing.then_some(command.at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_runtime::computer::{HostKind, ProvisioningSource};

    fn command(input: UpdateComputerInput) -> UpdateComputerCommand {
        UpdateComputerCommand {
            computer: HostId::parse("host-1").unwrap(),
            requester: UserId::parse("owner").unwrap(),
            input,
            at: 1_700_000_000_123,
        }
    }

    fn record(owner: &str) -> ComputerRecord {
        ComputerRecord {
            id: HostId::parse("host-1").unwrap(),
            name: "stable-name".to_owned(),
            kind: HostKind::Remote,
            created_at: 1,
            owner: Some(UserId::parse(owner).unwrap()),
            installation_id: None,
            last_seen_at: None,
            activated_at: Some(2),
            finalized_at: Some(3),
            revoked_at: None,
            provisioning_source: ProvisioningSource::UserInvite,
            display_label: None,
        }
    }

    fn label(raw: &str) -> UpdateComputerInput {
        UpdateComputerInput::Valid {
            display_label: Some(ComputerDisplayLabel::parse(raw).unwrap()),
        }
    }

    #[test]
    fn identity_outranks_invalid_input() {
        assert_eq!(
            decide(&command(UpdateComputerInput::Invalid), None),
            UpdateComputerDecision::Refuse(UpdateComputerRefusal::NotFound)
        );
        assert_eq!(
            decide(
                &command(UpdateComputerInput::Invalid),
                Some(record("somebody-else"))
            ),
            UpdateComputerDecision::Refuse(UpdateComputerRefusal::NotFound)
        );
        assert_eq!(
            decide(
                &command(UpdateComputerInput::Invalid),
                Some(record("owner"))
            ),
            UpdateComputerDecision::Refuse(UpdateComputerRefusal::InvalidInput)
        );
    }

    #[test]
    fn a_first_attach_requires_a_name_and_stamps_finalize_once() {
        let mut draft = record("owner");
        draft.finalized_at = None;
        assert_eq!(
            decide(
                &command(UpdateComputerInput::Valid {
                    display_label: None
                }),
                Some(draft.clone())
            ),
            UpdateComputerDecision::Refuse(UpdateComputerRefusal::LabelRequired)
        );
        assert_eq!(
            decide(&command(label(" Studio Mac ")), Some(draft)),
            UpdateComputerDecision::Write {
                display_label: Some("Studio Mac".to_owned()),
                finalized_at: Some(1_700_000_000_123),
            }
        );
    }

    #[test]
    fn an_unattached_draft_cannot_finalize_and_a_finalized_host_can_clear() {
        let mut draft = record("owner");
        draft.finalized_at = None;
        draft.activated_at = None;
        assert_eq!(
            decide(&command(label("Mac")), Some(draft)),
            UpdateComputerDecision::Refuse(UpdateComputerRefusal::PendingAttach)
        );
        assert_eq!(
            decide(
                &command(UpdateComputerInput::Valid {
                    display_label: None
                }),
                Some(record("owner"))
            ),
            UpdateComputerDecision::Write {
                display_label: None,
                finalized_at: None,
            }
        );
    }
}
