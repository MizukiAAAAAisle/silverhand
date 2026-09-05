//! The narrow stored facts one internal agent-profile read projects, and the
//! source-binding that turns a fact into one bound to the coordinate a caller
//! actually named.
//!
//! The internal profile routes (`GET /internal/agents/{aid}/profile` and the
//! peer read) return only `{ id, name, display_name, description, avatar_url }`.
//! Unlike [`crate::identity_access::agent_detail_read`], that face needs NO host `LEFT JOIN` and
//! NO viewer ACL: an internal route is self-pinned (or, for a peer, gated by
//! workspace membership in the route's own gate), never judged against the
//! creator / direct-pair / workspace-member arms the detail read carries.
//!
//! So this module states ONLY the missing lookup capability — read one agent's
//! narrow profile columns by id or by handle — and returns a minimal fact. It
//! deliberately does not reuse the wider
//! [`crate::identity_access::agent_detail_read::AgentDetailProjection`] nor reproduce the detail
//! ACL, so it cannot pull the visibility gate of a viewer-scoped read into a
//! route that is capability-gated instead.
//!
//! ## `id`/`name` are witnesses, not sealed facts — the gate is orchestration
//!
//! [`AgentProfileFact`]'s fields are public and any [`AgentProfileReadModel`]
//! double can construct one, so a fact carrying `id == aid` proves nothing on
//! its own: it is a source WITNESS, not a type-sealed guarantee. The real
//! anti-cross-wire guard is [`read_self_profile`] (and, for the peer flow,
//! `crate::identity_access::agent_peer_profile::resolve_peer_target`): they read, then BIND the returned
//! row's witness to the requested coordinate, and a mismatch is a safe `500`
//! that short-circuits before any membership / capability / projection runs.

use std::future::Future;

use thiserror::Error;

use crate::{
    conversation_messaging::messaging::AvatarRevision, foundation::identity::AgentId,
    foundation::persistence::PersistenceFailure,
};

/// The narrow profile face of one agent row.
///
/// `id` and `name` are the row's own committed values, carried so an
/// orchestration can BIND them to the coordinate the caller named (see
/// [`read_self_profile`]). They are witnesses only — a reader double can put any
/// value here, which is exactly why the binding, not the field, is the guard.
///
/// The avatar is a folded [`AvatarRevision`], never a storage locator: the row's
/// non-empty pointer + `updated_at` collapse to `Some(revision)` (`None` for an
/// empty/absent pointer), which is the entire input the canonical `avatar_url`
/// derivation needs — presence and cache-buster. The storage key never crosses
/// this boundary; only a route that actually reads the blob consumes a typed
/// blob ref. There is no second avatar-URL rule here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentProfileFact {
    pub id: AgentId,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub avatar: Option<AvatarRevision>,
}

/// Reads the narrow profile facts for one agent, by id or by handle.
///
/// `None` is the row being absent — a fact the caller renders as a `404`, never a
/// failed read. This is the whole contract: no ACL, no host facts, no refusal
/// ordering, and — deliberately — no binding. The lookup key is a HINT the
/// adapter answers; verifying the answer names the requested subject is the
/// orchestration's job, not the reader's.
pub trait AgentProfileReadModel {
    fn read_agent_profile(
        &self,
        agent: &AgentId,
    ) -> impl Future<Output = Result<Option<AgentProfileFact>, PersistenceFailure>> + Send;

    /// Look up by handle (`agents.name`, matched EXACTLY — a different case is a
    /// different handle). `handle` is the already-normalized name (the wire has
    /// stripped a display `@` and surrounding whitespace); this port does no
    /// canonicalization of its own.
    fn read_agent_profile_by_handle(
        &self,
        handle: &str,
    ) -> impl Future<Output = Result<Option<AgentProfileFact>, PersistenceFailure>> + Send;
}

/// The reader returned a row that does not name the coordinate the caller asked
/// for. This is NEVER a product-visible refusal — it is a broken read contract
/// (a buggy or dishonest adapter), surfaced as a safe `500`, and it MUST
/// short-circuit before any downstream membership / capability / projection.
#[derive(Clone, Debug, Eq, PartialEq, Error)]
pub enum ProfileSourceViolation {
    #[error("agent-profile read returned id {returned:?} for requested id {requested:?}")]
    Id { requested: String, returned: String },
    #[error("agent-profile read returned name {returned:?} for requested handle {requested:?}")]
    Handle { requested: String, returned: String },
}

/// A profile read that could not be completed. Both arms are a safe `500`: a
/// persistence fault is a driver/row problem, a [`ProfileSourceViolation`] is a
/// broken read contract. Neither is a product `4xx` — an absent row is
/// `Ok(None)`, the caller's `404`.
#[derive(Debug)]
pub enum ProfileReadFault {
    Persistence(PersistenceFailure),
    Source(ProfileSourceViolation),
}

impl From<PersistenceFailure> for ProfileReadFault {
    fn from(failure: PersistenceFailure) -> Self {
        Self::Persistence(failure)
    }
}

impl From<ProfileSourceViolation> for ProfileReadFault {
    fn from(violation: ProfileSourceViolation) -> Self {
        Self::Source(violation)
    }
}

/// Bind a fact's `id` witness to the requested id, consuming the fact so a caller
/// cannot accidentally go on using an unbound one. A mismatch is the
/// [`ProfileSourceViolation`] the orchestration surfaces as a safe `500`.
fn bind_to_id(
    requested: &AgentId,
    fact: AgentProfileFact,
) -> Result<AgentProfileFact, ProfileSourceViolation> {
    if &fact.id == requested {
        Ok(fact)
    } else {
        Err(ProfileSourceViolation::Id {
            requested: requested.as_str().to_string(),
            returned: fact.id.as_str().to_string(),
        })
    }
}

/// Bind a fact's `name` witness to the requested (already-normalized) handle.
/// The peer flow uses this so the row the adapter returned is verified to be the
/// handle that was asked for, not merely whatever `getByName` happened to hand
/// back.
pub(crate) fn bind_to_handle(
    handle: &str,
    fact: AgentProfileFact,
) -> Result<AgentProfileFact, ProfileSourceViolation> {
    if fact.name == handle {
        Ok(fact)
    } else {
        Err(ProfileSourceViolation::Handle {
            requested: handle.to_string(),
            returned: fact.name.clone(),
        })
    }
}

/// The self `GET profile` read step: read by id, then bind the returned row to
/// the requested `aid`. `Ok(None)` is an absent agent (the route's `404`); a
/// bound fact is the ONLY `Ok(Some(_))` outcome, so a reader that returns a
/// different row's id is a safe `500`, never a profile served for the wrong
/// agent. Everything downstream (the DTO projection) consumes the bound fact, so
/// the binding structurally gates it.
pub async fn read_self_profile<R>(
    reader: &R,
    requested: &AgentId,
) -> Result<Option<AgentProfileFact>, ProfileReadFault>
where
    R: AgentProfileReadModel + ?Sized,
{
    match reader.read_agent_profile(requested).await? {
        Some(fact) => Ok(Some(bind_to_id(requested, fact)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A faithful reader — returns the row stored under a key, id and name intact.
    #[derive(Default)]
    struct FakeProfiles {
        rows: HashMap<String, AgentProfileFact>,
    }

    impl AgentProfileReadModel for FakeProfiles {
        async fn read_agent_profile(
            &self,
            agent: &AgentId,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(self.rows.get(agent.as_str()).cloned())
        }

        async fn read_agent_profile_by_handle(
            &self,
            handle: &str,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(self.rows.values().find(|fact| fact.name == handle).cloned())
        }
    }

    /// A LIAR — every read hands back a fixed row whose id/name are NOT the
    /// requested coordinate. It exists to prove the binding, not the query shape,
    /// is what rejects a wrong row.
    struct LiarReader {
        row: AgentProfileFact,
    }

    impl AgentProfileReadModel for LiarReader {
        async fn read_agent_profile(
            &self,
            _agent: &AgentId,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(Some(self.row.clone()))
        }

        async fn read_agent_profile_by_handle(
            &self,
            _handle: &str,
        ) -> Result<Option<AgentProfileFact>, PersistenceFailure> {
            Ok(Some(self.row.clone()))
        }
    }

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn fact(id: &str, name: &str) -> AgentProfileFact {
        AgentProfileFact {
            id: agent(id),
            name: name.to_string(),
            display_name: name.to_string(),
            description: None,
            avatar: Some(AvatarRevision::at(10)),
        }
    }

    #[tokio::test]
    async fn a_present_row_binds_and_a_missing_row_is_none() {
        let mut profiles = FakeProfiles::default();
        profiles
            .rows
            .insert("a1".to_string(), fact("a1", "agent-one"));

        let bound = read_self_profile(&profiles, &agent("a1"))
            .await
            .expect("honest read succeeds");
        assert_eq!(bound, Some(fact("a1", "agent-one")));

        let absent = read_self_profile(&profiles, &agent("ghost"))
            .await
            .expect("absent read is not a fault");
        assert_eq!(absent, None);
    }

    /// Liar-reader test #1 (by-id): a reader that returns a DIFFERENT agent's row
    /// makes the self read a safe `500`, never a profile served for the wrong id.
    #[tokio::test]
    async fn a_by_id_liar_is_a_source_violation_not_a_wrong_profile() {
        let liar = LiarReader {
            row: fact("someone-else", "other"),
        };
        let outcome = read_self_profile(&liar, &agent("a1")).await;
        match outcome {
            Err(ProfileReadFault::Source(ProfileSourceViolation::Id {
                requested,
                returned,
            })) => {
                assert_eq!(requested, "a1");
                assert_eq!(returned, "someone-else");
            }
            other => panic!("expected an id source violation, got {other:?}"),
        }
    }
}
