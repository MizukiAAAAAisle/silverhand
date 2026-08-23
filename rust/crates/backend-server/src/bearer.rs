use axum::http::{HeaderMap, header::AUTHORIZATION};

pub(crate) fn strict_bearer_credential(headers: &HeaderMap) -> Option<&str> {
    let header = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let split = header.find(char::is_whitespace)?;
    let (scheme, credential) = header.split_at(split);
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let credential = credential.trim();
    (!credential.is_empty()).then_some(credential)
}
