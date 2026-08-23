//! Who a message addressed, and the grammar that decides it.
//!
//! Two halves, and only one of them lives here. WHERE a body may address from is
//! Markdown structure, supplied through [`ReferencePositions`]; WHO it addresses is
//! read from the bytes at those positions against the destination grammar below. A
//! supplied position rule can narrow or widen the positions and can never introduce
//! a name the body does not contain.

use std::{collections::HashSet, ops::Range};

use super::MessageContent;

/// Which namespace names a principal. One vocabulary, because "which table
/// answers for this name" is the same question whether it is asked of a direct
/// pair's endpoint or of something a message addressed.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum PrincipalKind {
    Human,
    Agent,
}

/// Something a message addressed. Its fields are sealed because the value is
/// EVIDENCE about a body: it is obtainable only by deriving it from the content
/// that addressed them, so no caller can hand the write unit a name the message
/// never wrote. The handle is still resolved inside the write unit — a name is a
/// coordinate, and which principal it denotes can change before the commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageReference {
    kind: PrincipalKind,
    handle: ParticipantHandle,
}

impl MessageReference {
    pub fn kind(&self) -> PrincipalKind {
        self.kind
    }

    pub fn handle(&self) -> &ParticipantHandle {
        &self.handle
    }
}

/// The destination form a reference takes in a body: `silverhand://agent/Alice`.
const REFERENCE_PREFIX: &str = "silverhand://";
/// A handle is at most this long wherever it is stored, so a longer one cannot be
/// a name this system holds.
const HANDLE_MAX_LENGTH: usize = 64;

/// A participant name, in the grammar every stored name obeys.
///
/// It exists as a type because a handle is interpolated into server-authored prose
/// that addresses people: raw text there could close a destination, open another
/// path segment, or start a new line. Anything outside the grammar is not a name
/// this system holds, so it is refused rather than escaped.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ParticipantHandle(String);

impl ParticipantHandle {
    pub fn parse(raw: impl Into<String>) -> Result<Self, InvalidHandle> {
        let raw = raw.into();
        if raw.is_empty() || raw.len() > HANDLE_MAX_LENGTH {
            return Err(InvalidHandle);
        }
        let mut characters = raw.chars();
        let first = characters.next().ok_or(InvalidHandle)?;
        if !first.is_ascii_alphabetic() {
            return Err(InvalidHandle);
        }
        if !characters.all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        }) {
            return Err(InvalidHandle);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("handle is outside the grammar every stored name obeys")]
pub struct InvalidHandle;

/// Reads one link destination. Nothing else is a reference: not a different
/// scheme, not an extra path segment, not a query, not a handle outside the stored
/// name grammar. Fail-closed, because the alternative is addressing someone the
/// author did not name.
fn parse_reference_destination(destination: &str) -> Option<MessageReference> {
    let rest = destination.strip_prefix(REFERENCE_PREFIX)?;
    let (kind, handle) = rest.split_once('/')?;
    let kind = match kind {
        "agent" => PrincipalKind::Agent,
        "human" => PrincipalKind::Human,
        _ => return None,
    };
    Some(MessageReference {
        kind,
        handle: ParticipantHandle::parse(handle).ok()?,
    })
}

/// The canonical prose form of a reference: `<silverhand://agent/Alice>`.
///
/// The brackets are what make a destination a destination — a bare one is plain
/// text — so every producer of server-authored prose writes this form. Not public:
/// its only consumers are the projections in this module, and a handle it can be
/// given has already been shown to be a name.
pub(super) fn format_reference_token(kind: PrincipalKind, handle: &ParticipantHandle) -> String {
    let kind = match kind {
        PrincipalKind::Agent => "agent",
        PrincipalKind::Human => "human",
    };
    format!("<{REFERENCE_PREFIX}{kind}/{}>", handle.as_str())
}

/// Which positions in a body can address anyone.
///
/// The rule is Markdown structure — an autolink in prose, never quoted syntax and
/// never someone else's quoted words — so it is supplied rather than decided here.
/// What is NOT supplied is identity: the derivation reads the bytes at the spans
/// this returns, so a position rule that lies can narrow or widen WHERE a body
/// addresses from, and can never introduce a name the body does not contain.
pub trait ReferencePositions {
    /// Byte ranges of the candidate autolinks, in source order, brackets included.
    fn autolink_spans(&self, content: &MessageContent) -> Vec<Range<usize>>;
}

/// Everyone one message addressed: deduplicated, in first-occurrence order.
///
/// There is no way to build one except from a body — not even an empty one. A
/// second source of this value, however harmless it looks, would be a way to
/// answer "who does this message address" without reading the message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AddressedPrincipals(Vec<MessageReference>);

impl AddressedPrincipals {
    pub(super) fn derive(content: &MessageContent, positions: &impl ReferencePositions) -> Self {
        let body = content.as_str();
        let mut addressed = Vec::new();
        let mut seen = HashSet::new();

        // The position rule answers WHERE, as a set. Order is part of the answer to
        // WHO — it decides which occurrence of a repeated name is the first — so it
        // is established here from the body's own offsets rather than inherited
        // from whatever order a traversal happened to produce.
        let mut spans = positions.autolink_spans(content);
        spans.sort_by_key(|span| (span.start, span.end));

        for span in spans {
            // A span that is not a whole autolink of THIS body addresses nobody.
            let Some(candidate) = body.get(span) else {
                continue;
            };
            let Some(destination) = candidate
                .strip_prefix('<')
                .and_then(|inner| inner.strip_suffix('>'))
            else {
                continue;
            };
            let Some(reference) = parse_reference_destination(destination) else {
                continue;
            };
            if seen.insert((reference.kind, reference.handle.clone())) {
                addressed.push(reference);
            }
        }
        Self(addressed)
    }

    pub fn iter(&self) -> impl Iterator<Item = &MessageReference> {
        self.0.iter()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::{
        AgentId, ConversationId, SendActor, SendDestination, SendMessage, SendMessageDraft, UserId,
    };
    use crate::persistence::PersistenceFailure;

    /// An authority that grants every agent the body addressed, so tests that are
    /// not about authorization do not have to model it.
    struct GrantsEveryAddressedAgent;

    impl crate::messaging::DirectLineAuthority for GrantsEveryAddressedAgent {
        fn direct_lines(
            &self,
            _author: &UserId,
            addressed: &AddressedPrincipals,
        ) -> Result<Vec<AgentId>, PersistenceFailure> {
            Ok(addressed
                .iter()
                .filter(|reference| reference.kind() == PrincipalKind::Agent)
                .map(|reference| AgentId::parse(reference.handle().as_str()).unwrap())
                .collect())
        }
    }

    /// A stand-in position rule: every `<…>` run, wherever it sits. The product
    /// rule is Markdown structure — an autolink in prose, never quoted syntax —
    /// and lives outside this crate; this one exists to exercise the half that IS
    /// decided here, which is identity.
    struct EveryBracketedRun;

    impl ReferencePositions for EveryBracketedRun {
        fn autolink_spans(&self, content: &MessageContent) -> Vec<Range<usize>> {
            let body = content.as_str();
            let mut spans = Vec::new();
            let mut cursor = 0;
            while let Some(open) = body[cursor..].find('<') {
                let open = cursor + open;
                let Some(close) = body[open..].find('>') else {
                    break;
                };
                let close = open + close;
                spans.push(open..close + 1);
                cursor = close + 1;
            }
            spans
        }
    }

    /// A position rule that points wherever it likes, to show what a lying one can
    /// and cannot do.
    struct SpansOf(Vec<Range<usize>>);

    impl ReferencePositions for SpansOf {
        fn autolink_spans(&self, _content: &MessageContent) -> Vec<Range<usize>> {
            self.0.clone()
        }
    }

    fn conversation() -> ConversationId {
        ConversationId::parse("conv-1").unwrap()
    }

    fn draft(content: MessageContent) -> SendMessageDraft {
        SendMessageDraft {
            source_conversation: conversation(),
            target_conversation: conversation(),
            actor: SendActor::Agent(AgentId::parse("agent-1").unwrap()),
            content,
            destination: SendDestination::MainLine,
            attachment_refs: Vec::new(),
            freshness_bypass: false,
        }
    }

    /// Read through the prepared command, which is the only way to obtain a derived
    /// set: there is no second source of "who does this address".
    fn addressed_of(
        body: &str,
        positions: &impl ReferencePositions,
    ) -> Vec<(PrincipalKind, String)> {
        let content = MessageContent::parse(body).unwrap();
        SendMessage::prepare(draft(content), positions, &GrantsEveryAddressedAgent)
            .unwrap()
            .addressed()
            .iter()
            .map(|reference| (reference.kind(), reference.handle().as_str().to_owned()))
            .collect()
    }

    /// The counter-example B1 asks for: a body that addresses nobody cannot be
    /// prepared into a command that addresses someone, whatever the position rule
    /// claims — identity is read from the body's own bytes.
    #[test]
    fn a_body_that_names_nobody_addresses_nobody() {
        let body = "hello, nothing to see here";
        let every_span = (0..body.len()).map(|start| start..body.len()).collect();

        assert!(addressed_of(body, &SpansOf(every_span)).is_empty());
        assert!(addressed_of(body, &EveryBracketedRun).is_empty());
    }

    /// A span that is not a whole bracketed destination of this body addresses
    /// nobody either: the derivation checks the bytes it was pointed at.
    #[test]
    fn a_span_that_is_not_a_destination_addresses_nobody() {
        let body = "see <silverhand://agent/Alice> for details";
        let inner = body.find("silverhand").unwrap();
        let partial = std::iter::once(inner..inner + 4).collect();
        let out_of_range = std::iter::once(body.len()..body.len() + 40).collect();

        assert!(addressed_of(body, &SpansOf(partial)).is_empty());
        assert!(addressed_of(body, &SpansOf(out_of_range)).is_empty());
    }

    #[test]
    fn a_destination_is_read_as_kind_and_handle() {
        let addressed = addressed_of(
            "<silverhand://agent/Alice> and <silverhand://human/shiki>",
            &EveryBracketedRun,
        );

        assert_eq!(
            addressed,
            vec![
                (PrincipalKind::Agent, "Alice".to_owned()),
                (PrincipalKind::Human, "shiki".to_owned()),
            ]
        );
    }

    /// Deduplicated, in first-occurrence order, and the two kinds are different
    /// principals even under one name.
    #[test]
    fn repeats_collapse_and_the_first_position_decides_the_order() {
        let addressed = addressed_of(
            "<silverhand://human/shiki> <silverhand://agent/Alice> <silverhand://human/shiki> \
             <silverhand://agent/shiki>",
            &EveryBracketedRun,
        );

        assert_eq!(
            addressed,
            vec![
                (PrincipalKind::Human, "shiki".to_owned()),
                (PrincipalKind::Agent, "Alice".to_owned()),
                (PrincipalKind::Agent, "shiki".to_owned()),
            ]
        );
    }

    /// The body decides the order, not the rule that reported the positions: a rule
    /// whose traversal runs backwards still yields first-occurrence order, so a
    /// change of traversal cannot quietly reorder who a message addressed.
    #[test]
    fn the_body_decides_the_order_not_the_position_rule() {
        let body = "<silverhand://agent/Alice> then <silverhand://human/shiki> then \
                    <silverhand://agent/Alice>";
        let content = MessageContent::parse(body).unwrap();
        let mut reported = EveryBracketedRun.autolink_spans(&content);
        reported.reverse();

        assert_eq!(
            addressed_of(body, &SpansOf(reported)),
            vec![
                (PrincipalKind::Agent, "Alice".to_owned()),
                (PrincipalKind::Human, "shiki".to_owned()),
            ]
        );
    }

    /// A span that runs backwards, or that cuts a character in half, is inert: the
    /// derivation reads what is there or nothing at all.
    #[test]
    fn a_backwards_or_mid_character_span_addresses_nobody() {
        let body = "汉<silverhand://agent/Alice>";
        let mid_character = std::iter::once(1..body.len()).collect();
        let backwards = std::iter::once(body.len()..0).collect();

        assert!(addressed_of(body, &SpansOf(mid_character)).is_empty());
        assert!(addressed_of(body, &SpansOf(backwards)).is_empty());
        // The same body, read from its real positions, does address someone.
        assert_eq!(addressed_of(body, &EveryBracketedRun).len(), 1);
    }

    /// Everything that is not exactly a reference destination addresses nobody.
    #[test]
    fn a_destination_outside_the_grammar_addresses_nobody() {
        for body in [
            "<SILVERHAND://agent/Alice>",
            "<silverhand://Agent/Alice>",
            "<silverhand://agent/Alice/extra>",
            "<silverhand://agent/Alice?x=1>",
            "<silverhand://agent/>",
            "<silverhand://agent/1Alice>",
            "<silverhand://agent/Alice.Bob>",
            "<silverhand://team/Alice>",
            "<https://example.com/agent/Alice>",
        ] {
            assert!(
                addressed_of(body, &EveryBracketedRun).is_empty(),
                "{body} addressed someone"
            );
        }

        let too_long = format!("<silverhand://agent/a{}>", "b".repeat(64));
        assert!(addressed_of(&too_long, &EveryBracketedRun).is_empty());
        let longest_allowed = format!("<silverhand://agent/a{}>", "b".repeat(63));
        assert_eq!(addressed_of(&longest_allowed, &EveryBracketedRun).len(), 1);
    }
}
