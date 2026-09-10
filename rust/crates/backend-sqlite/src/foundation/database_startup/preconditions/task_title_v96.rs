//! Frozen step96 contract, independent of current product validators.
//! Future title rules must use a new version rather than alter this migration.

pub(super) fn canonicalize(raw: &str) -> Result<String, &'static str> {
    let title = raw
        .split(|ch| {
            matches!(ch,
                '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
                '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
                '\u{205f}' | '\u{3000}' | '\u{feff}'
            )
        })
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() || title.encode_utf16().count() > 200 {
        return Err("step96: tasks.title cannot satisfy the canonical title contract");
    }
    Ok(title)
}
