//! Component router for the remaining host-management route family, mounted at the
//! app composition root (backend-app) behind the human bearer perimeter by the
//! #task:2234 integration (CP1).
//!
//! Every dependency is an accepted process owner: one SQLite-backed host store,
//! one live owning-host data plane, one status seed/admission owner, one
//! generation-bound disconnect handle, one process clock and one real scope-event
//! publisher. This module composes leaves only; deployment launchers decide whether
//! and where to mount it.

use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    response::Response,
};
use silverhand_backend_core::host_runtime::{
    computer::ComputerRecord,
    read::ComputerReadModel,
    status::HostStatusStoredReadModel,
    update::{UpdateComputer, UpdateComputerUnitOfWork},
};

use crate::{
    daemon_delivery::{DaemonConnectionControlHandle, OwningHostDataPlane},
    foundation::clock::ProcessClock,
    host_runtime::host_control::{admission::HostAdmission, status_seed::HostStatusSeeds},
};

pub mod disconnect;
pub mod proxy_config;
pub mod runtime_catalog;
pub mod status;
pub mod update;

#[allow(clippy::too_many_arguments)]
pub fn router<R, U, S, E, C>(
    computers: R,
    updates: U,
    status_read: S,
    label_change: E,
    data_plane: OwningHostDataPlane,
    seeds: HostStatusSeeds,
    admission: HostAdmission,
    disconnect: DaemonConnectionControlHandle,
    clock: C,
) -> Router
where
    R: ComputerReadModel,
    U: UpdateComputerUnitOfWork,
    S: HostStatusStoredReadModel,
    E: update::HostLabelChangeEffect,
    C: ProcessClock,
{
    Router::new()
        .merge(disconnect::router(computers.clone(), disconnect))
        .merge(proxy_config::router(computers.clone(), data_plane.clone()))
        .merge(runtime_catalog::router(computers, data_plane))
        .merge(update::router(
            UpdateComputer::new(updates),
            label_change,
            clock,
        ))
        .merge(status::router(status_read, seeds, admission))
}

async fn read_body(body: Body) -> Result<Bytes, ()> {
    // The mounted product stream perimeter owns the request-envelope ceiling.
    // This leaf aggregates only after its identity/lifecycle gate and adds no
    // second size authority that could drift from that perimeter.
    to_bytes(body, usize::MAX).await.map_err(|_| ())
}

fn internal_error() -> Response {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
        .into_response()
}

fn computer_times_are_js_safe(record: &ComputerRecord) -> bool {
    std::iter::once(Some(record.created_at))
        .chain([
            record.revoked_at,
            record.last_seen_at,
            record.activated_at,
            record.finalized_at,
        ])
        .flatten()
        .all(crate::host_runtime::host_control::wire_number::js_safe_integer)
}

use axum::response::IntoResponse;
