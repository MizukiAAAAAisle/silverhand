use std::error::Error;

#[derive(Debug)]
pub(crate) struct BoundaryFailure {
    source: Box<dyn Error + Send + Sync + 'static>,
}

impl BoundaryFailure {
    pub(crate) fn new(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            source: Box::new(source),
        }
    }
}

impl std::fmt::Display for BoundaryFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("pre-send authority failed")
    }
}

impl Error for BoundaryFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.source.as_ref())
    }
}

pub(crate) fn describe(error: &(dyn Error + 'static)) -> String {
    let mut messages = vec![error.to_string()];
    let mut current = error.source();
    while let Some(cause) = current {
        messages.push(cause.to_string());
        current = cause.source();
    }
    messages.join(": ")
}

#[cfg(test)]
mod tests {
    use thiserror::Error;

    use super::*;

    #[derive(Debug, Error)]
    #[error("driver refused the operation")]
    struct DriverError;

    #[derive(Debug, Error)]
    #[error("persistence operation failed")]
    struct PersistenceError {
        #[source]
        source: DriverError,
    }

    #[test]
    fn renders_the_complete_source_chain() {
        let error = PersistenceError {
            source: DriverError,
        };

        assert_eq!(
            describe(&error),
            "persistence operation failed: driver refused the operation"
        );
    }
}
