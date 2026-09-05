use std::process::ExitCode;

mod logging;

use silverhand_backend_app::{AppConfig, describe, production_json_layer, run};
use silverhand_backend_server::{
    conversation_messaging::messaging::collaboration::conversation_log_debug::ProductionConversationLogDebugControl,
    foundation::{clock::SystemProcessClock, safe_log_field::safe_display},
};
use tracing_subscriber::{
    EnvFilter, fmt::writer::MakeWriterExt, layer::SubscriberExt, util::SubscriberInitExt,
};

#[tokio::main]
async fn main() -> ExitCode {
    // Own the worker until after run and its final error event: dropping it drains
    // pending file records on both successful shutdown and startup refusal.
    let (file_writer, _log_guard) = match logging::open_from_env() {
        Ok(logging) => logging,
        Err(error) => {
            eprintln!("backend file logging initialization failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    tracing_subscriber::registry()
        .with(production_json_layer(
            EnvFilter::from_default_env(),
            ProductionConversationLogDebugControl::process(),
            SystemProcessClock,
            file_writer.and(std::io::stderr),
        ))
        .init();

    let result = match AppConfig::from_env() {
        Ok(config) => run(config).await,
        Err(error) => Err(error.into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(
                error_chain = safe_display(&describe(&error)),
                "backend startup failed"
            );
            ExitCode::FAILURE
        }
    }
}
