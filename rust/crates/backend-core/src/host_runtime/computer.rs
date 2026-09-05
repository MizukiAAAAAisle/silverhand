//! What a computer IS, as records rather than rows: which machine, whose it is,
//! where it came from, and the stamps its lifecycle is read from.
//!
//! This namespace owns the computer, so the closed vocabularies that describe one
//! are declared here and consumed everywhere else — a teardown, a placement or a
//! read surface asks what kind of computer it holds, it does not get to say what
//! kinds exist.
//!
//! [`ComputerRecord`] is the whole custody record, and deliberately raw: every
//! stamp is projected as stored, and the state they add up to is
//! [`super::lifecycle`]'s to decide. A record that carried a pre-combined status
//! would hold that rule where no test of the rule can see it.

use crate::{
    foundation::identity::{HostId, UserId},
    identity_access::capability::computer_access::ComputerOwnershipFacts,
};

use super::{custody::HostCredentialEligibilityFacts, lifecycle::HostLifecycleStamps};

/// Where a computer record came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProvisioningSource {
    /// The app installed itself on this machine.
    AppInstall,
    /// A user invited this machine and holds its lifecycle.
    UserInvite,
    /// The platform created it.
    System,
}

/// Whether a computer is the machine the control plane runs on or one attached to
/// it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostKind {
    Local,
    Remote,
}

/// One computer's custody record.
///
/// Wide on purpose, and the one place that is: this is the record itself, the thing
/// a read surface renders and a lifecycle operation reports back. Every rule that
/// DECIDES something takes its own narrow projection instead — ownership goes to
/// [`crate::identity_access::capability::computer_access`], the lifecycle stamps to
/// [`super::lifecycle`], teardown's two halves to
/// [`crate::application_orchestration::teardown::facts::ComputerTeardownFacts`] — so no decision can quietly
/// widen to a field that happens to be here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerRecord {
    pub id: HostId,
    /// The unique machine name. Distinct from `display_label`: this one is a
    /// coordinate, that one is what the user typed.
    pub name: String,
    pub kind: HostKind,
    pub created_at: i64,
    /// Absent for a computer no user has claimed.
    pub owner: Option<UserId>,
    /// The installation that claimed it, if any. Not on any wire surface: it is the
    /// coordinate a re-claim matches on.
    pub installation_id: Option<String>,
    pub last_seen_at: Option<i64>,
    pub activated_at: Option<i64>,
    pub finalized_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub provisioning_source: ProvisioningSource,
    pub display_label: Option<String>,
}

impl ComputerRecord {
    /// The three stamps, projected for the lifecycle rule.
    pub fn lifecycle(&self) -> HostLifecycleStamps {
        HostLifecycleStamps {
            activated_at: self.activated_at,
            finalized_at: self.finalized_at,
            revoked_at: self.revoked_at,
        }
    }

    /// Who the computer belongs to, projected for
    /// [`crate::identity_access::capability::computer_access::can_access_computer`].
    pub fn ownership(&self) -> ComputerOwnershipFacts {
        ComputerOwnershipFacts {
            id: self.id.clone(),
            owner: self.owner.clone(),
        }
    }

    /// The two facts a credential may be issued against, projected for
    /// [`super::custody::judge_credential_eligibility`]. A computer nobody holds and a
    /// revoked one are both ineligible, and neither question involves a stamp the
    /// lifecycle rule reads.
    pub fn credential_eligibility(&self) -> HostCredentialEligibilityFacts {
        HostCredentialEligibilityFacts {
            user_id: self.owner.clone(),
            revoked_at: self.revoked_at,
        }
    }

    pub fn is_user_managed(&self) -> bool {
        is_user_managed(self.kind, self.provisioning_source)
    }
}

/// Is this computer one the USER brought and holds the lifecycle of, rather than one
/// an installation registered for itself?
///
/// The one place the pair is read as a custody question, because four rules ask it
/// and each answers differently: a connect token may only resolve for such a
/// computer, revoke is refused for one, connect-token rotation is refused for
/// anything else, and only such a computer's lifecycle is a delete request's to end.
/// Spelled out per site, one of those four would eventually disagree about what
/// "user-managed" means — and each disagreement is either a refusal the product does
/// not have or a delete it should not allow.
///
/// The split is binary on purpose, matching the TypeScript predicate: every other
/// combination is app-managed, including a `local` row provisioned by an invite,
/// which is not a state any writer here can produce.
pub fn is_user_managed(kind: HostKind, provisioning_source: ProvisioningSource) -> bool {
    matches!(kind, HostKind::Remote)
        && matches!(provisioning_source, ProvisioningSource::UserInvite)
}

/// How long a display label may be, pinned to `HOST_DISPLAY_LABEL_MAX_LENGTH`
/// (`packages/shared/src/api/host.ts`).
///
/// Counted in UTF-16 code units, because that is what the bound was written in: both
/// the schema's `.max()` and the repository's own length check read JavaScript's
/// `String.prototype.length`. Counting characters instead would accept a label the
/// existing clients are refused for — one astral emoji is one character here and two
/// units there.
pub const COMPUTER_DISPLAY_LABEL_MAX_UNITS: usize = 64;

/// What the user typed for a computer, as it may be stored.
///
/// The whole rule lives in the constructor — trim, then refuse empty and over-long —
/// so "what a display label is" has one owner and a route cannot reach a write with a
/// string it validated its own way. Storing the trimmed form is deliberate: trimming
/// plus empty-to-absent is the documented clear-on-blank path, and is not a rewrite of
/// a value the user did type.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerDisplayLabel(String);

/// Why a label may not be stored. Two arms because the wire contract answers them
/// differently: one is "you sent nothing", the other is "you sent too much".
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisplayLabelRefusal {
    Empty,
    TooLong { units: usize },
}

impl ComputerDisplayLabel {
    pub fn parse(raw: &str) -> Result<Self, DisplayLabelRefusal> {
        let trimmed = raw.trim_matches(is_ecmascript_whitespace);
        let units = trimmed.encode_utf16().count();
        if units == 0 {
            return Err(DisplayLabelRefusal::Empty);
        }
        if units > COMPUTER_DISPLAY_LABEL_MAX_UNITS {
            return Err(DisplayLabelRefusal::TooLong { units });
        }
        Ok(Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

/// The whitespace ECMAScript's `String.prototype.trim` removes.
///
/// Spelled out rather than delegating to [`char::is_whitespace`] because the two sets
/// disagree on exactly two characters, and both of them are ones a paste into a text
/// field produces: a byte-order mark is trimmed by JavaScript and kept by Rust, and
/// `U+0085 NEXT LINE` is the reverse. Delegating would make a pasted label round-trip
/// differently through this port than through the schema that already accepted it.
fn is_ecmascript_whitespace(character: char) -> bool {
    character == '\u{feff}' || (character.is_whitespace() && character != '\u{85}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_remote_invite_is_user_managed() {
        assert!(is_user_managed(
            HostKind::Remote,
            ProvisioningSource::UserInvite
        ));
        assert!(!is_user_managed(
            HostKind::Local,
            ProvisioningSource::UserInvite
        ));
        assert!(!is_user_managed(
            HostKind::Remote,
            ProvisioningSource::AppInstall
        ));
        assert!(!is_user_managed(
            HostKind::Remote,
            ProvisioningSource::System
        ));
        assert!(!is_user_managed(
            HostKind::Local,
            ProvisioningSource::AppInstall
        ));
        assert!(!is_user_managed(
            HostKind::Local,
            ProvisioningSource::System
        ));
    }

    #[test]
    fn a_label_is_stored_trimmed_and_a_blank_one_is_refused() {
        assert_eq!(
            ComputerDisplayLabel::parse("  shiki's laptop \t")
                .unwrap()
                .as_str(),
            "shiki's laptop"
        );
        assert_eq!(
            ComputerDisplayLabel::parse("   \n "),
            Err(DisplayLabelRefusal::Empty)
        );
        assert_eq!(
            ComputerDisplayLabel::parse(""),
            Err(DisplayLabelRefusal::Empty)
        );
    }

    #[test]
    fn the_bound_counts_utf16_units_not_characters() {
        // Thirty-two astral emoji: thirty-two characters, sixty-four units. One more
        // and the schema that already accepted these clients would refuse it.
        let at_the_bound = "\u{1f600}".repeat(32);
        assert_eq!(at_the_bound.chars().count(), 32);
        assert_eq!(
            ComputerDisplayLabel::parse(&at_the_bound).unwrap().as_str(),
            at_the_bound
        );

        let over = "\u{1f600}".repeat(33);
        assert_eq!(
            ComputerDisplayLabel::parse(&over),
            Err(DisplayLabelRefusal::TooLong { units: 66 })
        );
        assert_eq!(
            ComputerDisplayLabel::parse(&"a".repeat(65)),
            Err(DisplayLabelRefusal::TooLong { units: 65 })
        );
    }

    #[test]
    fn the_trim_follows_ecmascript_where_rusts_own_disagrees() {
        // A byte-order mark is whitespace to `String.prototype.trim` and not to
        // `str::trim`; `U+0085 NEXT LINE` is the other way round. Swap the predicate
        // for `char::is_whitespace` and both of these flip.
        assert_eq!(
            ComputerDisplayLabel::parse("\u{feff}box\u{feff}")
                .unwrap()
                .as_str(),
            "box"
        );
        assert_eq!(
            ComputerDisplayLabel::parse("\u{85}box\u{85}")
                .unwrap()
                .as_str(),
            "\u{85}box\u{85}"
        );
    }
}
