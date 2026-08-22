use std::{net::SocketAddr, path::PathBuf};

use silverhand_rust_backend_spike::{adapters::sqlite::SqliteDatabase, composition};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let bind: SocketAddr = std::env::var("SPIKE_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()?;
    let db_path = std::env::var_os("SPIKE_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("spike.db"));

    let db = SqliteDatabase::open(db_path).await?;
    let listener = TcpListener::bind(bind).await?;
    tracing::info!(address = %listener.local_addr()?, "rust backend spike listening");

    axum::serve(listener, composition::sqlite_router(db))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
