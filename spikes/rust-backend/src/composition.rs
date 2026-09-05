use axum::Router;

use crate::{adapters::sqlite::SqliteDatabase, http};

/// The only module that binds the HTTP/application side to the concrete
/// persistence adapter. Deployment profiles compose the same router contract.
pub fn sqlite_router(database: SqliteDatabase) -> Router {
    http::router(database)
}
