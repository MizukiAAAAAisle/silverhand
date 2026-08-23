use std::{env, fs, path::PathBuf};

const TABLES: &[&str] = &[
    "NAME_RENDERABLE_RANGES",
    "NAME_DEFAULT_IGNORABLE_RANGES",
    "NAME_ENCLOSING_MARK_RANGES",
    "NAME_EMOJI_MODIFIER_RANGES",
    "NAME_REGIONAL_INDICATOR_RANGES",
];

fn main() {
    let shared =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../../packages/shared");
    let fold_authority = shared.join("tests/fixtures/unicode-case-fold.json");
    println!("cargo:rerun-if-changed={}", fold_authority.display());
    let fold_source = fs::read_to_string(&fold_authority).expect("read pinned case-fold authority");
    let fold: serde_json::Value =
        serde_json::from_str(&fold_source).expect("parse pinned case-fold authority");
    assert_eq!(fold["unicodeVersion"], "16.0.0");

    let authority = shared.join("src/unicode-name-charset.ts");
    println!("cargo:rerun-if-changed={}", authority.display());
    let source = fs::read_to_string(&authority).expect("read pinned name-character authority");
    assert!(
        source.contains("UNICODE_NAME_CHARSET_VERSION = '16.0.0'"),
        "review the Rust address parser when the pinned Unicode name domain changes"
    );

    let mut generated = String::from("// Generated from the shared pinned Unicode authority.\n");
    for name in TABLES {
        generated.push_str(&format!("pub const {name}: &[(u32, u32)] = &[\n"));
        let marker = format!("export const {name}:");
        let after_marker = source
            .split_once(&marker)
            .unwrap_or_else(|| panic!("missing {name}"))
            .1;
        let body = after_marker
            .split_once("= [")
            .unwrap_or_else(|| panic!("missing {name} array"))
            .1
            .split_once("];")
            .unwrap_or_else(|| panic!("unterminated {name} array"))
            .0;
        let mut count = 0;
        for line in body.lines() {
            let Some(open) = line.find("[0x") else {
                continue;
            };
            let pair = &line[open + 1..];
            let end = pair.find(']').expect("range must end");
            let mut values = pair[..end].split(',').map(str::trim);
            let first = values.next().expect("range start");
            let last = values.next().expect("range end");
            assert!(values.next().is_none(), "range must contain two values");
            generated.push_str(&format!("    ({first}, {last}),\n"));
            count += 1;
        }
        assert!(count > 0, "{name} must not be empty");
        generated.push_str("];\n");
    }
    generated.push_str("pub const CASE_FOLD: &[(char, &str)] = &[\n");
    let mut mappings: Vec<_> = fold["mappings"]
        .as_object()
        .expect("case-fold authority must have a mappings object")
        .iter()
        .collect();
    mappings.sort_by_key(|(from, _)| {
        u32::from_str_radix(from, 16).expect("case-fold key must be hexadecimal")
    });
    for (from, to) in mappings {
        let from = char::from_u32(
            u32::from_str_radix(from, 16).expect("case-fold key must be hexadecimal"),
        )
        .expect("case-fold key must name a Unicode scalar");
        let to: String = to
            .as_str()
            .expect("case-fold value must be a string")
            .split_whitespace()
            .map(|point| {
                char::from_u32(
                    u32::from_str_radix(point, 16).expect("case-fold value must be hexadecimal"),
                )
                .expect("case-fold value must name a Unicode scalar")
            })
            .collect();
        generated.push_str(&format!("    ({from:?}, {to:?}),\n"));
    }
    generated.push_str("];\n");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("name_charset.rs");
    fs::write(output, generated).expect("write generated name-character tables");
}
