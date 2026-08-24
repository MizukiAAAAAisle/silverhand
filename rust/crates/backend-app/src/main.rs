use std::process::ExitCode;

use silverhand_backend_app::{AppConfig, describe, run};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .json()
        .init();

    let result = match AppConfig::from_env() {
        Ok(config) => run(config).await,
        Err(error) => Err(error.into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(error_chain = %describe(&error), "backend startup failed");
            ExitCode::FAILURE
        }
    }
}
