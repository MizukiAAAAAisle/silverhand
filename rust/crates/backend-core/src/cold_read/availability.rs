//! Whether an agent can be reached right now.
//!
//! One reason to change: what makes an agent reachable. It is deliberately NOT
//! "how healthy the agent is" and NOT "how alive its runtime process is" — those
//! are separate faces with separate vocabularies, and the product has been burned
//! by conflating them, so the distinctions are named here:
//!
//!  - REACHABILITY (this leaf) is a two-valued fact about the path to an agent:
//!    the row still exists to accept work, its host is still a host of ours, and
//!    the delivery transport is attached to it.
//!  - A host's own availability is a four-valued lifecycle fact (available,
//!    disconnected, unreachable, revoked) belonging to the host status face. It
//!    shares the word and answers a different question.
//!  - Whether an agent's runtime PROCESS is alive is the host status face's
//!    per-agent projection, taken from the daemon's active-runtime set. It shares
//!    both literals with this leaf and can legitimately disagree with it: an
//!    idle-reaped agent on a connected host is reachable here and not alive there.
//!    Reading that projection as availability is the bug this paragraph exists to
//!    prevent.
//!
//! ## Two values, total
//!
//! There is no success arm for "cannot tell". Facts that cannot be read are the
//! caller's `Err` upstream of this module, and a renderer's "unknown" is a
//! projection of a failed request, never a value this layer produces.
//!
//! ## What this deliberately does NOT consult
//!
//! Not the host status read model (seed/snapshot/hydrate/retry), not runtime
//! session state, not materialization status, not the idle reaper. Gating on the
//! status read model reports an agent offline on a deployment that wired the
//! delivery transport without the snapshot projection — an attachment the delivery
//! path itself would accept. So an idle-reaped or not-yet-hydrated agent on a
//! connected host stays reachable, and the next message re-spawns it.
//!
//! ## The attachment must be the delivery gate's own fact
//!
//! [`HostAttachmentFacts`] must come from the SAME port the delivery transport
//! consults, because the `agent_availability_changed` edge fires on that port's
//! attach and detach. Read face and event face then observe one fact and cannot
//! drift into two middle layers. Nothing here can check that — an attachment read
//! from a second projection is well-formed — so it is an obligation on
//! composition, listed as such.

use thiserror::Error;

use crate::identity::{AgentId, HostId};

/// The two-valued fact a client reads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentAvailability {
    Online,
    Offline,
}

/// Why an agent is not reachable.
///
/// The wire carries only [`AgentAvailability`], so this exists for a different
/// reason: three independent rules all answer `Offline`, and a verdict that named
/// only the answer would leave their ORDER untestable — a reordering would keep
/// every value correct while changing which facts a read depends on.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Unreachable {
    /// The row is mid hard-delete: it can no longer accept work.
    BeingDeleted,
    /// No host row — the agent's host is not, or is no longer, a host of ours.
    HostGone,
    /// The host's authority was revoked, whatever its socket still says.
    HostRevoked,
    /// The delivery transport holds no attachment for the host.
    Detached,
}

/// The verdict, with the reason kept for the offline arm.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentReachability {
    Reachable,
    Unreachable(Unreachable),
}

impl AgentReachability {
    /// The value that crosses the wire. Total, and the only projection of a
    /// verdict, so a face cannot invent a third literal.
    pub fn availability(self) -> AgentAvailability {
        match self {
            Self::Reachable => AgentAvailability::Online,
            Self::Unreachable(_) => AgentAvailability::Offline,
        }
    }
}

/// The agent half. Two fields, both with a named consumer: the deletion marker is
/// the first rule, and the host id is the coordinate every other fact must be
/// about.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAvailabilityFacts {
    pub id: AgentId,
    pub host_id: HostId,
    pub deletion_started_at: Option<i64>,
}

/// The host row half. Absent when there is no row at all, which is its own arm
/// rather than a revoked host with a missing timestamp.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostReachabilityFacts {
    pub id: HostId,
    pub revoked_at: Option<i64>,
}

/// The transport half: whether the delivery path holds an attachment for one host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostAttachmentFacts {
    /// Which host this was observed for.
    pub host_id: HostId,
    /// A deployment with no transport port at all projects to `false`. An absent
    /// authority is a detached host, not a failed read: the delivery path would
    /// have nothing to send on either.
    pub attached: bool,
}

/// Facts about a host other than the one the agent sits on were composed into one
/// read.
///
/// Not a product value, and deliberately not an `Offline`: a read whose facts
/// describe two different hosts is a defect in the code that read them, which no
/// client can cause or act on. Answering `Offline` would hide it behind a
/// plausible value, and answering `Online` would report a reachable agent from
/// another host's socket. It is the same class of failure as
/// [`crate::teardown::contract`] and a separate type because it is about a
/// different aggregate.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("availability facts describe host {found:?} but the agent sits on {expected:?}")]
pub struct HostFactsMismatch {
    pub expected: HostId,
    pub found: HostId,
}

/// Read one agent's reachability.
///
/// Both host-side channels are bound to the AGENT's own host id — the coordinate
/// the read is about — and not to each other: a row and an attachment that agree
/// with each other about a third host would still answer for a host this agent
/// does not sit on.
///
/// Those checks run BEFORE the rules. A splice whose value would have been
/// `Offline` anyway is still a splice, and letting it answer would make the defect
/// visible only in the cases where it happens to matter.
///
/// Then, first match wins:
///
///  1. a row mid hard-delete cannot accept work;
///  2. no host row, then a revoked host. Revocation is checked before the socket
///     because a bare row revoke can race ahead of the socket teardown, and a
///     revoked host must not read reachable off a lingering connection;
///  3. the attachment.
pub fn read_agent_availability(
    agent: &AgentAvailabilityFacts,
    host: Option<&HostReachabilityFacts>,
    attachment: &HostAttachmentFacts,
) -> Result<AgentReachability, HostFactsMismatch> {
    if let Some(host) = host {
        same_host(&agent.host_id, &host.id)?;
    }
    same_host(&agent.host_id, &attachment.host_id)?;

    if agent.deletion_started_at.is_some() {
        return Ok(AgentReachability::Unreachable(Unreachable::BeingDeleted));
    }
    let Some(host) = host else {
        return Ok(AgentReachability::Unreachable(Unreachable::HostGone));
    };
    if host.revoked_at.is_some() {
        return Ok(AgentReachability::Unreachable(Unreachable::HostRevoked));
    }
    if !attachment.attached {
        return Ok(AgentReachability::Unreachable(Unreachable::Detached));
    }
    Ok(AgentReachability::Reachable)
}

fn same_host(expected: &HostId, found: &HostId) -> Result<(), HostFactsMismatch> {
    if expected == found {
        return Ok(());
    }
    Err(HostFactsMismatch {
        expected: expected.clone(),
        found: found.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host_id(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn agent(deletion_started_at: Option<i64>) -> AgentAvailabilityFacts {
        AgentAvailabilityFacts {
            id: AgentId::parse("a1").expect("agent id"),
            host_id: host_id("h1"),
            deletion_started_at,
        }
    }

    fn host(revoked_at: Option<i64>) -> HostReachabilityFacts {
        HostReachabilityFacts {
            id: host_id("h1"),
            revoked_at,
        }
    }

    fn attachment(id: &str, attached: bool) -> HostAttachmentFacts {
        HostAttachmentFacts {
            host_id: host_id(id),
            attached,
        }
    }

    fn read(
        agent: &AgentAvailabilityFacts,
        host: Option<&HostReachabilityFacts>,
        attachment: &HostAttachmentFacts,
    ) -> AgentReachability {
        read_agent_availability(agent, host, attachment).expect("one host")
    }

    #[test]
    fn an_attached_unrevoked_host_makes_its_agent_reachable() {
        let reachability = read(&agent(None), Some(&host(None)), &attachment("h1", true));
        assert_eq!(reachability, AgentReachability::Reachable);
        assert_eq!(reachability.availability(), AgentAvailability::Online);
    }

    /// Beats a revoked host and beats a missing row: swapping either rule ahead of
    /// it would report that rule's cause instead.
    #[test]
    fn deletion_answers_before_any_host_fact() {
        assert_eq!(
            read(
                &agent(Some(10)),
                Some(&host(Some(20))),
                &attachment("h1", true)
            ),
            AgentReachability::Unreachable(Unreachable::BeingDeleted)
        );
        assert_eq!(
            read(&agent(Some(10)), None, &attachment("h1", false)),
            AgentReachability::Unreachable(Unreachable::BeingDeleted)
        );
    }

    /// Absence is its own cause, not a revoked host with a missing timestamp.
    #[test]
    fn a_missing_host_row_is_not_reported_as_a_revoked_one() {
        assert_eq!(
            read(&agent(None), None, &attachment("h1", true)),
            AgentReachability::Unreachable(Unreachable::HostGone)
        );
    }

    /// The product claim: revocation wins over a socket the transport still holds,
    /// so a revoke racing ahead of its teardown never reads reachable.
    #[test]
    fn a_lingering_attachment_does_not_save_a_revoked_host() {
        let reachability = read(&agent(None), Some(&host(Some(20))), &attachment("h1", true));
        assert_eq!(
            reachability,
            AgentReachability::Unreachable(Unreachable::HostRevoked)
        );
        assert_eq!(reachability.availability(), AgentAvailability::Offline);
    }

    /// Both later rules hold: checking the attachment first would report `Detached`
    /// for a host whose authority is gone for good.
    #[test]
    fn a_revoked_host_is_revoked_rather_than_merely_detached() {
        assert_eq!(
            read(
                &agent(None),
                Some(&host(Some(20))),
                &attachment("h1", false)
            ),
            AgentReachability::Unreachable(Unreachable::HostRevoked)
        );
    }

    /// The last rule answers only once every earlier one is satisfied.
    #[test]
    fn detachment_answers_only_on_a_live_host() {
        assert_eq!(
            read(&agent(None), Some(&host(None)), &attachment("h1", false)),
            AgentReachability::Unreachable(Unreachable::Detached)
        );
    }

    #[test]
    fn every_reason_projects_to_one_offline_literal() {
        for reason in [
            Unreachable::BeingDeleted,
            Unreachable::HostGone,
            Unreachable::HostRevoked,
            Unreachable::Detached,
        ] {
            assert_eq!(
                AgentReachability::Unreachable(reason).availability(),
                AgentAvailability::Offline
            );
        }
    }

    #[test]
    fn a_host_row_for_another_host_is_not_this_agents_answer() {
        let found = host_id("h2");
        assert_eq!(
            read_agent_availability(
                &agent(None),
                Some(&HostReachabilityFacts {
                    id: found.clone(),
                    revoked_at: None,
                }),
                &attachment("h1", true),
            ),
            Err(HostFactsMismatch {
                expected: host_id("h1"),
                found,
            })
        );
    }

    #[test]
    fn an_attachment_observed_for_another_host_is_not_this_agents_answer() {
        let found = host_id("h2");
        assert_eq!(
            read_agent_availability(
                &agent(None),
                Some(&host(None)),
                &attachment(found.as_str(), true),
            ),
            Err(HostFactsMismatch {
                expected: host_id("h1"),
                found,
            })
        );
    }

    /// Neither channel is checked against the OTHER: two facts that agree with
    /// each other about a third host still do not describe this agent.
    #[test]
    fn two_channels_agreeing_about_another_host_are_still_not_this_agents_answer() {
        let found = host_id("h2");
        assert_eq!(
            read_agent_availability(
                &agent(None),
                Some(&HostReachabilityFacts {
                    id: found.clone(),
                    revoked_at: None,
                }),
                &attachment(found.as_str(), true),
            ),
            Err(HostFactsMismatch {
                expected: host_id("h1"),
                found,
            })
        );
    }

    /// The attachment's coordinate is checked whether or not a host row was found,
    /// so an absent row cannot become the reason a splice goes unnoticed.
    #[test]
    fn an_attachment_for_another_host_is_refused_without_a_host_row_too() {
        let found = host_id("h2");
        assert_eq!(
            read_agent_availability(&agent(None), None, &attachment(found.as_str(), true)),
            Err(HostFactsMismatch {
                expected: host_id("h1"),
                found,
            })
        );
    }

    /// The splice is refused even where the rules would have answered `Offline`
    /// on their own, so it cannot hide behind a plausible value.
    #[test]
    fn a_spliced_read_is_refused_before_any_rule_answers() {
        assert!(
            read_agent_availability(
                &agent(Some(10)),
                Some(&host(Some(20))),
                &attachment("h2", false),
            )
            .is_err()
        );
    }
}
