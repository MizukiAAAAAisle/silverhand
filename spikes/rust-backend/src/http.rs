use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{
        State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade, close_code},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use tokio::sync::broadcast;
use tower_http::trace::TraceLayer;
use tracing::info_span;

use crate::{
    application::{CreateMessage, CreateMessageError, MessageCreatedFact, MessageUnitOfWork},
    contracts::{CreateMessageRequest, CreateMessageResponse, MessageDto, ServerEvent},
};

const EVENT_BUFFER_CAPACITY: usize = 64;
const LAGGED_CLOSE_REASON: &str = "event consumer lagged; reconnect and resync";

#[derive(Clone)]
struct AppState<U> {
    create_message: CreateMessage<U>,
    events: broadcast::Sender<ServerEvent>,
}

pub fn router<U: MessageUnitOfWork>(unit_of_work: U) -> Router {
    let (events, _) = broadcast::channel(EVENT_BUFFER_CAPACITY);
    let state = Arc::new(AppState {
        create_message: CreateMessage::new(unit_of_work),
        events,
    });

    Router::new()
        .route("/healthz", get(health))
        .route(
            crate::contracts::CREATE_MESSAGE_PATH,
            post(create_message::<U>),
        )
        .route(
            crate::contracts::EVENT_WEBSOCKET_PATH,
            get(event_websocket::<U>),
        )
        .with_state(state)
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &axum::http::Request<_>| {
                info_span!(
                    "http_request",
                    method = %request.method(),
                    uri = %request.uri(),
                )
            }),
        )
}

async fn health() -> &'static str {
    "ok"
}

async fn create_message<U: MessageUnitOfWork>(
    State(state): State<Arc<AppState<U>>>,
    Json(request): Json<CreateMessageRequest>,
) -> Result<Json<CreateMessageResponse>, AppError> {
    let fact = state.create_message.execute(request.body).await?;
    let event = project_message_created(fact);
    // The semantic unit of work returns only after commit. No subscriber is a
    // valid steady state; live delivery is not persistence authority.
    let _ = state.events.send(event.clone());

    let ServerEvent::MessageCreated { message } = event;
    Ok(Json(CreateMessageResponse { message }))
}

fn project_message_created(fact: MessageCreatedFact) -> ServerEvent {
    ServerEvent::MessageCreated {
        message: MessageDto {
            id: fact.message.id.to_string(),
            body: fact.message.body,
            created_at_ms: fact.message.created_at_ms.to_string(),
        },
    }
}

async fn event_websocket<U: MessageUnitOfWork>(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState<U>>>,
) -> Response {
    let receiver = state.events.subscribe();
    ws.on_upgrade(move |socket| drive_event_socket(socket, receiver))
}

async fn drive_event_socket(mut socket: WebSocket, mut events: broadcast::Receiver<ServerEvent>) {
    loop {
        tokio::select! {
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
            outbound = events.recv() => match outbound {
                Ok(event) => {
                    let Ok(json) = serde_json::to_string(&event) else {
                        tracing::error!("failed to serialize websocket event");
                        return;
                    };
                    if socket.send(Message::Text(json.into())).await.is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "closing lagged websocket consumer");
                    let _ = socket.send(Message::Close(Some(CloseFrame {
                        code: close_code::AGAIN,
                        reason: LAGGED_CLOSE_REASON.into(),
                    }))).await;
                    return;
                }
            }
        }
    }
}

/// The only place a status code is chosen. Inner layers carry causes, not codes.
#[derive(Debug)]
enum AppError {
    InvalidMessage,
    /// The cause is retained so the boundary can log the whole chain. It is
    /// never rendered into the response body.
    Persistence(CreateMessageError),
}

impl From<CreateMessageError> for AppError {
    fn from(value: CreateMessageError) -> Self {
        match value {
            CreateMessageError::InvalidBody => Self::InvalidMessage,
            persistence @ CreateMessageError::Persistence(_) => Self::Persistence(persistence),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            Self::InvalidMessage => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error": "body must contain 1..=10000 characters"})),
            )
                .into_response(),
            Self::Persistence(cause) => {
                // Exactly one log for one refusal, carrying every layer down to
                // the driver message.
                tracing::error!(
                    error_chain = %crate::infra::error::describe(&cause),
                    "request failed at the persistence boundary"
                );
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "internal server error"})),
                )
                    .into_response()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_fact_projects_to_wire_at_the_http_boundary() {
        let event = project_message_created(MessageCreatedFact {
            message: crate::application::Message {
                id: i64::MAX,
                body: "wire projection".into(),
                created_at_ms: i64::MAX,
            },
        });

        assert_eq!(
            event,
            ServerEvent::MessageCreated {
                message: MessageDto {
                    id: i64::MAX.to_string(),
                    body: "wire projection".into(),
                    created_at_ms: i64::MAX.to_string(),
                }
            }
        );
    }

    #[tokio::test]
    async fn bounded_event_channel_reports_lag_instead_of_growing() {
        let (sender, mut receiver) = broadcast::channel(1);
        let event = ServerEvent::MessageCreated {
            message: crate::contracts::MessageDto {
                id: "1".into(),
                body: "one".into(),
                created_at_ms: "1".into(),
            },
        };

        sender.send(event.clone()).unwrap();
        sender.send(event).unwrap();

        assert!(matches!(
            receiver.recv().await,
            Err(broadcast::error::RecvError::Lagged(1))
        ));
        assert_eq!(close_code::AGAIN, 1013);
        assert_eq!(
            LAGGED_CLOSE_REASON,
            "event consumer lagged; reconnect and resync"
        );
    }
}
