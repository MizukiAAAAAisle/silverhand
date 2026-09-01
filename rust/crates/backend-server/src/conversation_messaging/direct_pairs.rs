//! Authenticated cold face for the viewer's complete Direct Messages list.

use axum::{
    Json, Router,
    extract::Extension,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use serde_json::Value;
use silverhand_backend_core::{
    conversation_messaging::direct_pair_read::{
        DirectPairCounterpart, DirectPairList, DirectPairListItem, DirectPairReadModel,
    },
    conversation_messaging::messaging::{ActiveAuthor, PrincipalIdentity, PrincipalKind},
    foundation::identity::UserId,
};

use crate::{
    conversation_messaging::messaging::author_wire::principal_avatar_url, foundation::error,
};

pub const DIRECT_PAIRS_PATH: &str = "/api/direct-pairs";

pub fn router<R>(read_model: R) -> Router
where
    R: DirectPairReadModel + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(DIRECT_PAIRS_PATH, get(list::<R>))
        .with_state(read_model)
}

async fn list<R>(
    axum::extract::State(read_model): axum::extract::State<R>,
    principal: Option<Extension<UserId>>,
) -> Response
where
    R: DirectPairReadModel,
{
    let Some(Extension(viewer)) = principal else {
        tracing::error!("direct-pairs route reached without its human principal fact");
        return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
    };
    match read_model.list_direct_pairs(&viewer).await {
        Ok(fact) => Json(DirectPairListResponse::from(&fact)).into_response(),
        Err(cause) => {
            tracing::error!(
                error_chain = %error::describe(&cause),
                "direct-pairs cold read failed"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
        }
    }
}

#[derive(Serialize)]
struct DirectPairListResponse {
    direct_pairs: Vec<DirectPairListItemDto>,
}

impl From<&DirectPairList> for DirectPairListResponse {
    fn from(fact: &DirectPairList) -> Self {
        Self {
            direct_pairs: fact
                .items()
                .iter()
                .map(DirectPairListItemDto::from)
                .collect(),
        }
    }
}

#[derive(Serialize)]
struct DirectPairListItemDto {
    conversation_id: String,
    counterpart: DirectPairCounterpartDto,
    unread_count: i64,
    read_only: bool,
    created_at: i64,
}

impl From<&DirectPairListItem> for DirectPairListItemDto {
    fn from(item: &DirectPairListItem) -> Self {
        Self {
            conversation_id: item.conversation().as_str().to_owned(),
            counterpart: DirectPairCounterpartDto::from(item.counterpart()),
            unread_count: item.unread_count().get(),
            read_only: item.is_read_only(),
            created_at: item.created_at_ms(),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum DirectPairCounterpartDto {
    Active {
        kind: &'static str,
        id: String,
        name: String,
        display_name: String,
        avatar_url: Option<String>,
        runtime: Option<&'static str>,
    },
    Deleted {
        kind: &'static str,
        id: String,
    },
}

impl From<&DirectPairCounterpart> for DirectPairCounterpartDto {
    fn from(counterpart: &DirectPairCounterpart) -> Self {
        match counterpart {
            DirectPairCounterpart::Active(ActiveAuthor::Agent(agent)) => Self::Active {
                kind: "agent",
                id: agent.id().as_str().to_owned(),
                name: agent.name().to_owned(),
                display_name: agent.display_name().to_owned(),
                avatar_url: principal_avatar_url(
                    PrincipalKind::Agent,
                    agent.id().as_str(),
                    agent.avatar(),
                ),
                runtime: Some(agent.runtime().as_str()),
            },
            DirectPairCounterpart::Active(ActiveAuthor::Human(human)) => Self::Active {
                kind: "human",
                id: human.id().as_str().to_owned(),
                name: human.name().to_owned(),
                display_name: human.display_name().to_owned(),
                avatar_url: principal_avatar_url(
                    PrincipalKind::Human,
                    human.id().as_str(),
                    human.avatar(),
                ),
                runtime: None,
            },
            DirectPairCounterpart::Deleted(identity) => Self::Deleted {
                kind: principal_kind(identity),
                id: identity.as_str().to_owned(),
            },
        }
    }
}

/// The one counterpart wire authority, shared by the DM list and every other
/// surface that embeds the same value object.
pub(crate) fn counterpart_dto_value(counterpart: &DirectPairCounterpart) -> Value {
    serde_json::to_value(DirectPairCounterpartDto::from(counterpart))
        .expect("the closed counterpart DTO is always serializable")
}

fn principal_kind(identity: &PrincipalIdentity) -> &'static str {
    match identity {
        PrincipalIdentity::Agent(_) => "agent",
        PrincipalIdentity::Human(_) => "human",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use silverhand_backend_core::{
        conversation_messaging::direct_pair_read::{
            DirectPairCounterpart, DirectPairList, DirectPairListItem, DirectPairUnreadCount,
        },
        conversation_messaging::messaging::PrincipalIdentity,
        foundation::identity::{AgentId, ConversationId, UserId},
        identity_access::agents::runtime::RuntimeKind,
    };

    use super::DirectPairListResponse;

    fn item(
        conversation: &str,
        counterpart: DirectPairCounterpart,
        unread_count: i64,
        read_only: bool,
        created_at: i64,
    ) -> DirectPairListItem {
        DirectPairListItem::projected(
            ConversationId::parse(conversation).unwrap(),
            counterpart,
            DirectPairUnreadCount::try_from(unread_count).unwrap(),
            read_only,
            created_at,
        )
    }

    /// The same checked-in cases signed by Zod are serialized through the real
    /// production projector. This is a union-exhaustiveness gate, not a second test
    /// DTO: changing either deleted discriminator spelling or any arm's members makes
    /// the whole-value comparison fail.
    #[test]
    fn the_shared_fixture_covers_every_counterpart_arm_and_the_empty_wrapper() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../packages/shared/tests/fixtures/direct-pair-list.json"
        ))
        .unwrap();

        let active = DirectPairList::complete(vec![
            item(
                "pair-agent",
                DirectPairCounterpart::active_agent(
                    AgentId::parse("agent-1").unwrap(),
                    "agent".to_owned(),
                    "Agent One".to_owned(),
                    None,
                    RuntimeKind::Codex,
                ),
                1,
                false,
                100,
            ),
            item(
                "pair-human",
                DirectPairCounterpart::active_human(
                    UserId::parse("user-2").unwrap(),
                    "other".to_owned(),
                    "Other Human".to_owned(),
                    None,
                ),
                0,
                false,
                200,
            ),
        ]);
        let deleted_agent = DirectPairList::complete(vec![item(
            "pair-deleted-agent",
            DirectPairCounterpart::deleted(PrincipalIdentity::Agent(
                AgentId::parse("agent-gone").unwrap(),
            )),
            0,
            true,
            300,
        )]);
        let deleted_human = DirectPairList::complete(vec![item(
            "pair-deleted-human",
            DirectPairCounterpart::deleted(PrincipalIdentity::Human(
                UserId::parse("user-gone").unwrap(),
            )),
            4,
            true,
            400,
        )]);
        let empty = DirectPairList::complete(Vec::new());

        let actual = [active, deleted_agent, deleted_human, empty]
            .iter()
            .map(|list| serde_json::to_value(DirectPairListResponse::from(list)).unwrap())
            .collect::<Vec<_>>();
        let expected = std::iter::once(fixture["authority_case"]["response"].clone())
            .chain(
                fixture["additional_wire_cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .cloned(),
            )
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }
}
