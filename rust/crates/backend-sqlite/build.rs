use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../..");
    let projection = root.join("packages/shared/src/db/rust-migrations.generated.json");
    println!("cargo:rerun-if-changed={}", projection.display());
    let plan: serde_json::Value =
        serde_json::from_slice(&fs::read(&projection).expect("generated migration projection"))
            .unwrap();
    for (path, hash) in plan["inputs"].as_object().unwrap() {
        let path = root.join(path);
        println!("cargo:rerun-if-changed={}", path.display());
        let actual: String = Sha256::digest(fs::read(&path).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(
            actual,
            hash.as_str().unwrap(),
            "shared migration input changed; run node scripts/generate-rust-migrations.mjs"
        );
    }
    let hooks: Vec<_> = plan["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|step| step["precondition"] == true)
        .map(|step| step["version"].as_u64().unwrap())
        .collect();
    assert_eq!(
        hooks,
        [53, 54, 71, 72, 76, 78, 79, 81, 87],
        "update native migration preconditions for changed shared plan"
    );
}
