//! Who a message reports as its author, as one shared value for every reader.
//!
//! A message's author is not a row you can read once and copy: the same message
//! reports a *live* author while the principal exists (a rename or a new avatar
//! shows through), a *deleted* author from an immutable send-time snapshot once the
//! principal is gone, and an *unresolved* author when neither the live row nor a
//! snapshot can name anyone. Those are three different facts, so they are three
//! arms of one type rather than one struct with nullable fields that a reader has
//! to reassemble the meaning of.
//!
//! This module owns the *value* and its invariants — an active agent always has a
//! runtime, a deleted author always names a typed principal, an unresolved author
//! has no identity at all. It does NOT own the *discrimination*: which arm a stored
//! row projects to is a question about how one schema encodes author state, so it
//! belongs with the adapter that reads that schema, not on this domain boundary.
//!
//! A value is assembled only through the constructors below — the trust seam. They
//! are public across the crate boundary (the SQLite adapter is the intended
//! caller), so what they guarantee is well-formedness, not provenance: an active
//! agent has a runtime, a deleted author a typed identity. What the private fields
//! and absent setters guarantee mechanically is narrower and real — a value that
//! has been returned cannot afterwards be altered or have a field forged onto it.

use super::{AgentId, PrincipalKind, UserId};
use crate::identity_access::agents::runtime::RuntimeKind;

/// A principal named together with the identity that proves which one. Binding the
/// kind to the id in one type is what makes an agent-kind value carrying a user id
/// (or the reverse) unrepresentable rather than a combination a reader has to
/// remember to reject.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum PrincipalIdentity {
    Agent(AgentId),
    Human(UserId),
}

impl PrincipalIdentity {
    pub fn kind(&self) -> PrincipalKind {
        match self {
            PrincipalIdentity::Agent(_) => PrincipalKind::Agent,
            PrincipalIdentity::Human(_) => PrincipalKind::Human,
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            PrincipalIdentity::Agent(id) => id.as_str(),
            PrincipalIdentity::Human(id) => id.as_str(),
        }
    }
}

/// That a principal currently has an avatar, and the revision the wire uses to bust
/// its cache. It carries the row's `updated_at`, never the storage key or a URL:
/// the relative path and the final `avatar_url` string are wire vocabulary that
/// this boundary does not hold. Absent (`Option::None` at the use site) means "no
/// avatar", which the adapter decides from the storage key, not this type.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct AvatarRevision(i64);

impl AvatarRevision {
    /// The row-level `updated_at` the wire appends as a cache-buster. Row-level, so
    /// a rename over-busts the avatar cache — that is the existing product rule and
    /// is safe: it never *under*-busts, and it needs no avatar-specific column.
    pub fn at(updated_at_ms: i64) -> Self {
        Self(updated_at_ms)
    }

    pub fn cache_buster(&self) -> i64 {
        self.0
    }
}

/// An active agent: the live row answered, so name/display/avatar/runtime are the
/// current values, not the send-time snapshot. Private fields with a single
/// constructor seam, so the runtime invariant (an active agent always has one)
/// cannot be bypassed by assembling the value by hand.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveAgent {
    id: AgentId,
    name: String,
    display_name: String,
    avatar: Option<AvatarRevision>,
    runtime: RuntimeKind,
}

impl ActiveAgent {
    pub fn id(&self) -> &AgentId {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn avatar(&self) -> Option<AvatarRevision> {
        self.avatar
    }

    /// Present on the agent arm alone. A human never carries one, which is why
    /// runtime lives here rather than on a shared active shape.
    pub fn runtime(&self) -> RuntimeKind {
        self.runtime
    }
}

/// An active human: the same live values, and no runtime — a human has none, so the
/// field does not exist rather than being a null the wire has to remember to emit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveHuman {
    id: UserId,
    name: String,
    display_name: String,
    avatar: Option<AvatarRevision>,
}

impl ActiveHuman {
    pub fn id(&self) -> &UserId {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn avatar(&self) -> Option<AvatarRevision> {
        self.avatar
    }
}

/// An active author, split by kind so the runtime an agent carries and a human's
/// lack of one are two shapes rather than one shape with a nullable field.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActiveAuthor {
    Agent(ActiveAgent),
    Human(ActiveHuman),
}

/// A deleted author, read from the immutable send-time snapshot after the principal
/// is gone. The identity is typed, so a deleted agent cannot carry a user id; there
/// is no avatar or runtime, because both are live values the snapshot never held.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeletedAuthor {
    identity: PrincipalIdentity,
    name: String,
    display_name: String,
}

impl DeletedAuthor {
    pub fn identity(&self) -> &PrincipalIdentity {
        &self.identity
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

/// An author that can be named by nothing: the live row is gone and no snapshot was
/// ever recorded. It carries only its kind — deliberately no id and no name, so two
/// unresolved authors are not one identity. It does not implement `Hash` and offers
/// no identity accessor; the only aggregation key is
/// [`MessageAuthor::stable_identity`], which answers `None` here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnresolvedAuthor {
    kind: PrincipalKind,
}

impl UnresolvedAuthor {
    pub fn kind(&self) -> PrincipalKind {
        self.kind
    }
}

/// The author a message reports, as one value shared by every reader — the created
/// message and, later, the reply cluster's list entry. `system` authorship is not
/// an arm here: it projects to the outer `Option::None` at the use site, so there
/// is never a synthetic system author.
///
/// The arms are public to read (a consumer matches to learn active/deleted/
/// unresolved and project accordingly), but their payloads are only constructible
/// through the seam constructors below — a value that exists is well-formed by
/// construction:
///
/// ```compile_fail
/// use silverhand_backend_core::{identity_access::agents::runtime::RuntimeKind, conversation_messaging::messaging::ActiveAgent};
///
/// // No public fields: an active agent cannot be assembled around the runtime
/// // invariant by hand.
/// let forged = ActiveAgent {
///     id: todo!(),
///     name: String::new(),
///     display_name: String::new(),
///     avatar: None,
///     runtime: RuntimeKind::Claude,
/// };
/// ```
///
/// Deliberately not `Hash`: an unresolved author has no identity, so making the
/// value hashable would let two of them collapse into one key. Aggregation goes
/// through [`MessageAuthor::stable_identity`] instead.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MessageAuthor {
    Active(ActiveAuthor),
    Deleted(DeletedAuthor),
    Unresolved(UnresolvedAuthor),
}

impl MessageAuthor {
    /// Build an active agent. The trust seam: the runtime is required, so this
    /// value can never exist without one.
    pub fn active_agent(
        id: AgentId,
        name: String,
        display_name: String,
        avatar: Option<AvatarRevision>,
        runtime: RuntimeKind,
    ) -> Self {
        MessageAuthor::Active(ActiveAuthor::Agent(ActiveAgent {
            id,
            name,
            display_name,
            avatar,
            runtime,
        }))
    }

    /// Build an active human. No runtime is accepted, because a human has none.
    pub fn active_human(
        id: UserId,
        name: String,
        display_name: String,
        avatar: Option<AvatarRevision>,
    ) -> Self {
        MessageAuthor::Active(ActiveAuthor::Human(ActiveHuman {
            id,
            name,
            display_name,
            avatar,
        }))
    }

    /// Build a deleted author from the send-time snapshot. The identity is typed,
    /// binding the surviving kind to the surviving id.
    pub fn deleted(identity: PrincipalIdentity, name: String, display_name: String) -> Self {
        MessageAuthor::Deleted(DeletedAuthor {
            identity,
            name,
            display_name,
        })
    }

    /// Build an unresolved author. It carries only its kind: nothing names it.
    pub fn unresolved(kind: PrincipalKind) -> Self {
        MessageAuthor::Unresolved(UnresolvedAuthor { kind })
    }

    /// Which principal this author is, in every arm — the arm's own kind for active,
    /// the snapshot identity's kind for deleted, the surviving kind for unresolved.
    pub fn kind(&self) -> PrincipalKind {
        match self {
            MessageAuthor::Active(ActiveAuthor::Agent(_)) => PrincipalKind::Agent,
            MessageAuthor::Active(ActiveAuthor::Human(_)) => PrincipalKind::Human,
            MessageAuthor::Deleted(deleted) => deleted.identity.kind(),
            MessageAuthor::Unresolved(unresolved) => unresolved.kind,
        }
    }

    /// The identity this author can be aggregated by, or `None` when it has none.
    ///
    /// The single aggregation key: a consumer distinguishing repliers keys on this
    /// and skips `None`, so two unresolved authors never merge into one identity.
    /// Active and deleted answer with their typed identity; unresolved answers
    /// `None`.
    pub fn stable_identity(&self) -> Option<PrincipalIdentity> {
        match self {
            MessageAuthor::Active(ActiveAuthor::Agent(agent)) => {
                Some(PrincipalIdentity::Agent(agent.id.clone()))
            }
            MessageAuthor::Active(ActiveAuthor::Human(human)) => {
                Some(PrincipalIdentity::Human(human.id.clone()))
            }
            MessageAuthor::Deleted(deleted) => Some(deleted.identity.clone()),
            MessageAuthor::Unresolved(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_id() -> AgentId {
        AgentId::parse("agent-1").unwrap()
    }

    fn user_id() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    #[test]
    fn an_active_agent_reports_its_live_values_and_its_runtime() {
        let author = MessageAuthor::active_agent(
            agent_id(),
            "Ada".to_owned(),
            "Ada L.".to_owned(),
            Some(AvatarRevision::at(42)),
            RuntimeKind::Claude,
        );
        let MessageAuthor::Active(ActiveAuthor::Agent(agent)) = &author else {
            panic!("expected an active agent");
        };
        assert_eq!(agent.name(), "Ada");
        assert_eq!(agent.display_name(), "Ada L.");
        assert_eq!(agent.avatar().map(|a| a.cache_buster()), Some(42));
        assert_eq!(agent.runtime(), RuntimeKind::Claude);
        assert_eq!(author.kind(), PrincipalKind::Agent);
    }

    #[test]
    fn stable_identity_is_present_for_named_authors_and_absent_for_unresolved() {
        let agent = MessageAuthor::active_agent(
            agent_id(),
            "Ada".to_owned(),
            "Ada".to_owned(),
            None,
            RuntimeKind::Codex,
        );
        let human = MessageAuthor::active_human(user_id(), "Bo".to_owned(), "Bo".to_owned(), None);
        let deleted = MessageAuthor::deleted(
            PrincipalIdentity::Agent(agent_id()),
            "Ada".to_owned(),
            "Ada".to_owned(),
        );

        assert_eq!(
            agent.stable_identity(),
            Some(PrincipalIdentity::Agent(agent_id()))
        );
        assert_eq!(
            human.stable_identity(),
            Some(PrincipalIdentity::Human(user_id()))
        );
        assert_eq!(
            deleted.stable_identity(),
            Some(PrincipalIdentity::Agent(agent_id()))
        );
        for kind in [PrincipalKind::Agent, PrincipalKind::Human] {
            assert_eq!(MessageAuthor::unresolved(kind).stable_identity(), None);
        }
    }
}
