use crate::{AppConfig, StartupError};
use tokio::net::TcpListener;

/// Proof that composition follows a successful bind and `local_addr` observation.
///
/// Production code can only obtain this non-cloneable value through
/// [`Self::acquire_bound_listener`]. It remains outside every resource/router aggregate
/// until the single final commit.
pub(super) struct BoundListener {
    listener: TcpListener,
    address: std::net::SocketAddr,
}

impl BoundListener {
    pub(super) async fn acquire_bound_listener(config: &AppConfig) -> Result<Self, StartupError> {
        let listener = TcpListener::bind(config.listen_addr)
            .await
            .map_err(StartupError::Bind)?;
        Self::observe(listener)
    }

    #[cfg(test)]
    pub(super) fn from_existing(listener: TcpListener) -> Result<Self, StartupError> {
        Self::observe(listener)
    }

    fn observe(listener: TcpListener) -> Result<Self, StartupError> {
        let address = listener
            .local_addr()
            .map_err(StartupError::BoundListenerAddress)?;
        Ok(Self { listener, address })
    }

    pub(super) fn address(&self) -> std::net::SocketAddr {
        self.address
    }

    pub(super) fn into_listener(self) -> TcpListener {
        self.listener
    }
}
