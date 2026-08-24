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
//! ## Every channel is bound to the coordinate the REQUEST named
//!
//! Three fact channels are composed here, and each is checked against a coordinate
//! the request itself names — the agent asked about, and the host that agent's row
//! says it sits on — never against each other. Facts that agree with one another
//! about a second agent or a third host still do not describe this read.
//!
//! The agent channel needs this most, because the answer carries no agent id: a
//! verdict computed from the wrong row is a well-formed `Online`/`Offline` that no
//! downstream face can tell from the right one. The checks therefore run BEFORE any
//! product rule, so a splice cannot hide behind an `Offline` the rules would have
//! answered anyway, and a mismatch is an internal contract failure rather than a
//! product refusal: no client can cause it and none can act on it.
//!
//! ## The cause does not leave this crate
//!
//! [`AgentReachability`] is opaque beyond `backend-core`, and
//! [`AgentReachability::availability`] is its only reader, so a face cannot branch
//! on the cause, render it, or project a third literal out of it. The cause is kept
//! module-private because three independent rules all answer `Offline` and their
//! ORDER would otherwise be untestable — a reordering keeps every value correct
//! while changing which facts a read depends on. That is a core-internal concern.
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

use std::fmt;

use thiserror::Error;

use crate::identity::{AgentId, HostId};

/// The two-valued fact a client reads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentAvailability {
    Online,
    Offline,
}

/// Why an agent is not reachable. Module-private: it exists to make the order of
/// the rules testable, and never to be rendered.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Unreachable {
    /// The row is mid hard-delete: it can no longer accept work.
    BeingDeleted,
    /// No host row — the agent's host is not, or is no longer, a host of ours.
    HostGone,
    /// The host's authority was revoked, whatever its socket still says.
    HostRevoked,
    /// The delivery transport holds no attachment for the host.
    Detached,
}

/// The verdict.
///
/// Opaque on purpose: the only thing any consumer can obtain from it is
/// [`AgentAvailability`], which is also the only value the wire carries. The cause
/// has no reader outside this module's own tests, so "the cause never reaches a
/// face" is a property of the type rather than a sentence in this file:
///
/// ```compile_fail
/// use silverhand_backend_core::cold_read::availability::{
///     read_agent_availability, AgentAvailabilityFacts, HostAttachmentFacts,
///     HostReachabilityFacts,
/// };
/// use silverhand_backend_core::identity::{AgentId, HostId};
///
/// let id = AgentId::parse("a1").unwrap();
/// let host_id = HostId::parse("h1").unwrap();
/// let verdict = read_agent_availability(
///     &id,
///     &AgentAvailabilityFacts {
///         id: id.clone(),
///         host_id: host_id.clone(),
///         deletion_started_at: None,
///     },
///     Some(&HostReachabilityFacts { id: host_id.clone(), revoked_at: None }),
///     &HostAttachmentFacts { host_id, attached: true },
/// )
/// .unwrap();
/// let _cause = verdict.cause();
/// ```
///
/// The same code through the projection compiles, so the gate above fails for the
/// reason it claims and not because its setup went stale:
///
/// ```
/// use silverhand_backend_core::cold_read::availability::{
///     read_agent_availability, AgentAvailability, AgentAvailabilityFacts,
///     HostAttachmentFacts, HostReachabilityFacts,
/// };
/// use silverhand_backend_core::identity::{AgentId, HostId};
///
/// let id = AgentId::parse("a1").unwrap();
/// let host_id = HostId::parse("h1").unwrap();
/// let verdict = read_agent_availability(
///     &id,
///     &AgentAvailabilityFacts {
///         id: id.clone(),
///         host_id: host_id.clone(),
///         deletion_started_at: None,
///     },
///     Some(&HostReachabilityFacts { id: host_id.clone(), revoked_at: None }),
///     &HostAttachmentFacts { host_id, attached: true },
/// )
/// .unwrap();
/// assert_eq!(verdict.availability(), AgentAvailability::Online);
/// ```
#[derive(Clone, Copy)]
pub struct AgentReachability(Reachability);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Reachability {
    Reachable,
    Unreachable(Unreachable),
}

impl AgentReachability {
    /// The value that crosses the wire. Total, and the only projection of a
    /// verdict, so a face cannot invent a third literal.
    pub fn availability(self) -> AgentAvailability {
        match self.0 {
            Reachability::Reachable => AgentAvailability::Online,
            Reachability::Unreachable(_) => AgentAvailability::Offline,
        }
    }

    fn reachable() -> Self {
        Self(Reachability::Reachable)
    }

    fn unreachable(cause: Unreachable) -> Self {
        Self(Reachability::Unreachable(cause))
    }

    /// The rules' ORDER is the only thing the cause serves, and that is asserted
    /// here, so production carries no reader for it.
    #[cfg(test)]
    fn cause(self) -> Option<Unreachable> {
        match self.0 {
            Reachability::Reachable => None,
            Reachability::Unreachable(cause) => Some(cause),
        }
    }
}

impl fmt::Debug for AgentReachability {
    /// Renders the projection alone. A derived `Debug` is a second projection with
    /// a wider vocabulary than the wire's, and it reaches every log line and error
    /// message a consumer writes.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.availability(), formatter)
    }
}

/// The agent half. Every field has a named consumer: the id is the coordinate the
/// read is about, the deletion marker is the first rule, and the host id is the
/// coordinate every host-side fact must be about.
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

/// Facts describing a row other than the one the read is about were composed into
/// one answer.
///
/// Not a product value, and deliberately not an `Offline`: a read whose facts
/// describe another agent, or a host the agent does not sit on, is a defect in the
/// code that read them, which no client can cause or act on. Answering `Offline`
/// would hide it behind a plausible value, and answering `Online` would report a
/// reachable agent from another row's facts. It is the same class of failure as
/// [`crate::teardown::contract`], and a separate type because it is about a
/// different aggregate: one vocabulary per aggregate, so a caller's mapping cannot
/// be reused past the boundary where it was reviewed.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum AvailabilityFactsMismatch {
    #[error("availability facts describe agent {found:?} but the read is about {expected:?}")]
    Agent { expected: AgentId, found: AgentId },
    #[error("availability facts describe host {found:?} but the agent sits on {expected:?}")]
    Host { expected: HostId, found: HostId },
}

/// Read one agent's reachability.
///
/// `requested` is the coordinate the read is about — the id a route was asked for —
/// and the agent facts must describe it. Both host-side channels are then bound to
/// the AGENT's own host id, and not to each other: a row and an attachment that
/// agree with each other about a third host would still answer for a host this
/// agent does not sit on.
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
    requested: &AgentId,
    agent: &AgentAvailabilityFacts,
    host: Option<&HostReachabilityFacts>,
    attachment: &HostAttachmentFacts,
) -> Result<AgentReachability, AvailabilityFactsMismatch> {
    if requested != &agent.id {
        return Err(AvailabilityFactsMismatch::Agent {
            expected: requested.clone(),
            found: agent.id.clone(),
        });
    }
    if let Some(host) = host {
        same_host(&agent.host_id, &host.id)?;
    }
    same_host(&agent.host_id, &attachment.host_id)?;

    if agent.deletion_started_at.is_some() {
        return Ok(AgentReachability::unreachable(Unreachable::BeingDeleted));
    }
    let Some(host) = host else {
        return Ok(AgentReachability::unreachable(Unreachable::HostGone));
    };
    if host.revoked_at.is_some() {
        return Ok(AgentReachability::unreachable(Unreachable::HostRevoked));
    }
    if !attachment.attached {
        return Ok(AgentReachability::unreachable(Unreachable::Detached));
    }
    Ok(AgentReachability::reachable())
}

fn same_host(expected: &HostId, found: &HostId) -> Result<(), AvailabilityFactsMismatch> {
    if expected == found {
        return Ok(());
    }
    Err(AvailabilityFactsMismatch::Host {
        expected: expected.clone(),
        found: found.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_id(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn host_id(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn agent(deletion_started_at: Option<i64>) -> AgentAvailabilityFacts {
        AgentAvailabilityFacts {
            id: agent_id("a1"),
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

    /// Asks about the agent the facts describe, which is what every rule case is
    /// about; the seal itself is exercised by asking about someone else.
    fn read(
        agent: &AgentAvailabilityFacts,
        host: Option<&HostReachabilityFacts>,
        attachment: &HostAttachmentFacts,
    ) -> AgentReachability {
        read_agent_availability(&agent.id.clone(), agent, host, attachment).expect("one row")
    }

    #[test]
    fn an_attached_unrevoked_host_makes_its_agent_reachable() {
        let reachability = read(&agent(None), Some(&host(None)), &attachment("h1", true));
        assert_eq!(reachability.cause(), None);
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
            )
            .cause(),
            Some(Unreachable::BeingDeleted)
        );
        assert_eq!(
            read(&agent(Some(10)), None, &attachment("h1", false)).cause(),
            Some(Unreachable::BeingDeleted)
        );
    }

    /// Absence is its own cause, not a revoked host with a missing timestamp.
    #[test]
    fn a_missing_host_row_is_not_reported_as_a_revoked_one() {
        assert_eq!(
            read(&agent(None), None, &attachment("h1", true)).cause(),
            Some(Unreachable::HostGone)
        );
    }

    /// The product claim: revocation wins over a socket the transport still holds,
    /// so a revoke racing ahead of its teardown never reads reachable.
    #[test]
    fn a_lingering_attachment_does_not_save_a_revoked_host() {
        let reachability = read(&agent(None), Some(&host(Some(20))), &attachment("h1", true));
        assert_eq!(reachability.cause(), Some(Unreachable::HostRevoked));
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
            )
            .cause(),
            Some(Unreachable::HostRevoked)
        );
    }

    /// The last rule answers only once every earlier one is satisfied.
    #[test]
    fn detachment_answers_only_on_a_live_host() {
        assert_eq!(
            read(&agent(None), Some(&host(None)), &attachment("h1", false)).cause(),
            Some(Unreachable::Detached)
        );
    }

    /// `Debug` is a projection too, and a derived one would carry the cause into
    /// every log line and assertion message a consumer writes.
    #[test]
    fn rendering_a_verdict_shows_the_wire_value_and_nothing_else() {
        assert_eq!(
            format!(
                "{:?}",
                read(&agent(None), Some(&host(Some(20))), &attachment("h1", true))
            ),
            "Offline"
        );
        assert_eq!(
            format!(
                "{:?}",
                read(&agent(None), Some(&host(None)), &attachment("h1", true))
            ),
            "Online"
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
                AgentReachability::unreachable(reason).availability(),
                AgentAvailability::Offline
            );
        }
    }

    /// The answer carries no agent id, so facts read for a second agent would be an
    /// indistinguishable `Online` downstream.
    #[test]
    fn facts_about_another_agent_are_not_this_reads_answer() {
        assert_eq!(
            read_agent_availability(
                &agent_id("a2"),
                &agent(None),
                Some(&host(None)),
                &attachment("h1", true),
            )
            .expect_err("a second agent's facts"),
            AvailabilityFactsMismatch::Agent {
                expected: agent_id("a2"),
                found: agent_id("a1"),
            }
        );
    }

    /// The agent coordinate is checked before any rule, so a mis-read row cannot be
    /// excused by an `Offline` the rules would have answered on their own.
    #[test]
    fn an_agent_splice_is_refused_before_the_rules_answer() {
        assert!(matches!(
            read_agent_availability(
                &agent_id("a2"),
                &agent(Some(10)),
                Some(&host(Some(20))),
                &attachment("h1", false),
            ),
            Err(AvailabilityFactsMismatch::Agent { .. })
        ));
    }

    /// The host channels are bound to the agent row's host, and the row itself is
    /// bound to the request: internally consistent facts about a second agent are
    /// still refused.
    #[test]
    fn host_facts_agreeing_with_another_agents_row_are_still_refused() {
        let other = AgentAvailabilityFacts {
            id: agent_id("a2"),
            host_id: host_id("h2"),
            deletion_started_at: None,
        };
        assert!(matches!(
            read_agent_availability(
                &agent_id("a1"),
                &other,
                Some(&HostReachabilityFacts {
                    id: host_id("h2"),
                    revoked_at: None,
                }),
                &attachment("h2", true),
            ),
            Err(AvailabilityFactsMismatch::Agent { .. })
        ));
    }

    #[test]
    fn a_host_row_for_another_host_is_not_this_agents_answer() {
        let found = host_id("h2");
        assert_eq!(
            read_agent_availability(
                &agent_id("a1"),
                &agent(None),
                Some(&HostReachabilityFacts {
                    id: found.clone(),
                    revoked_at: None,
                }),
                &attachment("h1", true),
            )
            .expect_err("another host's row"),
            AvailabilityFactsMismatch::Host {
                expected: host_id("h1"),
                found,
            }
        );
    }

    #[test]
    fn an_attachment_observed_for_another_host_is_not_this_agents_answer() {
        let found = host_id("h2");
        assert_eq!(
            read_agent_availability(
                &agent_id("a1"),
                &agent(None),
                Some(&host(None)),
                &attachment(found.as_str(), true),
            )
            .expect_err("another host's attachment"),
            AvailabilityFactsMismatch::Host {
                expected: host_id("h1"),
                found,
            }
        );
    }

    /// Neither host channel is checked against the OTHER: two facts that agree with
    /// each other about a third host still do not describe this agent.
    #[test]
    fn two_channels_agreeing_about_another_host_are_still_not_this_agents_answer() {
        let found = host_id("h2");
        assert_eq!(
            read_agent_availability(
                &agent_id("a1"),
                &agent(None),
                Some(&HostReachabilityFacts {
                    id: found.clone(),
                    revoked_at: None,
                }),
                &attachment(found.as_str(), true),
            )
            .expect_err("two facts about a third host"),
            AvailabilityFactsMismatch::Host {
                expected: host_id("h1"),
                found,
            }
        );
    }

    /// The attachment's coordinate is checked whether or not a host row was found,
    /// so an absent row cannot become the reason a splice goes unnoticed.
    #[test]
    fn an_attachment_for_another_host_is_refused_without_a_host_row_too() {
        let found = host_id("h2");
        assert_eq!(
            read_agent_availability(
                &agent_id("a1"),
                &agent(None),
                None,
                &attachment(found.as_str(), true)
            )
            .expect_err("another host's attachment"),
            AvailabilityFactsMismatch::Host {
                expected: host_id("h1"),
                found,
            }
        );
    }

    /// The splice is refused even where the rules would have answered `Offline`
    /// on their own, so it cannot hide behind a plausible value.
    #[test]
    fn a_spliced_read_is_refused_before_any_rule_answers() {
        assert!(
            read_agent_availability(
                &agent_id("a1"),
                &agent(Some(10)),
                Some(&host(Some(20))),
                &attachment("h2", false),
            )
            .is_err()
        );
    }
}
