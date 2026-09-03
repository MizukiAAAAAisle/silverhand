use std::process::ExitCode;

use silverhand_backend_app::{AppConfig, describe, production_json_layer, run};
use silverhand_backend_server::{
    conversation_messaging::messaging::collaboration::conversation_log_debug::ProductionConversationLogDebugControl,
    foundation::{clock::SystemProcessClock, safe_log_field::safe_display},
};
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::registry()
        .with(production_json_layer(
            EnvFilter::from_default_env(),
            ProductionConversationLogDebugControl::process(),
            SystemProcessClock,
            std::io::stderr,
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
