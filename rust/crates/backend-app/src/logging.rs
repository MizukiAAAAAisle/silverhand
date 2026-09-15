//! Process-owned diagnostic output shared by embedded and standalone startup.
//! Use the existing redacting formatter once, then tee its bytes to file/stderr.
use std::{env, io, path::Path};
use tracing_appender::{
    non_blocking::{NonBlocking, NonBlockingBuilder, WorkerGuard},
    rolling::{RollingFileAppender, Rotation},
};

pub(super) fn open_from_env() -> io::Result<(NonBlocking, WorkerGuard)> {
    let directory = env::var_os("SILVERHAND_LOG_DIR")
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .ok_or_else(|| io::Error::other("SILVERHAND_LOG_DIR is required"))?;
    open(Path::new(&directory))
}

fn open(directory: &Path) -> io::Result<(NonBlocking, WorkerGuard)> {
    // The appender's initial retention scan expects the directory to exist.
    std::fs::create_dir_all(directory)?;
    let file = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("rust-backend")
        .filename_suffix("log")
        .max_log_files(14)
        .build(directory)
        .map_err(io::Error::other)?;
    // Bounded queue with backpressure, not silent dropping under load. Ordinary
    // request threads do not perform filesystem I/O while the queue has room.
    Ok(NonBlockingBuilder::default()
        .buffered_lines_limit(4096)
        .lossy(false)
        .thread_name("backend-log-writer")
        .finish(file))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn guard_drains_to_file_and_restart_appends() {
        let directory = tempfile::tempdir().unwrap();
        for line in ["first\n", "second\n"] {
            let (mut writer, guard) = open(directory.path()).unwrap();
            writer.write_all(line.as_bytes()).unwrap();
            drop(guard);
        }
        let files: Vec<_> = std::fs::read_dir(directory.path()).unwrap().collect();
        assert_eq!(files.len(), 1);
        let content = std::fs::read_to_string(files[0].as_ref().unwrap().path()).unwrap();
        assert_eq!(content, "first\nsecond\n");
    }

    #[test]
    fn invalid_directory_refuses_startup() {
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(open(file.path()).is_err());
    }

    #[test]
    fn file_uses_the_existing_redaction_contract() {
        use silverhand_backend_app::production_json_layer;
        use silverhand_backend_server::{
            conversation_messaging::messaging::collaboration::conversation_log_debug::ProductionConversationLogDebugControl,
            foundation::{clock::SystemProcessClock, safe_log_field::safe_display},
        };
        use tracing_subscriber::{EnvFilter, layer::SubscriberExt};

        let directory = tempfile::tempdir().unwrap();
        let (writer, guard) = open(directory.path()).unwrap();
        let subscriber = tracing_subscriber::registry().with(production_json_layer(
            EnvFilter::new("error"),
            ProductionConversationLogDebugControl::process(),
            SystemProcessClock,
            writer,
        ));
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(
                env_token = "secret-marker",
                error_chain = safe_display("test failure"),
                cause = %std::io::Error::from_raw_os_error(24),
                "accept error: {}", std::io::Error::from_raw_os_error(24)
            );
        });
        drop(guard);
        let path = std::fs::read_dir(directory.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let text = std::fs::read_to_string(path).unwrap();
        assert!(!text.contains("secret-marker"));
        let event: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(event["fields"]["error_chain"], "test failure");
        let cause = std::io::Error::from_raw_os_error(24).to_string();
        assert_eq!(event["fields"]["cause"], cause);
        assert_eq!(event["fields"]["message"], format!("accept error: {cause}"));
        assert!(event["fields"]["redactedFieldCount"].as_u64().unwrap() > 0);
    }
}
