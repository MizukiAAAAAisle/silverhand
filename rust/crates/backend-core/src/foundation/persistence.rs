use std::future::Future;

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

/// Answers whether this process can still WRITE to its store, by taking the write
/// lock and immediately giving it back.
///
/// A capability of the store, not a verdict about the process: the probe writes no
/// row, owns no domain data, and says nothing about what a refusal should mean. A
/// caller that turns it into a health answer supplies that meaning itself, so this
/// port cannot become a second definition of "ready".
///
/// `Ok(())` is the whole of the success side — a probe that succeeded has nothing to
/// report. A refusal carries the cause so an operational surface can attach the
/// engine's own words; whether a particular refusal is transient is the engine
/// adapter's dialect and is not answered here.
pub trait WriteProbe {
    fn probe_write(&self) -> impl Future<Output = Result<(), PersistenceFailure>> + Send;
}
