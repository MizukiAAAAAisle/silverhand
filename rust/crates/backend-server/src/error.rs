use std::error::Error;

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
