use crate::{AppConfig, StartupError, remove_stale_bootstrap_token, write_bootstrap_token_file};
use silverhand_backend_core::{
    host_runtime::environment::OsEntropy,
    identity_access::auth::{EntropySessionTokenMint, SessionTokenMint},
};
use silverhand_backend_server::{embedded_bootstrap, ops::deployment::DeploymentProfile};

/// The only bootstrap-provision door. This remains the last fallible startup step; on
/// success the authority can move directly into the infallible final assembly.
pub(super) async fn provision(
    config: &AppConfig,
    bound_listener_addr: std::net::SocketAddr,
    mint: &EntropySessionTokenMint<OsEntropy>,
) -> Result<embedded_bootstrap::EmbeddedBootstrapTokenAuthority, StartupError> {
    match &config.bootstrap_token_path {
        Some(path)
            if matches!(config.deployment_profile, DeploymentProfile::Embedded)
                && embedded_bootstrap::is_loopback_ip(bound_listener_addr.ip()) =>
        {
            let minted = mint.mint().map_err(|source| StartupError::Composition {
                name: "embedded bootstrap token mint",
                source: Box::new(source),
            })?;
            let (secret, _hash) = minted.into_parts();
            let plaintext = secret.into_wire();
            write_bootstrap_token_file(path, &plaintext)
                .await
                .map_err(StartupError::BootstrapToken)?;
            Ok(
                embedded_bootstrap::EmbeddedBootstrapTokenAuthority::enabled(
                    &plaintext,
                    path.clone(),
                ),
            )
        }
        maybe_path => {
            if let Some(path) = maybe_path {
                remove_stale_bootstrap_token(path).await;
            }
            Ok(embedded_bootstrap::EmbeddedBootstrapTokenAuthority::disabled())
        }
    }
}
