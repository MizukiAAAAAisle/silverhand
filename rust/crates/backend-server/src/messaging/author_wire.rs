//! The author a message shows, projected once for every surface that shows one.
//!
//! ONE IMPLEMENTATION, three uses: the message's own author, a thread root's author, and each
//! replier in a cluster's entry. Three copies would give the rule "a deleted author has no
//! avatar" three places to drift apart, and only one of them would be the one a reader hits.
//!
//! FOUR ARMS, matching the contract's discriminated union rather than one wide object with
//! nullable fields. The wide shape can express `status: "deleted"` beside a non-null avatar,
//! which the contract does not admit; a match on the domain's own four states cannot.
//!
//! It does NOT re-decide storage questions. Whether an avatar exists was settled upstream —
//! core hands over `Option<AvatarRevision>`, having already folded in the fact that an empty
//! storage key was never an avatar — so this layer only turns a revision into a URL.

use serde_json::{Value, json};
use silverhand_backend_core::messaging::{
    ActiveAuthor, AvatarRevision, MessageAuthor, PrincipalKind,
};

/// The wire's word for each principal kind. `human` is `user` here: the DTO has said `user`
/// since before the domain settled on `human`, and a client's contract is not ours to rename.
fn kind_word(kind: PrincipalKind) -> &'static str {
    match kind {
        PrincipalKind::Agent => "agent",
        PrincipalKind::Human => "user",
    }
}

/// The avatar route for a principal, which is per KIND. Choosing the wrong one is invisible to
/// every type here, so it is part of what the projection gate asserts.
pub(crate) fn principal_avatar_url(
    kind: PrincipalKind,
    id: &str,
    revision: Option<AvatarRevision>,
) -> Option<String> {
    match revision {
        None => None,
        Some(revision) => {
            let collection = match kind {
                PrincipalKind::Agent => "agents",
                PrincipalKind::Human => "users",
            };
            Some(format!(
                "/api/{collection}/{id}/avatar?v={}",
                revision.cache_buster()
            ))
        }
    }
}

/// Projects one author onto the wire.
pub(crate) fn author_dto(author: &MessageAuthor) -> Value {
    match author {
        MessageAuthor::Active(ActiveAuthor::Agent(agent)) => json!({
            "status": "active",
            "kind": "agent",
            "id": agent.id().as_str(),
            "name": agent.name(),
            "display_name": agent.display_name(),
            "avatar_url": principal_avatar_url(PrincipalKind::Agent, agent.id().as_str(), agent.avatar()),
            // Present because an agent always has one — the domain's constructor requires it, so
            // this arm cannot be reached without a runtime to report.
            "runtime": agent.runtime().as_str(),
        }),
        MessageAuthor::Active(ActiveAuthor::Human(human)) => json!({
            "status": "active",
            "kind": "user",
            "id": human.id().as_str(),
            "name": human.name(),
            "display_name": human.display_name(),
            "avatar_url": principal_avatar_url(PrincipalKind::Human, human.id().as_str(), human.avatar()),
            // PRESENT AND NULL, never omitted. A person has no runtime, and the contract pins the
            // member rather than dropping it so a reader never has to tell "no runtime" from "this
            // payload forgot to say".
            "runtime": Value::Null,
        }),
        MessageAuthor::Deleted(deleted) => json!({
            "status": "deleted",
            "kind": kind_word(deleted.identity().kind()),
            "id": deleted.identity().as_str(),
            "name": deleted.name(),
            "display_name": deleted.display_name(),
            // No avatar bytes are snapshotted, so there is nothing to serve after the principal is
            // gone. The member is still emitted: its absence would read as an oversight.
            "avatar_url": Value::Null,
        }),
        MessageAuthor::Unresolved(unresolved) => json!({
            "status": "unresolved",
            "kind": kind_word(unresolved.kind()),
            // Nothing names this author: the kind is all that survived.
            "id": Value::Null,
            "name": Value::Null,
            "display_name": Value::Null,
            "avatar_url": Value::Null,
        }),
    }
}

#[cfg(test)]
mod tests {
    use silverhand_backend_core::{
        foundation::identity::{AgentId, UserId},
        identity_access::agents::runtime::RuntimeKind,
        messaging::{AvatarRevision, MessageAuthor, PrincipalIdentity},
    };

    use super::*;

    /// EVERY ARM, AS WHOLE JSON. The domain already makes the illegal combinations
    /// unconstructible — a deleted author cannot carry an avatar, an active agent cannot lack a
    /// runtime — so what these cells are for is the OTHER obligation: whether this projector
    /// emits every field the arm owes. A projector that forgot `avatar_url: null`, dropped
    /// `runtime`, or attached `runtime` to a deleted author would leave the domain's types
    /// perfectly happy (@Cindy).
    ///
    /// Whole-document equality rather than field probes, so the key SET is closed: a field
    /// nobody asserts is a field that can appear or vanish unnoticed.
    #[test]
    fn each_arm_emits_every_field_it_owes() {
        let with_avatar = MessageAuthor::active_agent(
            AgentId::parse("agent-1").unwrap(),
            "Alice".to_owned(),
            "Alice A".to_owned(),
            Some(AvatarRevision::at(1_700)),
            RuntimeKind::Qoder,
        );
        assert_eq!(
            author_dto(&with_avatar),
            json!({
                "status": "active",
                "kind": "agent",
                "id": "agent-1",
                "name": "Alice",
                "display_name": "Alice A",
                // The AGENT route, and the revision is the whole cache key.
                "avatar_url": "/api/agents/agent-1/avatar?v=1700",
                "runtime": "qoder",
            })
        );

        let without_avatar = MessageAuthor::active_agent(
            AgentId::parse("agent-1").unwrap(),
            "Alice".to_owned(),
            "Alice A".to_owned(),
            None,
            RuntimeKind::Claude,
        );
        assert_eq!(
            author_dto(&without_avatar)["avatar_url"],
            Value::Null,
            "an agent with no avatar still reports the member"
        );
        assert_eq!(author_dto(&without_avatar)["runtime"], "claude");

        let human = MessageAuthor::active_human(
            UserId::parse("user-1").unwrap(),
            "shiki".to_owned(),
            "Shiki".to_owned(),
            Some(AvatarRevision::at(42)),
        );
        assert_eq!(
            author_dto(&human),
            json!({
                "status": "active",
                // `user` on this surface, and the USER route: picking the agent path here would
                // serve someone else's avatar and no type would object.
                "kind": "user",
                "id": "user-1",
                "name": "shiki",
                "display_name": "Shiki",
                "avatar_url": "/api/users/user-1/avatar?v=42",
                // PRESENT AND NULL. A person has no runtime, and omitting the member would make a
                // reader guess whether the payload forgot.
                "runtime": Value::Null,
            })
        );

        let deleted = MessageAuthor::deleted(
            PrincipalIdentity::Agent(AgentId::parse("agent-9").unwrap()),
            "Ghost".to_owned(),
            "Ghost G".to_owned(),
        );
        assert_eq!(
            author_dto(&deleted),
            json!({
                "status": "deleted",
                "kind": "agent",
                "id": "agent-9",
                "name": "Ghost",
                "display_name": "Ghost G",
                // Emitted, and null: no avatar bytes were ever snapshotted.
                "avatar_url": Value::Null,
            })
        );
        // …and `runtime` is ABSENT here, not null. Asserted through the closed key set above,
        // which is why that comparison is a whole document.
        assert!(author_dto(&deleted).get("runtime").is_none());

        let unresolved = MessageAuthor::unresolved(PrincipalKind::Human);
        assert_eq!(
            author_dto(&unresolved),
            json!({
                "status": "unresolved",
                "kind": "user",
                "id": Value::Null,
                "name": Value::Null,
                "display_name": Value::Null,
                "avatar_url": Value::Null,
            })
        );
        assert!(author_dto(&unresolved).get("runtime").is_none());
    }

    /// The runtime's spelling comes from the domain's own vocabulary, so a new runtime cannot
    /// arrive on the wire under a name this file invented.
    #[test]
    fn the_runtime_word_is_the_domains_own() {
        for runtime in RuntimeKind::ALL {
            let author = MessageAuthor::active_agent(
                AgentId::parse("agent-1").unwrap(),
                "a".to_owned(),
                "A".to_owned(),
                None,
                runtime,
            );
            assert_eq!(author_dto(&author)["runtime"], runtime.as_str());
        }
    }
}
