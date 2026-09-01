//! Shared Markdown interpolation primitives for agent-facing stored prose.

/// Renders free text as a single-line CommonMark code span.
///
/// Line separators collapse to spaces and the delimiter is longer than every
/// backtick run in the value. This is the one authority used by mention copies
/// and workspace rename announcements.
pub fn inline_code(value: &str) -> String {
    let single_line = collapse_line_breaks(value);
    let longest_run = single_line
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    if longest_run == 0 {
        return format!("`{single_line}`");
    }
    let delimiter = "`".repeat(longest_run + 1);
    format!("{delimiter} {single_line} {delimiter}")
}

fn collapse_line_breaks(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_break = false;
    for character in value.chars() {
        if matches!(
            character,
            '\r' | '\n' | '\u{2028}' | '\u{2029}' | '\u{0085}'
        ) {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            in_break = false;
            out.push(character);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_breaks_and_backtick_runs_cannot_escape_the_span() {
        assert_eq!(inline_code("one\ntwo\u{2028}three"), "`one two three`");
        assert_eq!(inline_code("a``b"), "``` a``b ```");
        assert_eq!(inline_code("`"), "`` ` ``");
    }
}
