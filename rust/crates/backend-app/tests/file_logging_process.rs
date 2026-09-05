use std::{fs, process::Command};

#[test]
fn both_profiles_persist_startup_errors_without_stdout_or_secret_leakage() {
    for profile in ["embedded", "remote-only"] {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        let output = Command::new(env!("CARGO_BIN_EXE_silverhand-backend"))
            .env_clear()
            .env("HOME", root.path())
            .env("SILVERHAND_DIR", root.path())
            .env("SILVERHAND_LOG_DIR", &logs)
            .env("SILVERHAND_DEPLOYMENT_PROFILE", profile)
            .env("SILVERHAND_STARTUP_GENERATION", "must-not-be-logged")
            // Missing mandatory database configuration is a startup refusal.
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let files: Vec<_> = fs::read_dir(&logs).unwrap().collect();
        assert_eq!(files.len(), 1);
        let file = fs::read(files[0].as_ref().unwrap().path()).unwrap();
        assert_eq!(file, output.stderr, "file and stderr share one formatter");
        let text = String::from_utf8(file).unwrap();
        assert!(!text.contains("must-not-be-logged"));
        let event: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(event["level"], "ERROR");
        assert!(event["fields"]["error_chain"].is_string());
        assert!(!root.path().join("silverhand.db").exists());
    }
}

#[test]
fn unusable_log_directory_fails_before_startup() {
    let root = tempfile::tempdir().unwrap();
    let not_directory = root.path().join("file");
    fs::write(&not_directory, "preserve").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_silverhand-backend"))
        .env_clear()
        .env("HOME", root.path())
        .env("SILVERHAND_DIR", root.path())
        .env("SILVERHAND_LOG_DIR", &not_directory)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("file logging initialization failed"));
    assert_eq!(fs::read_to_string(not_directory).unwrap(), "preserve");
}
