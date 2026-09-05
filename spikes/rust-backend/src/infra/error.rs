//! Rendering an error for a log without flattening it into a string too early.
//!
//! The layering rule this supports: inner layers keep their own concrete error
//! types and carry the infra cause as a source; only the outermost adapter
//! decides a status code and decides what the client is allowed to see. That
//! split is only worth anything if the cause actually survives the trip, so the
//! boundary needs a way to render the whole chain.

use std::error::Error;

/// Every message from `error` down to the root cause, outermost first.
pub fn chain(error: &(dyn Error + 'static)) -> Vec<String> {
    let mut messages = vec![error.to_string()];
    let mut current = error.source();
    while let Some(cause) = current {
        messages.push(cause.to_string());
        current = cause.source();
    }
    messages
}

/// One log-friendly line for the whole chain.
pub fn describe(error: &(dyn Error + 'static)) -> String {
    chain(error).join(": ")
}

/// The deepest cause, which is where the driver detail lives.
pub fn root_cause(error: &(dyn Error + 'static)) -> String {
    let mut current = error;
    while let Some(cause) = current.source() {
        current = cause;
    }
    current.to_string()
}

#[cfg(test)]
mod tests {
    use thiserror::Error;

    use super::*;

    #[derive(Debug, Error)]
    #[error("driver refused the statement")]
    struct Driver;

    #[derive(Debug, Error)]
    #[error("persistence operation failed")]
    struct Persistence {
        #[source]
        source: Driver,
    }

    #[derive(Debug, Error)]
    enum UseCase {
        #[error(transparent)]
        Persistence(#[from] Persistence),
    }

    #[test]
    fn chain_keeps_every_layer_outermost_first() {
        let error = UseCase::from(Persistence { source: Driver });

        assert_eq!(
            chain(&error),
            vec![
                "persistence operation failed".to_owned(),
                "driver refused the statement".to_owned(),
            ]
        );
    }

    #[test]
    fn describe_is_one_line_and_root_cause_is_the_deepest_layer() {
        let error = UseCase::from(Persistence { source: Driver });

        assert_eq!(
            describe(&error),
            "persistence operation failed: driver refused the statement"
        );
        assert_eq!(root_cause(&error), "driver refused the statement");
    }

    #[test]
    fn a_leaf_error_renders_as_itself() {
        assert_eq!(chain(&Driver), vec!["driver refused the statement"]);
        assert_eq!(root_cause(&Driver), "driver refused the statement");
    }
}
