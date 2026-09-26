use std::{env, fs, path::PathBuf};

use serde_json::Value;

#[path = "build_support/composition_check.rs"]
mod composition_check;

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    println!("cargo:rerun-if-changed=build_support/composition_check.rs");
    // #task:2265 — the composition semantic-door checker (replaces the former
    // include_str! + string-count gate). A violation fails this build with the offending
    // symbol and its enclosing function.
    composition_check::check(&manifest.join("src"));

    let contract = manifest.join("../../../packages/shared/src/backend-migration-plan.json");
    println!("cargo:rerun-if-changed={}", contract.display());
    let source = fs::read_to_string(&contract).expect("read shared migration-plan authority");
    let contract: Value = serde_json::from_str(&source).expect("parse migration-plan authority");
    let baseline = contract["baselineStep"]
        .as_u64()
        .expect("migration baseline step must be an unsigned integer");
    let current = contract["currentStep"]
        .as_u64()
        .expect("current migration step must be an unsigned integer");
    let steps = contract["activeSteps"]
        .as_array()
        .expect("active migration steps must be an array")
        .iter()
        .map(|step| {
            step.as_u64()
                .expect("migration step must be an unsigned integer")
        })
        .collect::<Vec<_>>();
    assert_eq!(steps.first().copied(), Some(baseline));
    assert_eq!(steps.last().copied(), Some(current));
    assert!(steps.windows(2).all(|pair| pair[0] < pair[1]));
    println!(
        "cargo:rustc-env=SILVERHAND_MIGRATION_STEPS={}",
        steps
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",")
    );
}
