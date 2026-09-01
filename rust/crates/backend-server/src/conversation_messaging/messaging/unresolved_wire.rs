//! The sender-only diagnostic, projected once for every surface that carries it.
//!
//! THE TWO SUCCESS CONTRACTS ARE DIFFERENT SHAPES AND THIS MEMBER IS NOT. A person's
//! acknowledgement and an agent's send output are two separately published contracts —
//! see [`super::ack`] and [`super::agent_output`] — but "which of my references reached
//! nobody" is ONE question, and the reference implementation declares one schema that
//! both surfaces reuse. Two copies here would let one door drop the field on an empty
//! answer while the other sent `[]`, or spell a kind differently, and each of those is a
//! silent contract break for a real client.
//!
//! IT ALSO OWNS THE EMPTINESS RULE. The outcome's empty vector is a TOTAL answer —
//! "every reference this body carried named somebody" — and turning that into silence is
//! a wire decision, not a domain one. Because this is the one place that decides it, the
//! operator report in [`super::execute`] asks the same question through the same door:
//! "is there something to say" has one answer per send.

use serde_json::{Value, json};
use silverhand_backend_core::conversation_messaging::messaging::{
    MessageReference, PrincipalKind, SendMessageOutcome,
};

/// The member's name on both success contracts.
pub(crate) const UNRESOLVED_REFERENCES: &str = "unresolved_references";

/// The references that reached nobody, or `None` when every one of them landed.
///
/// `None` means OMIT the member. A client reads presence as "you have something to fix",
/// so an empty array on every ordinary send would be noise on the one surface a sender
/// reads after each of its own messages.
pub(crate) fn unresolved_member(outcome: &SendMessageOutcome) -> Option<Value> {
    let unresolved = outcome.unresolved_references();
    if unresolved.is_empty() {
        return None;
    }
    Some(Value::Array(unresolved.iter().map(reference_dto).collect()))
}

/// A reference that reached nobody. Its own two words: the reference vocabulary says
/// `human` where the author DTO says `user`, and collapsing the two would rename a
/// published contract.
///
/// It carries no REASON, and cannot: a reference is a kind and a handle, so unknown and
/// exists-but-unreachable have nothing to be told apart by here.
fn reference_dto(reference: &MessageReference) -> Value {
    let kind = match reference.kind() {
        PrincipalKind::Agent => "agent",
        PrincipalKind::Human => "human",
    };
    json!({ "kind": kind, "handle": reference.handle().as_str() })
}
