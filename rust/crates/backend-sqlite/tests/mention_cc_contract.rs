//! The Rust half of the mention CC's durable-text contract.
//!
//! The artifact under `rust/test-fixtures/mention-cc/` is the contract both
//! implementations answer to: inputs and the expectation, checked in, with the
//! other side asserting the same rows against its production renderer. Nothing
//! here is a snapshot of this side's own output.
//!
//! It lives in this crate's test tree because a JSON reader does: the projection it
//! exercises is pure and belongs to `backend-core`.

use silverhand_backend_core::conversation_messaging::messaging::{
    ParticipantHandle,
    mention_cc::{MentionCopySource, mention_excerpt, render_copy_body},
};

const CONTRACT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../rust/test-fixtures/mention-cc/contract.json"
));

fn contract() -> serde_json::Value {
    serde_json::from_str(CONTRACT).expect("the shared contract must parse")
}

fn text<'a>(case: &'a serde_json::Value, field: &str) -> &'a str {
    case[field]
        .as_str()
        .unwrap_or_else(|| panic!("contract case is missing {field}: {case}"))
}

#[test]
fn the_excerpt_matches_the_shared_contract() {
    let contract = contract();
    let cases = contract["excerpt"].as_array().expect("excerpt cases");
    assert!(!cases.is_empty());

    for case in cases {
        assert_eq!(
            mention_excerpt(text(case, "input")),
            text(case, "expected"),
            "excerpt case {} disagrees with the shared contract",
            text(case, "name")
        );
    }
}

#[test]
fn the_copy_body_matches_the_shared_contract() {
    let contract = contract();
    let cases = contract["body"].as_array().expect("body cases");
    assert!(!cases.is_empty());

    for case in cases {
        let recipient = ParticipantHandle::parse(text(case, "agentHandle"))
            .expect("a contract recipient is a name");
        let rendered = render_copy_body(&MentionCopySource {
            recipient_handle: &recipient,
            source_workspace_name: text(case, "sourceWorkspaceName"),
            source_conversation_title: text(case, "sourceConversationTitle"),
            source_content: text(case, "sourceContent"),
        });

        assert_eq!(
            rendered,
            text(case, "expectedBody"),
            "body case {} disagrees with the shared contract",
            text(case, "name")
        );
    }
}

/// The SHAPE of the same claim, asked of the artifact itself: every line that names
/// anyone other than the recipient is inside the quote.
///
/// Complementary to, not a substitute for, the derivation gate — `backend-server`
/// asks the real position rule what each rendered body addresses, and the other side
/// asks its extractor. This one needs no parser, so it stays here with the renderer
/// it is about: a wrap that leaked a line out of the quote would fail here even if
/// the leaked line happened to address nobody.
#[test]
fn no_line_of_the_original_escapes_the_quote() {
    let contract = contract();

    for case in contract["body"].as_array().expect("body cases") {
        let addressed = case["expectedAddressed"]
            .as_array()
            .expect("expected addressed");
        assert_eq!(
            addressed.len(),
            1,
            "the contract expects a body to address exactly its recipient: {case}"
        );

        let body = text(case, "expectedBody");
        for line in body.lines() {
            let names_a_third_party = line.contains("silverhand://") && !line.contains("/Alice>");
            assert!(
                !names_a_third_party || line.starts_with("> "),
                "a reference escaped the quote in case {}: {line}",
                text(case, "name")
            );
        }
    }
}
