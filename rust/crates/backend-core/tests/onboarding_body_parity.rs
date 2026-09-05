//! Rust consumer of the TS-signed workspace-onboarding body fixture.
//!
//! `packages/backend/tests/application/onboarding-body-rust-parity.test.ts` is the
//! SIGNER: it regenerates `tests/fixtures/onboarding-body.parity.json` from the
//! production `onboardingBody` and fails if the committed fixture drifts from it.
//! This test is the CONSUMER: the Rust core renderer must reproduce each committed
//! body byte-for-byte. Together they pin the two renderers to one wire: a wording,
//! spacing, reference-token, or inline-code-escaping change on either side breaks a
//! test until both agree.

use std::path::PathBuf;

use silverhand_backend_core::conversation_messaging::messaging::MessageId;
use silverhand_backend_core::conversation_messaging::messaging::ParticipantHandle;
use silverhand_backend_core::conversation_messaging::messaging::agent_onboarding::{
    OnboardingSystemMessage, WorkspaceOnboardingPeer,
};
use silverhand_backend_core::foundation::identity::ConversationId;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/onboarding-body.parity.json")
}

#[test]
fn rust_renderer_reproduces_the_ts_signed_onboarding_bodies() {
    let raw = std::fs::read_to_string(fixture_path()).expect("read onboarding-body fixture");
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(&raw).expect("parse onboarding-body fixture");
    assert_eq!(cases.len(), 3, "solo + multi-peer + backtick-workspace");
    for case in cases {
        let label = case["label"].as_str().expect("label");
        let workspace = case["workspace"].as_str().expect("workspace");
        let recipient_name = case["recipient"].as_str().expect("recipient");
        let expected_body = case["body"].as_str().expect("body");
        let recipient = ParticipantHandle::parse(recipient_name).expect("recipient handle");
        let peers: Vec<WorkspaceOnboardingPeer> = case["others"]
            .as_array()
            .expect("others array")
            .iter()
            .map(|peer| WorkspaceOnboardingPeer {
                handle: ParticipantHandle::parse(peer["handle"].as_str().expect("peer handle"))
                    .expect("peer handle parse"),
                runtime: peer["runtime"].as_str().expect("peer runtime").to_owned(),
            })
            .collect();
        let rendered = OnboardingSystemMessage::workspace_onboarding(
            ConversationId::parse("chan-1").unwrap(),
            MessageId::parse("msg-1").unwrap(),
            workspace,
            &recipient,
            &peers,
            0,
        );
        assert_eq!(
            rendered.content(),
            expected_body,
            "Rust onboarding body must byte-match the TS-signed fixture for case `{label}`"
        );
    }
}
