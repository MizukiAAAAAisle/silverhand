use axum::{
    Json, Router,
    extract::{
        State,
        rejection::JsonRejection,
        ws::{CloseFrame, Message as WebSocketMessage, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use silverhand_backend_core::foundation_message::{MessageReadUnitOfWork, MessageUnitOfWork};
use silverhand_backend_core::persistence::PersistenceFailure;
use tokio::sync::broadcast;
use tower_http::trace::TraceLayer;
use tracing::info_span;

use crate::{
    error,
    wire::{
        ApiError, ApiErrorCode, ApiErrorResponse, CreateFoundationMessageRequest,
        CreateFoundationMessageResponse, EVENT_LAG_CLOSE_CODE, EVENT_LAG_CLOSE_REASON,
        FOUNDATION_EVENT_WEBSOCKET_PATH, FOUNDATION_MESSAGE_PATH, FoundationMessagePageResponse,
        HEALTH_PATH, HealthResponse, HealthStatus, MessageDto, ServerEvent, WireContractVersion,
    },
};

const EVENT_BUFFER_CAPACITY: usize = 64;
const MAX_MESSAGE_BODY_CHARS: usize = 10_000;

#[derive(Clone)]
struct AppState<U> {
    unit_of_work: U,
    events: broadcast::Sender<ServerEvent>,
}

pub fn router<U>(unit_of_work: U) -> Router
where
    U: MessageUnitOfWork + MessageReadUnitOfWork,
{
    let (events, _) = broadcast::channel(EVENT_BUFFER_CAPACITY);
    let state = AppState {
        unit_of_work,
        events,
    };

    Router::new()
        .route(HEALTH_PATH, get(health))
        .route(
            FOUNDATION_MESSAGE_PATH,
            post(create_message::<U>).get(read_message_page::<U>),
        )
        .route(FOUNDATION_EVENT_WEBSOCKET_PATH, get(event_websocket::<U>))
        .with_state(state)
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &axum::http::Request<_>| {
                    info_span!(
                        "http_request",
                        method = %request.method(),
                        uri = %request.uri(),
                    )
                })
                .on_failure(()),
        )
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: HealthStatus::Ok,
        wire_contract_version: WireContractVersion,
    })
}

async fn create_message<U>(
    State(state): State<AppState<U>>,
    request: Result<Json<CreateFoundationMessageRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<CreateFoundationMessageResponse>), BoundaryError>
where
    U: MessageUnitOfWork + MessageReadUnitOfWork,
{
    let Json(request) =
        request.map_err(|_| BoundaryError::invalid("request body must match the wire contract"))?;
    let body = request.body.trim();
    if body.is_empty() || body.chars().count() > MAX_MESSAGE_BODY_CHARS {
        return Err(BoundaryError::invalid(
            "body must contain 1..=10000 characters",
        ));
    }

    let fact = state
        .unit_of_work
        .create_message_with_event(body.to_owned())
        .await?;
    let message = MessageDto::from(fact.message);
    let event = ServerEvent::MessageCreated {
        wire_contract_version: WireContractVersion,
        message: message.clone(),
    };
    let _ = state.events.send(event);

    Ok((
        StatusCode::CREATED,
        Json(CreateFoundationMessageResponse {
            wire_contract_version: WireContractVersion,
            message,
        }),
    ))
}

async fn read_message_page<U>(
    State(state): State<AppState<U>>,
) -> Result<Json<FoundationMessagePageResponse>, BoundaryError>
where
    U: MessageUnitOfWork + MessageReadUnitOfWork,
{
    let page = state.unit_of_work.latest_page().await?;
    Ok(Json(page.into()))
}

async fn event_websocket<U>(ws: WebSocketUpgrade, State(state): State<AppState<U>>) -> Response
where
    U: MessageUnitOfWork + MessageReadUnitOfWork,
{
    let receiver = state.events.subscribe();
    ws.on_upgrade(move |socket| drive_event_socket(socket, receiver))
}

async fn drive_event_socket(mut socket: WebSocket, mut events: broadcast::Receiver<ServerEvent>) {
    loop {
        tokio::select! {
            inbound = socket.recv() => match inbound {
                Some(Ok(WebSocketMessage::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
            outbound = receive_event_frame(&mut events) => match outbound {
                Some(frame) => {
                    let closes = matches!(frame, WebSocketMessage::Close(_));
                    if socket.send(frame).await.is_err() || closes {
                        return;
                    }
                }
                None => return,
            }
        }
    }
}

async fn receive_event_frame(
    events: &mut broadcast::Receiver<ServerEvent>,
) -> Option<WebSocketMessage> {
    match events.recv().await {
        Ok(event) => match serde_json::to_string(&event) {
            Ok(json) => Some(WebSocketMessage::Text(json.into())),
            Err(error) => {
                tracing::error!(%error, "failed to serialize websocket event");
                None
            }
        },
        Err(broadcast::error::RecvError::Closed) => None,
        Err(broadcast::error::RecvError::Lagged(skipped)) => {
            tracing::warn!(skipped, "closing lagged websocket consumer");
            Some(WebSocketMessage::Close(Some(CloseFrame {
                code: EVENT_LAG_CLOSE_CODE,
                reason: EVENT_LAG_CLOSE_REASON.into(),
            })))
        }
    }
}

#[derive(Debug)]
enum BoundaryError {
    Invalid(&'static str),
    Persistence(PersistenceFailure),
}

impl BoundaryError {
    fn invalid(message: &'static str) -> Self {
        Self::Invalid(message)
    }
}

impl From<PersistenceFailure> for BoundaryError {
    fn from(value: PersistenceFailure) -> Self {
        Self::Persistence(value)
    }
}

impl IntoResponse for BoundaryError {
    fn into_response(self) -> Response {
        match self {
            Self::Invalid(message) => error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::InvalidRequest,
                message,
            ),
            Self::Persistence(cause) => {
                tracing::error!(
                    error_chain = %error::describe(&cause),
                    "request failed at the persistence boundary"
                );
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ApiErrorCode::Internal,
                    "internal server error",
                )
            }
        }
    }
}

fn error_response(status: StatusCode, code: ApiErrorCode, message: &str) -> Response {
    (
        status,
        Json(ApiErrorResponse {
            wire_contract_version: WireContractVersion,
            error: ApiError {
                code,
                message: message.to_owned(),
            },
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lagged_stream_produces_the_contract_close_frame() {
        let (sender, mut receiver) = broadcast::channel(1);
        let event = ServerEvent::MessageCreated {
            wire_contract_version: WireContractVersion,
            message: MessageDto {
                id: "1".into(),
                body: "event".into(),
                created_at_ms: "1000".into(),
            },
        };
        sender.send(event.clone()).unwrap();
        sender.send(event).unwrap();

        let Some(WebSocketMessage::Close(Some(frame))) = receive_event_frame(&mut receiver).await
        else {
            panic!("lagged stream must produce a close frame");
        };
        assert_eq!(frame.code, EVENT_LAG_CLOSE_CODE);
        assert_eq!(frame.reason, EVENT_LAG_CLOSE_REASON);
    }
}
