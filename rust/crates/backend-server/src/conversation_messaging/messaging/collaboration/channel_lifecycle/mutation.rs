//! Auth-first HTTP boundary for channel archive, visibility and rename.
//!
//! The DEFERRED admission port is only a body-poll ordering optimization. Each
//! operation still enters its own writer-reserved SQLite unit, re-derives every
//! mutable authority and returns a bound committed fact before effects or wire.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, FromRequest, Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::patch,
};
use garde::Validate;
use serde::Deserialize;
use serde_json::json;
use silverhand_backend_core::{
    conversation_messaging::messaging::{
        collaboration::{
            channel_directory::ChannelVisibility,
            channel_lifecycle::{
                ChannelArchiveAftermath, ChannelArchivePort, ChannelArchiveRefusal,
                ChannelMutationAdmissionPort, ChannelMutationAdmissionRefusal,
                ChannelRenameAftermath, ChannelRenamePort, ChannelRenameRefusal,
                ChannelVisibilityAftermath, ChannelVisibilityPort, ChannelVisibilityRefusal,
                archive_channel, rename_channel, set_channel_visibility,
            },
        },
        conversation_title::CanonicalConversationTitle,
    },
    foundation::identity::{ConversationId, UserId},
};

use crate::foundation::wire_admission::{ValidatedJson, invalid_input};
use crate::foundation::wire_patch::RequiredPatchField;

use super::{channel, error, internal};

/// `PATCH /archive` body — `z.object({ archived: z.boolean() })` (NOT `.strict()`, strip).
#[derive(Debug, Deserialize, Validate)]
struct ArchiveBody {
    #[garde(skip)]
    archived: bool,
}

/// `PATCH /:id` body — `z.object({ title?, visibility? }).refine(exactly one)` (strip).
/// Both fields are OPTIONAL but NOT nullable (`.optional()`, not `.nullable()`), so an
/// explicit `null` is a native decode fault via `RequiredPatchField`, never merged with an
/// absent key. Serde owns the field shapes; the title grammar is a garde delegate; the
/// exactly-one invariant is a stateless refinement enforced in `TryFrom` (→ minimal 422).
#[derive(Debug, Deserialize, Validate)]
struct UpdateChannelBody {
    #[serde(default)]
    #[garde(custom(valid_channel_title))]
    title: RequiredPatchField<String>,
    #[serde(default)]
    #[garde(skip)]
    visibility: RequiredPatchField<WireChannelVisibility>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WireChannelVisibility {
    Private,
    Public,
}

impl From<WireChannelVisibility> for ChannelVisibility {
    fn from(value: WireChannelVisibility) -> Self {
        match value {
            WireChannelVisibility::Private => ChannelVisibility::Private,
            WireChannelVisibility::Public => ChannelVisibility::Public,
        }
    }
}

fn valid_channel_title(value: &RequiredPatchField<String>, _: &()) -> garde::Result {
    match value {
        RequiredPatchField::Missing => Ok(()),
        RequiredPatchField::Value(raw) => CanonicalConversationTitle::parse(raw)
            .map(|_| ())
            .map_err(|_| garde::Error::new("title is not a valid channel title")),
    }
}

enum ChannelUpdate {
    Rename(CanonicalConversationTitle),
    Visibility(ChannelVisibility),
}

impl TryFrom<UpdateChannelBody> for ChannelUpdate {
    type Error = ();
    fn try_from(body: UpdateChannelBody) -> Result<Self, ()> {
        match (body.title, body.visibility) {
            (RequiredPatchField::Value(title), RequiredPatchField::Missing) => Ok(
                ChannelUpdate::Rename(CanonicalConversationTitle::parse(&title).map_err(|_| ())?),
            ),
            (RequiredPatchField::Missing, RequiredPatchField::Value(visibility)) => Ok(
                ChannelUpdate::Visibility(ChannelVisibility::from(visibility)),
            ),
            // Neither or both — the reference's exactly-one `.refine()`.
            _ => Err(()),
        }
    }
}

pub const CHANNEL_ARCHIVE_PATH: &str = "/api/channels/{id}/archive";

struct Inner<P, A> {
    port: P,
    aftermath: A,
}

struct MutationState<P, A>(Arc<Inner<P, A>>);

impl<P, A> Clone for MutationState<P, A> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

/// The mutation leaf stays separate from detail-read composition. The eventual
/// authenticated app mount may merge both routers without changing either port.
pub fn mutation_router<P, A>(port: P, aftermath: A) -> Router
where
    P: ChannelMutationAdmissionPort
        + ChannelArchivePort
        + ChannelVisibilityPort
        + ChannelRenamePort
        + Send
        + Sync
        + 'static,
    A: ChannelArchiveAftermath
        + ChannelVisibilityAftermath
        + ChannelRenameAftermath
        + Send
        + Sync
        + 'static,
{
    Router::new()
        .route(CHANNEL_ARCHIVE_PATH, patch(archive::<P, A>))
        .route(super::CHANNEL_DETAIL_PATH, patch(update::<P, A>))
        .with_state(MutationState(Arc::new(Inner { port, aftermath })))
}

async fn archive<P, A>(
    State(state): State<MutationState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(raw_conversation): Path<String>,
    request: Request,
) -> Response
where
    P: ChannelMutationAdmissionPort + ChannelArchivePort,
    A: ChannelArchiveAftermath,
{
    let (viewer, conversation) = match request_coordinates(principal, raw_conversation) {
        Ok(value) => value,
        Err(refusal) => return refusal.response(),
    };
    if let Err(refusal) = admit(&state.0.port, &viewer, &conversation).await {
        return refusal.response();
    }
    // Authority-first: governance is admitted before the body is polled. The shared
    // `ValidatedJson` extractor runs deferred: structural faults keep native 415/400/422,
    // no leaf parser.
    let archived = match ValidatedJson::<ArchiveBody>::from_request(request, &()).await {
        Ok(ValidatedJson(body)) => body.archived,
        Err(rejection) => return rejection.into_response(),
    };

    match archive_channel(
        &state.0.port,
        &state.0.aftermath,
        viewer,
        conversation,
        archived,
    )
    .await
    {
        Ok(Ok(execution)) => {
            report_effect(execution.first_failure(), "archive");
            channel_success(execution.committed().row())
        }
        Ok(Err(refusal)) => archive_refusal(refusal),
        Err(failure) => {
            tracing::error!(
                error_chain = crate::foundation::safe_log_field::safe_display(
                    &(crate::foundation::error::describe(&failure))
                ),
                "channel archive failed"
            );
            internal()
        }
    }
}

async fn update<P, A>(
    State(state): State<MutationState<P, A>>,
    principal: Option<Extension<UserId>>,
    Path(raw_conversation): Path<String>,
    request: Request,
) -> Response
where
    P: ChannelMutationAdmissionPort + ChannelVisibilityPort + ChannelRenamePort,
    A: ChannelVisibilityAftermath + ChannelRenameAftermath,
{
    let (viewer, conversation) = match request_coordinates(principal, raw_conversation) {
        Ok(value) => value,
        Err(refusal) => return refusal.response(),
    };
    if let Err(refusal) = admit(&state.0.port, &viewer, &conversation).await {
        return refusal.response();
    }
    // Authority-first: governance is admitted before the body is polled. The shared
    // `ValidatedJson` extractor decodes + runs the title grammar; the exactly-one
    // `title|visibility` invariant is a request-local semantic refusal → minimal 422.
    let body = match ValidatedJson::<UpdateChannelBody>::from_request(request, &()).await {
        Ok(ValidatedJson(body)) => body,
        Err(rejection) => return rejection.into_response(),
    };
    let update = match ChannelUpdate::try_from(body) {
        Ok(update) => update,
        Err(()) => return invalid_input(),
    };

    match update {
        ChannelUpdate::Visibility(visibility) => {
            match set_channel_visibility(
                &state.0.port,
                &state.0.aftermath,
                viewer,
                conversation,
                visibility,
            )
            .await
            {
                Ok(Ok(execution)) => {
                    report_effect(execution.first_failure(), "visibility");
                    channel_success(execution.committed().row())
                }
                Ok(Err(refusal)) => visibility_refusal(refusal),
                Err(failure) => {
                    tracing::error!(
                        error_chain = crate::foundation::safe_log_field::safe_display(
                            &(crate::foundation::error::describe(&failure))
                        ),
                        "channel visibility mutation failed"
                    );
                    internal()
                }
            }
        }
        ChannelUpdate::Rename(title) => {
            let requested = title.title().to_owned();
            match rename_channel(
                &state.0.port,
                &state.0.aftermath,
                viewer,
                conversation,
                title,
            )
            .await
            {
                Ok(Ok(execution)) => {
                    report_effect(execution.first_failure(), "rename");
                    channel_success(execution.committed().row())
                }
                Ok(Err(refusal)) => rename_refusal(refusal, &requested),
                Err(failure) => {
                    tracing::error!(
                        error_chain = crate::foundation::safe_log_field::safe_display(
                            &(crate::foundation::error::describe(&failure))
                        ),
                        "channel rename failed"
                    );
                    internal()
                }
            }
        }
    }
}

fn request_coordinates(
    principal: Option<Extension<UserId>>,
    raw_conversation: String,
) -> Result<(UserId, ConversationId), CoordinateRefusal> {
    let Some(Extension(viewer)) = principal else {
        tracing::error!("channel mutation route reached without its human principal fact");
        return Err(CoordinateRefusal::MissingPrincipal);
    };
    let Ok(conversation) = ConversationId::parse(raw_conversation) else {
        return Err(CoordinateRefusal::InvalidConversation);
    };
    Ok((viewer, conversation))
}

enum CoordinateRefusal {
    MissingPrincipal,
    InvalidConversation,
}

impl CoordinateRefusal {
    fn response(self) -> Response {
        match self {
            Self::MissingPrincipal => internal(),
            Self::InvalidConversation => error(StatusCode::BAD_REQUEST, "channel id required"),
        }
    }
}

async fn admit<P: ChannelMutationAdmissionPort>(
    port: &P,
    viewer: &UserId,
    conversation: &ConversationId,
) -> Result<(), AdmissionRefusal> {
    match port.admit(viewer, conversation).await {
        Ok(Ok(value)) => value
            .bind(viewer, conversation)
            .map(|_| ())
            .map_err(|failure| {
                tracing::error!(
                    error_chain = crate::foundation::safe_log_field::safe_display(
                        &(crate::foundation::error::describe(&failure))
                    ),
                    "channel mutation admission identity seal failed"
                );
                AdmissionRefusal::Internal
            }),
        Ok(Err(ChannelMutationAdmissionRefusal::NotFound)) => Err(AdmissionRefusal::NotFound),
        Ok(Err(ChannelMutationAdmissionRefusal::Forbidden)) => Err(AdmissionRefusal::Forbidden),
        Err(failure) => {
            tracing::error!(
                error_chain = crate::foundation::safe_log_field::safe_display(
                    &(crate::foundation::error::describe(&failure))
                ),
                "channel mutation admission failed"
            );
            Err(AdmissionRefusal::Internal)
        }
    }
}

enum AdmissionRefusal {
    NotFound,
    Forbidden,
    Internal,
}

impl AdmissionRefusal {
    fn response(self) -> Response {
        match self {
            Self::NotFound => error(StatusCode::NOT_FOUND, "channel not found"),
            Self::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
            Self::Internal => internal(),
        }
    }
}

fn channel_success(
    row: &silverhand_backend_core::conversation_messaging::messaging::collaboration::channel_lifecycle::ChannelLifecycleRow,
) -> Response {
    Json(json!({"channel":channel(row)})).into_response()
}

fn archive_refusal(refusal: ChannelArchiveRefusal) -> Response {
    match refusal {
        ChannelArchiveRefusal::NotFound => error(StatusCode::NOT_FOUND, "channel not found"),
        ChannelArchiveRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
    }
}

fn visibility_refusal(refusal: ChannelVisibilityRefusal) -> Response {
    match refusal {
        ChannelVisibilityRefusal::NotFound => error(StatusCode::NOT_FOUND, "channel not found"),
        ChannelVisibilityRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
    }
}

fn rename_refusal(refusal: ChannelRenameRefusal, title: &str) -> Response {
    match refusal {
        ChannelRenameRefusal::NotFound => error(StatusCode::NOT_FOUND, "channel not found"),
        ChannelRenameRefusal::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        ChannelRenameRefusal::NotAddressable => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error":"this conversation has no workspace to hold a title address",
                "code":"not_addressable",
            })),
        )
            .into_response(),
        ChannelRenameRefusal::TitleTaken => (
            StatusCode::CONFLICT,
            Json(json!({
                "error":format!("a channel titled {title} already exists in this workspace"),
                "code":"conversation_title_taken",
            })),
        )
            .into_response(),
    }
}

fn report_effect(
    failure: Option<&silverhand_backend_core::conversation_messaging::messaging::collaboration::channel_lifecycle::ChannelMutationEffectFailure>,
    operation: &'static str,
) {
    if let Some(failure) = failure {
        tracing::error!(
            error_chain = crate::foundation::safe_log_field::safe_display(
                &(crate::foundation::error::describe(failure))
            ),
            operation,
            "committed channel mutation aftermath failed"
        );
    }
}

#[cfg(test)]
mod tests;
