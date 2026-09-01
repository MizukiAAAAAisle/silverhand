//! The shared contracts this crate answers to.
//!
//! Each artifact is checked in beside the other implementation and consumed by both: bodies
//! and the expectation, never one side's output taken as the other's truth. What lives here is
//! the reader, because the rule these cases exercise is crate-private — a contract test is not
//! a reason to publish a module.
//!
//! Both drive the PRODUCTION derivation rather than the position rule alone:
//! `SendMessage::prepare` is the only way to obtain an addressed set, so what gets compared is
//! what a send would act on — position rule, destination grammar, deduplication and order
//! together.

use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

use silverhand_backend_core::foundation::persistence::PersistenceFailure;
use silverhand_backend_core::{
    foundation::identity::{AgentId, ConversationId, UserId},
    messaging::{
        AddressedPrincipals, DirectLineAuthority, MessageContent, PrincipalKind, SendActor,
        SendDestination, SendMessage, SendMessageDraft,
    },
};

use super::references::MarkdownReferencePositions;

const REFERENCE_POSITIONS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/shared/tests/reference-positions/contract.json"
));

const MENTION_CC: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/backend/tests/mention-cc/contract.json"
));

struct GrantsNothing;

fn ready<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut context) {
        Poll::Ready(output) => output,
        Poll::Pending => panic!("the driver-free authority unexpectedly suspended"),
    }
}

impl DirectLineAuthority for GrantsNothing {
    async fn direct_lines(
        &self,
        _author: &UserId,
        _addressed: &AddressedPrincipals,
    ) -> Result<Vec<AgentId>, PersistenceFailure> {
        Ok(Vec::new())
    }
}

/// Who this body addresses, decided the way a send decides it.
fn addressed(body: &str) -> Vec<(String, String)> {
    let conversation = ConversationId::parse("conv-1").unwrap();
    let draft = SendMessageDraft {
        source_conversation: conversation.clone(),
        target_conversation: conversation,
        actor: SendActor::User(UserId::parse("user-1").unwrap()),
        content: MessageContent::parse(body).unwrap(),
        destination: SendDestination::MainLine,
        attachment_refs: Vec::new(),
        freshness_bypass: false,
    };

    ready(SendMessage::prepare(
        draft,
        &MarkdownReferencePositions,
        &GrantsNothing,
    ))
    .expect("a body with no attachments and no grants prepares")
    .addressed()
    .iter()
    .map(|reference| {
        let kind = match reference.kind() {
            PrincipalKind::Agent => "agent",
            PrincipalKind::Human => "human",
        };
        (kind.to_owned(), reference.handle().as_str().to_owned())
    })
    .collect()
}

fn parsed(artifact: &str) -> serde_json::Value {
    serde_json::from_str(artifact).expect("the shared contract must parse")
}

/// WHERE a body may address from, over the same bodies the real TypeScript extractor answers:
/// autolink versus label link, reference link, code span, fence, indented code, blockquote
/// (including one nested in a list), duplicates in first-occurrence order, order across
/// blocks, multibyte prose, and the three byte-order-mark cases.
#[test]
fn every_body_addresses_what_the_shared_position_contract_says() {
    let contract = parsed(REFERENCE_POSITIONS);
    let cases = contract["addressed"].as_array().expect("addressed cases");
    assert!(!cases.is_empty());

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let body = case["content"].as_str().expect("case content");
        let expected = case["expected"]
            .as_array()
            .expect("case expectation")
            .iter()
            .map(|reference| {
                (
                    reference["kind"].as_str().expect("kind").to_owned(),
                    reference["handle"].as_str().expect("handle").to_owned(),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            addressed(body),
            expected,
            "case {name} disagrees with the shared contract"
        );
    }
}

/// A RENDERED MENTION COPY ADDRESSES EXACTLY ITS RECIPIENT.
///
/// The structural half of the mention CC's contract, which could not be asked until a real
/// position rule existed: the wrap names the agent it is for, and the original it quotes sits
/// inside a blockquote — so whoever that original addressed is quoted rather than addressed a
/// second time. Both the artifact's expectation and the recipient the case was built for are
/// asserted, which is what makes "exactly its recipient" a claim rather than a shape.
#[test]
fn every_rendered_copy_addresses_exactly_its_recipient() {
    let contract = parsed(MENTION_CC);
    let cases = contract["body"].as_array().expect("body cases");
    assert!(!cases.is_empty());

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let body = case["expectedBody"].as_str().expect("expected body");
        let expected = case["expectedAddressed"]
            .as_array()
            .expect("expected addressed")
            .iter()
            .map(|entry| {
                let entry = entry.as_str().expect("addressed entry");
                let (kind, handle) = entry.split_once('/').expect("kind/handle");
                (kind.to_owned(), handle.to_owned())
            })
            .collect::<Vec<_>>();
        let recipient = case["agentHandle"].as_str().expect("agent handle");

        let reported = addressed(body);
        assert_eq!(
            reported, expected,
            "case {name} disagrees with the shared contract"
        );
        assert_eq!(
            reported,
            vec![("agent".to_owned(), recipient.to_owned())],
            "case {name}"
        );
    }
}
