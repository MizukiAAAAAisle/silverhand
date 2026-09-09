//! Operator-console launcher configuration and adapter composition.

use crate::{AppConfig, ConfigError, StartupError};
use axum::Router;
use sha2::{Digest, Sha256};
use silverhand_backend_sqlite::application_orchestration::SqliteConsoleAnalyticsRead;

pub(crate) fn parse_token(
    raw: Option<&str>,
    remote_only: bool,
) -> Result<Option<[u8; 32]>, ConfigError> {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !remote_only {
        return Err(ConfigError::ConsoleRequiresRemoteOnly);
    }
    if !(32..=256).contains(&raw.len()) || !raw.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(ConfigError::InvalidConsoleToken);
    }

    Ok(Some(Sha256::digest(raw.as_bytes()).into()))
}

pub(crate) async fn router(config: &AppConfig) -> Result<Option<Router>, StartupError> {
    let Some(token_hash) = config.console_token_hash else {
        return Ok(None);
    };
    let read = SqliteConsoleAnalyticsRead::open(&config.database_path)
        .await
        .map_err(|source| StartupError::Composition {
            name: "operator console analytics",
            source: Box::new(source),
        })?;
    let router = silverhand_backend_server::foundation::operator_console::router(
        read,
        token_hash,
        include_str!("operator-console.html"),
    );

    Ok(Some(router))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_bounded_and_requires_remote_only() {
        assert_eq!(parse_token(None, false).unwrap(), None);
        assert_eq!(parse_token(Some(""), false).unwrap(), None);
        assert!(matches!(
            parse_token(Some(&"x".repeat(32)), false),
            Err(ConfigError::ConsoleRequiresRemoteOnly)
        ));
        assert!(matches!(
            parse_token(Some("too-short"), true),
            Err(ConfigError::InvalidConsoleToken)
        ));
        assert!(parse_token(Some(&"x".repeat(32)), true).unwrap().is_some());
    }
}
