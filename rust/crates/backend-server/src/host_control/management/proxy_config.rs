//! `GET` / `PUT /api/hosts/{id}/proxy-config`.

use axum::{
    Json, Router,
    extract::{Extension, Path, Request, State},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use silverhand_backend_core::{
    agents::runtime::RuntimeKind,
    host_runtime::read::{ComputerReadModel, find_owned_computer},
    identity::{HostId, UserId},
};

use crate::{
    daemon_delivery::OwningHostDataPlane,
    error,
    host_control::proxy_config::{self, ProxyConfig, ProxyConfigOutcome, ProxyConfigRequest},
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
        Err(response) => return response,
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
        Err(response) => return response,
    };
    let Some(config) = read_body(request.into_body())
        .await
        .ok()
        .and_then(|body| serde_json::from_slice::<ProxyBody>(&body).ok())
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
) -> Result<HostId, Response>
where
    R: ComputerReadModel,
{
    let Some(Extension(requester)) = principal else {
        tracing::error!("host-proxy-config route reached without its human principal fact");
        return Err(internal_error());
    };
    let Ok(host) = HostId::parse(raw_host) else {
        return Err(coded("host not found", Some("host_not_found"), 404));
    };
    let record = match state.computers.read_computer(host.clone()).await {
        Ok(record) => record,
        Err(cause) => {
            tracing::error!(error_chain = %error::describe(&cause), "host-proxy-config read failed");
            return Err(internal_error());
        }
    };
    let Some(owned) = find_owned_computer(&requester, record) else {
        return Err(coded("host not found", Some("host_not_found"), 404));
    };
    if owned.record().revoked_at.is_some() {
        return Err(coded("host has been revoked", Some("host_revoked"), 409));
    }
    if owned.record().finalized_at.is_none() {
        return Err(coded("host is not active", Some("host_not_active"), 409));
    }
    Ok(host)
}

fn resolve<R>(
    state: &ProxyState<R>,
    host: &HostId,
) -> Result<crate::daemon_delivery::HostDataPlaneCustody, ResolveRefusal> {
    match state.data_plane.resolve(host) {
        Ok(Some(custody)) => Ok(custody),
        Ok(None) => Err(ResolveRefusal::Offline),
        Err(cause) => {
            tracing::error!(error = %cause, "owning-host data plane resolve failed");
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

#[derive(Deserialize)]
struct ProxyBody {
    proxy_url: serde_json::Value,
    proxy_runtimes: Vec<String>,
}

impl ProxyBody {
    fn into_config(self) -> Option<ProxyConfig> {
        let proxy_url = match self.proxy_url {
            serde_json::Value::Null => None,
            serde_json::Value::String(value) => Some(value),
            _ => return None,
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
