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
//! The verdict still projects to exactly two values; there is no success arm for
//! "cannot tell". But this module now DRIVES the host-side reads itself, lazily, so
//! the rule order decides which are taken at all. A fact that cannot be read
//! therefore surfaces HERE as [`AvailabilityReadError::Fetch`] — an infrastructure
//! fault the route renders as a `500`, distinct from a facts mismatch, and never a
//! renderer's "unknown", which stays a projection of a failed request rather than a
//! value this layer produces.
//!
//! ## Each channel is bound to the coordinate the REQUEST named, WHEN it is read
//!
//! Three fact channels are composed here, and each is checked against a coordinate
//! the request itself names — the agent asked about, and the host that agent's row
//! says it sits on — never against each other. Facts that agree with one another
//! about a second agent or a third host still do not describe this read.
//!
//! The agent channel is checked FIRST, before any rule and before any host-side
//! read, because the answer carries no agent id: a verdict computed from the wrong
//! row is a well-formed `Online`/`Offline` no downstream face can tell from the
//! right one. Each host-side channel is then bound at the point its read is
//! consulted — and a read the rule order short-circuits is never consulted, so
//! there is no spliced fact to catch there. A mismatch that IS reached is an
//! internal contract failure rather than a product refusal: no client can cause it
//! or act on it.
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

use std::{fmt, future::Future};

use thiserror::Error;

use crate::{
    foundation::identity::{AgentId, HostId},
    foundation::persistence::PersistenceFailure,
};

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
/// use silverhand_backend_core::foundation::identity::{AgentId, HostId};
/// use silverhand_backend_core::foundation::persistence::PersistenceFailure;
///
/// async fn demo() {
///     let id = AgentId::parse("a1").unwrap();
///     let host_id = HostId::parse("h1").unwrap();
///     let verdict = read_agent_availability(
///         &id,
///         &AgentAvailabilityFacts { id: id.clone(), host_id, deletion_started_at: None },
///         |host: HostId| std::future::ready(Ok::<_, PersistenceFailure>(Some(
///             HostReachabilityFacts { id: host, revoked_at: None },
///         ))),
///         |host: HostId| std::future::ready(Ok::<_, PersistenceFailure>(
///             HostAttachmentFacts { host_id: host, attached: true },
///         )),
///     )
///     .await
///     .unwrap();
///     let _cause = verdict.cause();
/// }
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
/// use silverhand_backend_core::foundation::identity::{AgentId, HostId};
/// use silverhand_backend_core::foundation::persistence::PersistenceFailure;
///
/// async fn demo() {
///     let id = AgentId::parse("a1").unwrap();
///     let host_id = HostId::parse("h1").unwrap();
///     let verdict = read_agent_availability(
///         &id,
///         &AgentAvailabilityFacts { id: id.clone(), host_id, deletion_started_at: None },
///         |host: HostId| std::future::ready(Ok::<_, PersistenceFailure>(Some(
///             HostReachabilityFacts { id: host, revoked_at: None },
///         ))),
///         |host: HostId| std::future::ready(Ok::<_, PersistenceFailure>(
///             HostAttachmentFacts { host_id: host, attached: true },
///         )),
///     )
///     .await
///     .unwrap();
///     assert_eq!(verdict.availability(), AgentAvailability::Online);
/// }
/// let _ = demo;
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

/// Why an availability read did not produce a verdict.
///
/// The rule below drives the host-side reads itself, so the two ways it can fail
/// are named apart: a [`Fetch`](Self::Fetch) is infrastructure — a fact the rule
/// asked for could not be read — which the route renders as a `500`; a
/// [`Mismatch`](Self::Mismatch) is a composition splice, the same class of defect
/// as before, which also takes a `500` rather than a plausible `offline`. Keeping
/// them distinct lets a caller assert that a short-circuited read was never taken:
/// a rule that stopped early cannot report a `Fetch` from a source it never
/// consulted.
#[derive(Debug, Error)]
pub enum AvailabilityReadError {
    #[error("an availability fact could not be read")]
    Fetch(#[source] PersistenceFailure),
    #[error(transparent)]
    Mismatch(#[from] AvailabilityFactsMismatch),
}

/// Read one agent's reachability, taking the host-side facts lazily so the rule
/// order decides which reads happen at all.
///
/// `requested` is the coordinate the read is about — the id a route was asked for —
/// and the agent facts must describe it; that seal is checked FIRST, before any
/// rule and before either lazy read, because a verdict computed from the wrong row
/// carries no id to give it away.
///
/// Then, first match wins, and each read is taken only if the rules reach it:
///
///  1. a row mid hard-delete cannot accept work — answered without reading either
///     host-side fact, so a source that is down cannot turn an offline into a `500`;
///  2. otherwise the host row is read; no row, then a revoked host. Revocation is
///     checked before the socket because a bare row revoke can race ahead of the
///     socket teardown, and a revoked host must not read reachable off a lingering
///     connection. Neither arm reads the attachment;
///  3. otherwise the attachment is read.
///
/// Each host-side fact is bound to the AGENT's own host id at the point it is
/// consulted, and not to the other: a row and an attachment that agree with each
/// other about a third host would still answer for a host this agent does not sit
/// on. A read that is never consulted is never sealed — there is nothing to splice.
///
/// The lazy reads receive the host id BY VALUE (an owned clone of the agent's own
/// host id): a closure that borrowed a reference into this frame could not return a
/// future outliving that borrow under one concrete future type.
pub async fn read_agent_availability<ReadHost, HostFut, ReadAttachment, AttachFut>(
    requested: &AgentId,
    agent: &AgentAvailabilityFacts,
    read_host: ReadHost,
    read_attachment: ReadAttachment,
) -> Result<AgentReachability, AvailabilityReadError>
where
    ReadHost: FnOnce(HostId) -> HostFut,
    HostFut: Future<Output = Result<Option<HostReachabilityFacts>, PersistenceFailure>>,
    ReadAttachment: FnOnce(HostId) -> AttachFut,
    AttachFut: Future<Output = Result<HostAttachmentFacts, PersistenceFailure>>,
{
    if requested != &agent.id {
        return Err(AvailabilityFactsMismatch::Agent {
            expected: requested.clone(),
            found: agent.id.clone(),
        }
        .into());
    }
    if agent.deletion_started_at.is_some() {
        return Ok(AgentReachability::unreachable(Unreachable::BeingDeleted));
    }

    let host = read_host(agent.host_id.clone())
        .await
        .map_err(AvailabilityReadError::Fetch)?;
    let Some(host) = host else {
        return Ok(AgentReachability::unreachable(Unreachable::HostGone));
    };
    same_host(&agent.host_id, &host.id)?;
    if host.revoked_at.is_some() {
        return Ok(AgentReachability::unreachable(Unreachable::HostRevoked));
    }

    let attachment = read_attachment(agent.host_id.clone())
        .await
        .map_err(AvailabilityReadError::Fetch)?;
    same_host(&agent.host_id, &attachment.host_id)?;
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

    /// A source fault to hand a read that must NOT be consulted: if the rule reaches
    /// it, it surfaces as `Fetch` and the case fails, so a short-circuit is proven
    /// rather than assumed.
    fn fault() -> PersistenceFailure {
        PersistenceFailure::from_source(std::io::Error::other("fact source down"))
    }

    /// A host read that yields one fixed owned outcome. `FnOnce`, so a
    /// non-`Clone` `PersistenceFailure` can be moved straight through.
    fn host_read(
        outcome: Result<Option<HostReachabilityFacts>, PersistenceFailure>,
    ) -> impl FnOnce(
        HostId,
    )
        -> std::future::Ready<Result<Option<HostReachabilityFacts>, PersistenceFailure>> {
        move |_| std::future::ready(outcome)
    }

    /// An attachment read that yields one fixed owned outcome.
    fn attachment_read(
        outcome: Result<HostAttachmentFacts, PersistenceFailure>,
    ) -> impl FnOnce(HostId) -> std::future::Ready<Result<HostAttachmentFacts, PersistenceFailure>>
    {
        move |_| std::future::ready(outcome)
    }

    fn expect_mismatch(error: AvailabilityReadError) -> AvailabilityFactsMismatch {
        match error {
            AvailabilityReadError::Mismatch(mismatch) => mismatch,
            AvailabilityReadError::Fetch(_) => {
                panic!("expected a facts mismatch, not a fetch failure")
            }
        }
    }

    /// Asks about the agent the facts describe, which is what every rule case is
    /// about; the seals are exercised by asking about someone else. Takes the facts
    /// by value and feeds them through ready closures, so a rule case reads the same
    /// way the route does.
    async fn read(
        agent: &AgentAvailabilityFacts,
        host: Option<HostReachabilityFacts>,
        attachment: HostAttachmentFacts,
    ) -> AgentReachability {
        read_agent_availability(
            &agent.id,
            agent,
            host_read(Ok(host)),
            attachment_read(Ok(attachment)),
        )
        .await
        .expect("one row")
    }

    #[tokio::test]
    async fn an_attached_unrevoked_host_makes_its_agent_reachable() {
        let reachability = read(&agent(None), Some(host(None)), attachment("h1", true)).await;
        assert_eq!(reachability.cause(), None);
        assert_eq!(reachability.availability(), AgentAvailability::Online);
    }

    /// Beats a revoked host and beats a missing row: swapping either rule ahead of
    /// it would report that rule's cause instead.
    #[tokio::test]
    async fn deletion_answers_before_any_host_fact() {
        assert_eq!(
            read(
                &agent(Some(10)),
                Some(host(Some(20))),
                attachment("h1", true)
            )
            .await
            .cause(),
            Some(Unreachable::BeingDeleted)
        );
        assert_eq!(
            read(&agent(Some(10)), None, attachment("h1", false))
                .await
                .cause(),
            Some(Unreachable::BeingDeleted)
        );
    }

    /// Absence is its own cause, not a revoked host with a missing timestamp.
    #[tokio::test]
    async fn a_missing_host_row_is_not_reported_as_a_revoked_one() {
        assert_eq!(
            read(&agent(None), None, attachment("h1", true))
                .await
                .cause(),
            Some(Unreachable::HostGone)
        );
    }

    /// The product claim: revocation wins over a socket the transport still holds,
    /// so a revoke racing ahead of its teardown never reads reachable.
    #[tokio::test]
    async fn a_lingering_attachment_does_not_save_a_revoked_host() {
        let reachability = read(&agent(None), Some(host(Some(20))), attachment("h1", true)).await;
        assert_eq!(reachability.cause(), Some(Unreachable::HostRevoked));
        assert_eq!(reachability.availability(), AgentAvailability::Offline);
    }

    /// Both later rules hold: checking the attachment first would report `Detached`
    /// for a host whose authority is gone for good.
    #[tokio::test]
    async fn a_revoked_host_is_revoked_rather_than_merely_detached() {
        assert_eq!(
            read(&agent(None), Some(host(Some(20))), attachment("h1", false))
                .await
                .cause(),
            Some(Unreachable::HostRevoked)
        );
    }

    /// The last rule answers only once every earlier one is satisfied.
    #[tokio::test]
    async fn detachment_answers_only_on_a_live_host() {
        assert_eq!(
            read(&agent(None), Some(host(None)), attachment("h1", false))
                .await
                .cause(),
            Some(Unreachable::Detached)
        );
    }

    /// `Debug` is a projection too, and a derived one would carry the cause into
    /// every log line and assertion message a consumer writes.
    #[tokio::test]
    async fn rendering_a_verdict_shows_the_wire_value_and_nothing_else() {
        assert_eq!(
            format!(
                "{:?}",
                read(&agent(None), Some(host(Some(20))), attachment("h1", true)).await
            ),
            "Offline"
        );
        assert_eq!(
            format!(
                "{:?}",
                read(&agent(None), Some(host(None)), attachment("h1", true)).await
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

    /// A deleting row answers before either host-side read: faulting both proves the
    /// rule never consults them, so a source that is down cannot turn what the wire
    /// would show as `offline` into a `500`.
    #[tokio::test]
    async fn a_deleting_agent_reads_neither_host_nor_attachment() {
        let deleting = agent(Some(10));
        let verdict = read_agent_availability(
            &deleting.id,
            &deleting,
            host_read(Err(fault())),
            attachment_read(Err(fault())),
        )
        .await
        .expect("deletion short-circuits before either read");
        assert_eq!(verdict.cause(), Some(Unreachable::BeingDeleted));
    }

    /// A missing or revoked host answers before the attachment is read: faulting the
    /// attachment proves it is never consulted on either arm.
    #[tokio::test]
    async fn a_gone_or_revoked_host_reads_no_attachment() {
        let live = agent(None);

        let gone = read_agent_availability(
            &live.id,
            &live,
            host_read(Ok(None)),
            attachment_read(Err(fault())),
        )
        .await
        .expect("a gone host short-circuits before the attachment");
        assert_eq!(gone.cause(), Some(Unreachable::HostGone));

        let revoked = read_agent_availability(
            &live.id,
            &live,
            host_read(Ok(Some(host(Some(20))))),
            attachment_read(Err(fault())),
        )
        .await
        .expect("a revoked host short-circuits before the attachment");
        assert_eq!(revoked.cause(), Some(Unreachable::HostRevoked));
    }

    /// A read the rules DO reach, whose source is down, is a fetch failure — a `500`
    /// — never a value invented to fill the gap. Both reachable reads are covered.
    #[tokio::test]
    async fn a_consulted_read_that_faults_is_a_fetch_failure() {
        let live = agent(None);

        let host_down = read_agent_availability(
            &live.id,
            &live,
            host_read(Err(fault())),
            attachment_read(Ok(attachment("h1", true))),
        )
        .await
        .expect_err("a faulting host read is not a value");
        assert!(matches!(host_down, AvailabilityReadError::Fetch(_)));

        let attachment_down = read_agent_availability(
            &live.id,
            &live,
            host_read(Ok(Some(host(None)))),
            attachment_read(Err(fault())),
        )
        .await
        .expect_err("a faulting attachment read is not a value");
        assert!(matches!(attachment_down, AvailabilityReadError::Fetch(_)));
    }

    /// The answer carries no agent id, so facts read for a second agent would be an
    /// indistinguishable `Online` downstream. Faulting both reads proves the agent
    /// seal answers first: were it not, a consulted read would surface as `Fetch`.
    #[tokio::test]
    async fn facts_about_another_agent_are_not_this_reads_answer() {
        let error = read_agent_availability(
            &agent_id("a2"),
            &agent(None),
            host_read(Err(fault())),
            attachment_read(Err(fault())),
        )
        .await
        .expect_err("a second agent's facts");
        assert_eq!(
            expect_mismatch(error),
            AvailabilityFactsMismatch::Agent {
                expected: agent_id("a2"),
                found: agent_id("a1"),
            }
        );
    }

    /// The agent seal is checked before even the first rule, so a mis-read row for a
    /// DELETING agent cannot be excused by the `offline` deletion would have given.
    #[tokio::test]
    async fn an_agent_splice_is_refused_before_the_rules_answer() {
        let error = read_agent_availability(
            &agent_id("a2"),
            &agent(Some(10)),
            host_read(Err(fault())),
            attachment_read(Err(fault())),
        )
        .await
        .expect_err("a second agent's deleting row");
        assert!(matches!(
            expect_mismatch(error),
            AvailabilityFactsMismatch::Agent { .. }
        ));
    }

    /// The row is bound to the request before any host-side read: internally
    /// consistent facts about a second agent are refused on the agent seal alone.
    #[tokio::test]
    async fn host_facts_agreeing_with_another_agents_row_are_still_refused() {
        let other = AgentAvailabilityFacts {
            id: agent_id("a2"),
            host_id: host_id("h2"),
            deletion_started_at: None,
        };
        let error = read_agent_availability(
            &agent_id("a1"),
            &other,
            host_read(Err(fault())),
            attachment_read(Err(fault())),
        )
        .await
        .expect_err("a second agent's row");
        assert!(matches!(
            expect_mismatch(error),
            AvailabilityFactsMismatch::Agent { .. }
        ));
    }

    /// The host row is bound to the agent's own host when it is read; a row for
    /// another host is refused there, before the attachment is consulted (which is
    /// faulted to prove it is not).
    #[tokio::test]
    async fn a_host_row_for_another_host_is_not_this_agents_answer() {
        let found = host_id("h2");
        let error = read_agent_availability(
            &agent_id("a1"),
            &agent(None),
            host_read(Ok(Some(HostReachabilityFacts {
                id: host_id("h2"),
                revoked_at: None,
            }))),
            attachment_read(Err(fault())),
        )
        .await
        .expect_err("another host's row");
        assert_eq!(
            expect_mismatch(error),
            AvailabilityFactsMismatch::Host {
                expected: host_id("h1"),
                found,
            }
        );
    }

    /// The attachment is bound to the agent's own host when it is read, reached only
    /// on a live unrevoked host: an attachment observed for another host is refused.
    #[tokio::test]
    async fn an_attachment_observed_for_another_host_is_not_this_agents_answer() {
        let found = host_id("h2");
        let error = read_agent_availability(
            &agent_id("a1"),
            &agent(None),
            host_read(Ok(Some(host(None)))),
            attachment_read(Ok(attachment("h2", true))),
        )
        .await
        .expect_err("another host's attachment");
        assert_eq!(
            expect_mismatch(error),
            AvailabilityFactsMismatch::Host {
                expected: host_id("h1"),
                found,
            }
        );
    }
}
