//! Canonical internal-agent delivery-target refusal wire.
//!
//! Every consumer of the shared target resolver must emit the same status, stable
//! code, and operator-facing message. Keeping the descriptor here prevents send,
//! task-create, and schedule-create from inventing route-local `error = code`
//! responses for the same authority verdict.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TargetRefusalWire {
    Malformed,
    SelfPairNotAddressable,
    Unresolved,
    DirectMessageScope,
    ThreadNotInTarget,
    ThreadSuffixUnsupported,
    SlotOutOfScope,
}

impl TargetRefusalWire {
    fn descriptor(self) -> (StatusCode, &'static str, &'static str) {
        match self {
            Self::Malformed => (
                StatusCode::BAD_REQUEST,
                "target_malformed",
                "target is not an address",
            ),
            Self::SelfPairNotAddressable => (
                StatusCode::BAD_REQUEST,
                "self_pair_not_addressable",
                "a direct message needs another participant",
            ),
            Self::DirectMessageScope => (
                StatusCode::FORBIDDEN,
                "direct_message_scope_forbidden",
                "Conversation-scoped agents do not support DMs. Use a shared channel.",
            ),
            Self::Unresolved => (
                StatusCode::NOT_FOUND,
                "target_unresolved",
                "target names no stream you can use",
            ),
            Self::ThreadNotInTarget => (
                StatusCode::NOT_FOUND,
                "thread_not_in_target",
                "target names no reply cluster of that conversation",
            ),
            Self::ThreadSuffixUnsupported => (
                StatusCode::BAD_REQUEST,
                "conversation_target_suffix",
                "this operation addresses a conversation, not a reply cluster",
            ),
            Self::SlotOutOfScope => (
                StatusCode::FORBIDDEN,
                "slot_out_of_scope",
                "this operation acts only in the conversation your session is anchored to",
            ),
        }
    }

    pub(crate) fn into_response(self) -> Response {
        let (status, code, error) = self.descriptor();
        (status, Json(TargetRefusalBody { error, code })).into_response()
    }
}

#[derive(Serialize)]
struct TargetRefusalBody {
    error: &'static str,
    code: &'static str,
}
