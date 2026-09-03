//! `GET` / `PUT /api/hosts/{id}/proxy-config`.

use axum::{
    Json, Router,
    extract::{Extension, Path, Request, State},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use silverhand_backend_core::{
    foundation::identity::{HostId, UserId},
    host_runtime::read::{ComputerReadModel, find_owned_computer},
    identity_access::agents::runtime::RuntimeKind,
};

use crate::{
    application_orchestration::daemon_delivery::OwningHostDataPlane,
    foundation::error,
    foundation::wire_admission::from_object_slice,
    foundation::wire_patch::PatchField,
    host_runtime::host_control::proxy_config::{
        self, ProxyConfig, ProxyConfigOutcome, ProxyConfigRequest,
    },
};

use super::{internal_error, read_body};

pub const HOST_PROXY_CONFIG_PATH: &str = "/api/hosts/{id}/proxy-config";

#[derive(Clone)]
struct ProxyState<R> {
    computers: R,
    data_plane: OwningHostDataPlane,
}

pub fn router<R>(computers: R, data_plane: OwningHostDataPlane) -> Router
where
    R: ComputerReadModel,
{
    Router::new()
        .route(HOST_PROXY_CONFIG_PATH, get(read::<R>).put(write::<R>))
        .with_state(ProxyState {
            computers,
            data_plane,
        })
}

async fn read<R>(
    Path(raw_host): Path<String>,
    principal: Option<Extension<UserId>>,
    State(state): State<ProxyState<R>>,
) -> Response
where
    R: ComputerReadModel,
{
    let host = match admit(&state, raw_host, principal).await {
        Ok(host) => host,
        Err(refusal) => return refusal.into_response(),
    };
    let custody = match resolve(&state, &host) {
        Ok(custody) => custody,
        Err(refusal) => return refusal.into_response(),
    };
    render(proxy_config::get(&state.data_plane, ProxyConfigRequest::new(custody)).await)
}

async fn write<R>(
    Path(raw_host): Path<String>,
    principal: Option<Extension<UserId>>,
    State(state): State<ProxyState<R>>,
    request: Request,
) -> Response
where
    R: ComputerReadModel,
{
    let host = match admit(&state, raw_host, principal).await {
        Ok(host) => host,
        Err(refusal) => return refusal.into_response(),
    };
    let Some(config) = read_body(request.into_body())
        .await
        .ok()
        .and_then(|body| from_object_slice::<ProxyBody>(&body).ok())
        .and_then(ProxyBody::into_config)
    else {
        return coded("invalid input", None, 400);
    };
    let custody = match resolve(&state, &host) {
        Ok(custody) => custody,
        Err(refusal) => return refusal.into_response(),
    };
    render(proxy_config::set(&state.data_plane, ProxyConfigRequest::new(custody), config).await)
}

async fn admit<R>(
    state: &ProxyState<R>,
    raw_host: String,
    principal: Option<Extension<UserId>>,
) -> Result<HostId, AdmitRefusal>
where
    R: ComputerReadModel,
{
    let Some(Extension(requester)) = principal else {
        tracing::error!("host-proxy-config route reached without its human principal fact");
        return Err(AdmitRefusal::Internal);
    };
    let Ok(host) = HostId::parse(raw_host) else {
        return Err(AdmitRefusal::HostNotFound);
    };
    let record = match state.computers.read_computer(host.clone()).await {
        Ok(record) => record,
        Err(cause) => {
            tracing::error!(
                error_chain =
                    crate::foundation::safe_log_field::safe_display(&(error::describe(&cause))),
                "host-proxy-config read failed"
            );
            return Err(AdmitRefusal::Internal);
        }
    };
    let Some(owned) = find_owned_computer(&requester, record) else {
        return Err(AdmitRefusal::HostNotFound);
    };
    if owned.record().revoked_at.is_some() {
        return Err(AdmitRefusal::Revoked);
    }
    if owned.record().finalized_at.is_none() {
        return Err(AdmitRefusal::NotActive);
    }
    Ok(host)
}

/// Route-local admission refusal. `admit` keeps a small fieldless verdict rather
/// than an eagerly-built `Response` so its `Result` stays cheap (`result_large_err`),
/// then this projects to the exact same HTTP boundary the inline responses did.
/// The two internal arms have already logged at their detection site.
enum AdmitRefusal {
    Internal,
    HostNotFound,
    Revoked,
    NotActive,
}

impl IntoResponse for AdmitRefusal {
    fn into_response(self) -> Response {
        match self {
            Self::Internal => internal_error(),
            Self::HostNotFound => coded("host not found", Some("host_not_found"), 404),
            Self::Revoked => coded("host has been revoked", Some("host_revoked"), 409),
            Self::NotActive => coded("host is not active", Some("host_not_active"), 409),
        }
    }
}

fn resolve<R>(
    state: &ProxyState<R>,
    host: &HostId,
) -> Result<crate::application_orchestration::daemon_delivery::HostDataPlaneCustody, ResolveRefusal>
{
    match state.data_plane.resolve(host) {
        Ok(Some(custody)) => Ok(custody),
        Ok(None) => Err(ResolveRefusal::Offline),
        Err(cause) => {
            tracing::error!(
                error = crate::foundation::safe_log_field::safe_display(&(cause)),
                "owning-host data plane resolve failed"
            );
            Err(ResolveRefusal::Internal)
        }
    }
}

enum ResolveRefusal {
    Offline,
    Internal,
}

impl IntoResponse for ResolveRefusal {
    fn into_response(self) -> Response {
        match self {
            Self::Offline => coded("computer is offline", Some("computer_offline"), 503),
            Self::Internal => coded("daemon request failed", Some("daemon_internal_error"), 502),
        }
    }
}

/// The proxy-config body. `proxy_url` is optional-but-present-nullable in the wire
/// vocab: the frozen [`PatchField`] tells an ABSENT key from an explicit `null`. This
/// route keeps its post-auth admission (the anti-enum `404` runs before the body), and a
/// decode failure and an absent `proxy_url` both funnel to the same explicit `400` this
/// handler already returned, so the `#[serde(default)]` Missing arm is mapped EXPLICITLY
/// to the refusal rather than relying on a missing-field decode error. No
/// `deny_unknown_fields`: this route tolerates stray keys as it did before.
///
/// The post-auth decode goes through the shared [`from_object_slice`] object-only floor:
/// a bare `serde_json::from_slice` would bind a JSON array positionally, so `[null,["codex"]]`
/// would decode to `proxy_url: null` + `proxy_runtimes: ["codex"]` and DISPATCH a real config.
/// The floor refuses any top-level non-object before that positional bind; the resulting
/// decode fault takes the same `400` this handler already returns, ahead of `resolve`/dispatch.
#[derive(Deserialize)]
struct ProxyBody {
    #[serde(default)]
    proxy_url: PatchField<String>,
    proxy_runtimes: Vec<String>,
}

impl ProxyBody {
    fn into_config(self) -> Option<ProxyConfig> {
        let proxy_url = match self.proxy_url {
            PatchField::Missing => return None,
            PatchField::Null => None,
            PatchField::Value(value) => Some(value),
        };
        let proxy_runtimes = self
            .proxy_runtimes
            .into_iter()
            .map(|runtime| RuntimeKind::parse(&runtime))
            .collect::<Option<Vec<_>>>()?;
        Some(ProxyConfig {
            proxy_url,
            proxy_runtimes,
        })
    }
}

fn render(outcome: ProxyConfigOutcome) -> Response {
    match outcome {
        ProxyConfigOutcome::Answered(config) => {
            Json(serde_json::json!({ "config": config })).into_response()
        }
        ProxyConfigOutcome::AttachPending => {
            coded("computer is offline", Some("computer_offline"), 503)
        }
        ProxyConfigOutcome::Timeout => {
            coded("daemon request timed out", Some("daemon_timeout"), 504)
        }
        ProxyConfigOutcome::DaemonInternalError => {
            coded("daemon request failed", Some("daemon_internal_error"), 502)
        }
        ProxyConfigOutcome::TransportContractViolation => internal_error(),
    }
}

fn coded(message: &'static str, code: Option<&'static str>, status: u16) -> Response {
    let body = match code {
        Some(code) => serde_json::json!({ "error": message, "error_code": code }),
        None => serde_json::json!({ "error": message }),
    };
    (
        axum::http::StatusCode::from_u16(status).unwrap(),
        Json(body),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The handler's SOLE body decode gate is `from_object_slice::<ProxyBody>` (the
    // `.and_then(|body| from_object_slice…ok())` in `write`). A decode `Err` collapses to
    // `None`, so `into_config` never runs and the handler returns `400` before `resolve`
    // and dispatch. These assertions pin that gate directly: no data-plane scaffolding is
    // needed to prove a value-shaped array can never reach the config dispatch.

    #[test]
    fn a_value_shaped_array_is_refused_before_any_positional_field_bind() {
        // Under a bare `from_slice`, this would bind `proxy_url: null` +
        // `proxy_runtimes: ["codex"]` positionally and yield a dispatchable config.
        assert!(from_object_slice::<ProxyBody>(br#"[null,["codex"]]"#).is_err());
    }

    #[test]
    fn an_empty_array_is_refused_rather_than_defaulting_the_body() {
        assert!(from_object_slice::<ProxyBody>(br#"[]"#).is_err());
    }

    #[test]
    fn the_equivalent_object_still_decodes_and_dispatches() {
        // The object-only floor must not narrow the real object contract: the same values
        // in object shape decode and produce a live config.
        let body =
            from_object_slice::<ProxyBody>(br#"{"proxy_url":null,"proxy_runtimes":["codex"]}"#)
                .expect("object body decodes through the floor");
        let config = body
            .into_config()
            .expect("null url + one runtime is a valid config");
        assert!(config.proxy_url.is_none());
        assert_eq!(config.proxy_runtimes.len(), 1);
    }
}
