use thiserror::Error;

/// Infrastructure failed. The concrete cause remains available to the outer
/// boundary without exposing a storage-driver type to application modules.
#[derive(Debug, Error)]
#[error("persistence operation failed")]
pub struct PersistenceFailure {
    #[source]
    source: Box<dyn std::error::Error + Send + Sync + 'static>,
}

impl PersistenceFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}
