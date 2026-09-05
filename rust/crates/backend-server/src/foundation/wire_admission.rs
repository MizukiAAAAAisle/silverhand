//! Shared wire-admission vocabulary for JSON write faces.
//!
//! Three things every JSON write route needs, written once so no endpoint re-rolls them:
//!
//!  * [`ObjectOnly<T>`] — a decode wrapper that forces the body to be a top-level JSON
//!    **object**. A serde-derived struct's `Deserialize` accepts BOTH a JSON map and a
//!    JSON *sequence* (it binds sequence elements to fields positionally), and
//!    `#[serde(deny_unknown_fields)]` only constrains map keys — it does NOT forbid a
//!    sequence. So a bare `T` silently admits `[]` (→ an all-default struct) or
//!    `["<value>"]` (→ first field bound positionally), which for a write DTO means a
//!    body-shaped-as-array can reach a create/claim/confirm authority. `ObjectOnly<T>`
//!    implements the single map-only `Deserialize` in the crate: it commits the
//!    deserializer to a map and hands that SAME [`MapAccess`] straight to `T::deserialize`
//!    (through serde's own [`MapAccessDeserializer`], which forwards the map to `T`'s
//!    visitor without re-entering this wrapper). Every native verdict of `T` survives
//!    verbatim — duplicate known key, the missing/null presence algebra, and per-DTO
//!    deny/strip-unknown — and the body is never routed through `serde_json::Value` (no
//!    last-wins). It is used TWO ways, and no leaf writes its own visitor:
//!      - wrapped inside [`ValidatedJson`] for the common extractor path, and
//!      - directly — `serde_json::from_slice::<ObjectOnly<T>>(bytes)`, or the thin
//!        [`from_object_slice`] over it — by the few routes that must keep a route-local
//!        decode order (an empty-body fast path, or a confirm gate decoded only on one
//!        branch).
//!  * [`ValidatedJson<T>`] — a `FromRequest` extractor that decodes the body with axum's
//!    native [`Json`] wrapping [`ObjectOnly<T>`] (so a malformed body, a wrong-typed
//!    field, a non-object top-level shape, and a missing `Content-Type` keep their native
//!    `400`/`422`/`415` rejections — the same typed [`JsonRejection`], not a re-rendered
//!    copy), then runs the type's `garde::Validate` and collapses ANY validation failure
//!    to the minimal semantic refusal [`invalid_input`] (`422 {"error":"invalid input"}`).
//!    The garde `Report` is deliberately never serialized — no endpoint publishes a
//!    validation-issue schema.
//!  * The garde adapters that stateless field rules delegate to. Each is a THIN
//!    delegate to the sole value-authority (never a second copy of the bound):
//!    [`patch_within_utf16_max`] → [`within_utf16_max`]. A resident test pins the
//!    adapter value-equivalent to the authority it wraps, so it can never drift into a
//!    second rule. (A numeric adapter delegating to `JsSafeInteger` follows the same
//!    shape; it is added beside the first integer-bearing field rather than landed
//!    here without a consumer.)
//!
//! garde lives ONLY here in the wire layer, not in `backend-core`: it is validation
//! FRAMEWORK glue, placed by its bounded context (wire admission), while the value
//! rules it calls stay pure in the domain crate.
//!
//! [`within_utf16_max`]: silverhand_backend_core::foundation::wire_text::within_utf16_max

use std::error::Error;
use std::fmt;
use std::marker::PhantomData;

use axum::{
    Json,
    extract::{FromRequest, Request, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use garde::Validate;
use serde::de::{DeserializeOwned, MapAccess, Visitor, value::MapAccessDeserializer};
use serde::{Deserialize, Deserializer};
use serde_json::json;
use silverhand_backend_core::foundation::wire_text;

use crate::foundation::{
    cli_invoke_observer::{CliInvokeResponseMeta, attach_response_meta},
    wire_patch::PatchField,
};

/// The one terminal semantic-refusal string, shared with the sibling write faces and
/// the ratified `PATCH /api/me` precedent. Validation never publishes its reasons.
const INVALID_INPUT: &str = "invalid input";

/// The minimal semantic-validation refusal: `422 {"error":"invalid input"}`. Structural
/// decode faults do NOT come here — they keep axum's native `Json` rejection.
pub(crate) fn invalid_input() -> Response {
    let response = (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({ "error": INVALID_INPUT })),
    )
        .into_response();
    attach_response_meta(response, CliInvokeResponseMeta::invalid_value())
}

/// The two planes on which `ValidatedJson` can refuse, kept as distinct TYPES so the
/// native decode rejection is forwarded intact rather than eagerly flattened:
///
///  * [`Json`](Self::Json) carries axum's own [`JsonRejection`] unchanged — its status,
///    body AND error source survive, because `IntoResponse` purely delegates to it and
///    [`Error::source`] hands back the inner rejection;
///  * [`Semantic`](Self::Semantic) is a stateless-rule failure, collapsed to the minimal
///    [`invalid_input`] envelope with the garde `Report` dropped.
#[derive(Debug)]
pub(crate) enum ValidatedJsonRejection {
    /// A structural decode fault; the native [`JsonRejection`] forwarded verbatim.
    Json(JsonRejection),
    /// A `garde::Validate` rule failure; the minimal semantic refusal.
    Semantic,
}

impl fmt::Display for ValidatedJsonRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ValidatedJsonRejection::Json(rejection) => fmt::Display::fmt(rejection, formatter),
            ValidatedJsonRejection::Semantic => formatter.write_str("input failed validation"),
        }
    }
}

impl Error for ValidatedJsonRejection {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            ValidatedJsonRejection::Json(rejection) => Some(rejection),
            ValidatedJsonRejection::Semantic => None,
        }
    }
}

impl IntoResponse for ValidatedJsonRejection {
    fn into_response(self) -> Response {
        match self {
            // Pure delegation: the native status/body/headers pass through untouched.
            ValidatedJsonRejection::Json(rejection) => {
                let metadata = CliInvokeResponseMeta::invalid_json(&rejection);
                attach_response_meta(rejection.into_response(), metadata)
            }
            ValidatedJsonRejection::Semantic => invalid_input(),
        }
    }
}

/// Forces a top-level JSON **object** before delegating to `T`.
///
/// A serde-derived struct decodes from a JSON sequence as readily as from a map — the
/// derive binds sequence elements to fields positionally, and `deny_unknown_fields` does
/// not forbid it. For a write DTO that is a security hole: `[]` yields an all-default
/// struct and `["<value>"]` binds the first field, so an array-shaped body can slip past
/// into a create/claim/confirm authority. `ObjectOnly<T>` closes that by implementing the
/// ONLY map-only `Deserialize` in the crate: `deserialize_map` commits the deserializer to
/// a map (a top-level array, scalar, or null is rejected by the deserializer itself as an
/// "invalid type" data fault → a native `JsonDataError`/422 under axum `Json`, before
/// `visit_map` is entered), then it hands the SAME [`MapAccess`] to `T::deserialize`
/// through serde's [`MapAccessDeserializer`]. That deserializer forwards the map to `T`'s
/// own visitor (`deserialize_struct`/`deserialize_map` forward to `visit_map(self.map)`),
/// so it never re-enters this wrapper — every native verdict of `T` is preserved unchanged
/// (duplicate known key, missing/null algebra, per-DTO deny/strip-unknown) and the body is
/// never routed through `serde_json::Value` (which would collapse duplicates last-wins).
///
/// Leaves never write their own visitor: wrap `T` here, either inside [`ValidatedJson`] or
/// by decoding `serde_json::from_slice::<ObjectOnly<T>>(bytes)` (or the thin
/// [`from_object_slice`] over it) directly where a route must keep its own decode ordering.
pub(crate) struct ObjectOnly<T>(pub(crate) T);

impl<'de, T> Deserialize<'de> for ObjectOnly<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct MapOnly<T>(PhantomData<T>);

        impl<'de, T> Visitor<'de> for MapOnly<T>
        where
            T: Deserialize<'de>,
        {
            type Value = ObjectOnly<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                T::deserialize(MapAccessDeserializer::new(map)).map(ObjectOnly)
            }
        }

        deserializer.deserialize_map(MapOnly(PhantomData))
    }
}

/// Decode `T` from a JSON slice as a top-level object, via [`ObjectOnly<T>`].
///
/// A thin ergonomic delegate for the direct-decode routes (an empty-body fast path, or a
/// confirm gate decoded only on one branch): it is exactly
/// `serde_json::from_slice::<ObjectOnly<T>>(bytes)` unwrapped, so the object-only guarantee
/// and every `T` verdict hold identically, the decode is single-pass, and the error type
/// stays `serde_json::Error` — the caller's existing mapping into its route rejection is
/// unchanged. No leaf re-rolls this gate.
pub(crate) fn from_object_slice<T>(bytes: &[u8]) -> Result<T, serde_json::Error>
where
    T: DeserializeOwned,
{
    serde_json::from_slice::<ObjectOnly<T>>(bytes).map(|ObjectOnly(value)| value)
}

/// Decode `T` with native [`Json`], then enforce its `garde::Validate` rules.
///
/// The body is decoded through [`ObjectOnly<T>`], so a top-level non-object shape is a
/// native decode fault, never a positional bind, and the content-type gate, body read, and
/// decode all stay axum's native machinery. The two failure planes stay distinct on the
/// wire (see [`ValidatedJsonRejection`]):
///  * a structural fault (bad JSON, wrong field type, non-object shape, missing
///    `Content-Type`) forwards the native [`JsonRejection`] unchanged — the extractor
///    never rewrites it;
///  * a stateless-rule fault collapses to [`invalid_input`], the garde `Report` dropped.
pub(crate) struct ValidatedJson<T>(pub(crate) T);

impl<T, S> FromRequest<S> for ValidatedJson<T>
where
    T: DeserializeOwned + Validate<Context = ()>,
    S: Send + Sync,
{
    type Rejection = ValidatedJsonRejection;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let Json(ObjectOnly(value)) = Json::<ObjectOnly<T>>::from_request(req, state)
            .await
            .map_err(ValidatedJsonRejection::Json)?;
        match value.validate() {
            Ok(()) => Ok(ValidatedJson(value)),
            Err(_report) => Err(ValidatedJsonRejection::Semantic),
        }
    }
}

// ===========================================================================
// Shared garde adapters — thin delegates to the backend-core value authorities.
// ===========================================================================

/// A garde field rule bounding a [`PatchField<String>`] to `max` UTF-16 code units.
///
/// It delegates the count and the comparison to [`within_utf16_max`], the sole shared
/// primitive — it holds no length logic of its own. `Missing`/`Null` carry no value to
/// bound and always pass; the arm-to-edit mapping is the route's `TryFrom`, not here.
///
/// [`within_utf16_max`]: silverhand_backend_core::foundation::wire_text::within_utf16_max
pub(crate) fn patch_within_utf16_max(
    max: usize,
) -> impl Fn(&PatchField<String>, &()) -> garde::Result {
    move |field, _| match field {
        PatchField::Value(value) if !wire_text::within_utf16_max(value, max) => {
            Err(garde::Error::new("string is too long"))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use axum::{
        Router,
        body::Body,
        extract::State,
        http::{Request as HttpRequest, StatusCode, header},
        routing::post,
    };
    use serde::Deserialize;
    use tower::ServiceExt;

    use super::*;

    #[test]
    fn utf16_adapter_delegates_to_the_shared_primitive_value_for_value() {
        let bound_two = patch_within_utf16_max(2);
        // The adapter's verdict must equal `within_utf16_max` on the carried value for
        // every `Value`, and must pass unconditionally for the value-less arms.
        for probe in ["", "a", "ab", "abc", "😀", "😀😀"] {
            let via_adapter = bound_two(&PatchField::Value(probe.to_owned()), &()).is_ok();
            let via_authority = wire_text::within_utf16_max(probe, 2);
            assert_eq!(via_adapter, via_authority, "drift on {probe:?}");
        }
        assert!(bound_two(&PatchField::Missing, &()).is_ok());
        assert!(bound_two(&PatchField::Null, &()).is_ok());
    }

    // A minimal body carrying one bounded PatchField, enough to exercise both failure
    // planes of the extractor without a real route.
    #[derive(Debug, Deserialize, Validate)]
    struct Probe {
        #[serde(default)]
        #[garde(custom(patch_within_utf16_max(3)))]
        label: PatchField<String>,
    }

    async fn probe_handler(
        State(reached): State<Arc<AtomicBool>>,
        ValidatedJson(_body): ValidatedJson<Probe>,
    ) -> StatusCode {
        reached.store(true, Ordering::SeqCst);
        StatusCode::OK
    }

    struct Outcome {
        status: StatusCode,
        content_type: Option<String>,
        body: String,
        handler_reached: bool,
    }

    async fn run(request: HttpRequest<Body>) -> Outcome {
        let reached = Arc::new(AtomicBool::new(false));
        let app = Router::new()
            .route("/", post(probe_handler))
            .with_state(reached.clone());
        let response = app.oneshot(request).await.expect("router responds");
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .map(|value| value.to_str().expect("ascii content-type").to_owned());
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body collects");
        Outcome {
            status,
            content_type,
            body: String::from_utf8(bytes.to_vec()).expect("utf8 body"),
            handler_reached: reached.load(Ordering::SeqCst),
        }
    }

    fn json_request(body: &'static str) -> HttpRequest<Body> {
        HttpRequest::builder()
            .method("POST")
            .uri("/")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .expect("request builds")
    }

    const SEMANTIC_BODY: &str = r#"{"error":"invalid input"}"#;

    #[tokio::test]
    async fn valid_body_reaches_the_handler() {
        let outcome = run(json_request(r#"{"label":"ok"}"#)).await;
        assert_eq!(outcome.status, StatusCode::OK);
        assert!(outcome.handler_reached);
    }

    #[tokio::test]
    async fn malformed_json_keeps_the_native_400_and_never_reaches_the_handler() {
        let outcome = run(json_request("not json")).await;
        assert_eq!(outcome.status, StatusCode::BAD_REQUEST);
        assert!(!outcome.handler_reached);
        // Native rejection, not our semantic envelope.
        assert_ne!(outcome.body, SEMANTIC_BODY);
    }

    #[tokio::test]
    async fn wrong_field_type_keeps_the_native_422_and_never_reaches_the_handler() {
        let outcome = run(json_request(r#"{"label":123}"#)).await;
        assert_eq!(outcome.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!outcome.handler_reached);
        assert_ne!(outcome.body, SEMANTIC_BODY);
    }

    #[tokio::test]
    async fn a_duplicate_known_key_keeps_the_native_rejection_and_never_reaches_the_handler() {
        // A syntactically valid body that REPEATS a known field. serde's derived
        // `Deserialize` rejects the duplicate as a DATA fault, so the native `Json`
        // rejection stands — the extractor never rewrites it to the semantic envelope,
        // and the handler is never entered. Status is the native serde classification
        // (422 today); we pin the class + zero-reach + non-semantic body, not the text.
        let outcome = run(json_request(r#"{"label":"a","label":"b"}"#)).await;
        assert_eq!(outcome.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!outcome.handler_reached);
        assert_ne!(outcome.body, SEMANTIC_BODY);
    }

    #[tokio::test]
    async fn a_top_level_empty_array_is_a_native_reject_and_never_reaches_the_handler() {
        // An empty array would decode into an ALL-DEFAULT struct under a bare derive
        // (every field takes its `#[serde(default)]`), silently admitting a body of the
        // wrong shape. `ObjectOnly` forces a map, so the native `Json` layer rejects it as
        // a data fault, the handler is never reached, and it is not our semantic envelope.
        let outcome = run(json_request(r#"[]"#)).await;
        assert_eq!(outcome.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!outcome.handler_reached);
        assert_ne!(outcome.body, SEMANTIC_BODY);
    }

    #[tokio::test]
    async fn a_value_shaped_top_level_array_is_a_native_reject_and_never_reaches_the_handler() {
        // The sharp discriminator: `["ok"]` is a single-element array whose element is a
        // VALID value for the struct's first field. A bare derive binds it positionally
        // (`label = Value("ok")`), passes garde, and reaches the handler — the exact
        // array-shaped-body bypass. `ObjectOnly` rejects it structurally before decode, so
        // the handler is never entered and the refusal is the native (non-semantic) one.
        let outcome = run(json_request(r#"["ok"]"#)).await;
        assert_eq!(outcome.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!outcome.handler_reached);
        assert_ne!(outcome.body, SEMANTIC_BODY);
    }

    #[tokio::test]
    async fn a_top_level_scalar_is_a_native_reject_and_never_reaches_the_handler() {
        let outcome = run(json_request(r#"42"#)).await;
        assert_eq!(outcome.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!outcome.handler_reached);
        assert_ne!(outcome.body, SEMANTIC_BODY);
    }

    #[tokio::test]
    async fn missing_content_type_keeps_the_native_415_and_never_reaches_the_handler() {
        let request = HttpRequest::builder()
            .method("POST")
            .uri("/")
            .body(Body::from(r#"{"label":"ok"}"#))
            .expect("request builds");
        let outcome = run(request).await;
        assert_eq!(outcome.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(!outcome.handler_reached);
        assert_ne!(outcome.body, SEMANTIC_BODY);
    }

    #[tokio::test]
    async fn garde_failure_is_the_minimal_422_and_never_reaches_the_handler() {
        // "toolong" is 7 UTF-16 units > the probe bound of 3.
        let outcome = run(json_request(r#"{"label":"toolong"}"#)).await;
        assert_eq!(outcome.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!outcome.handler_reached);
        // Exact minimal body; the garde Report is never leaked.
        assert_eq!(outcome.body, SEMANTIC_BODY);
        assert_eq!(
            outcome.content_type.as_deref(),
            Some("application/json"),
            "semantic refusal is JSON"
        );
    }

    #[tokio::test]
    async fn rejection_preserves_the_native_typed_source_but_drops_it_for_semantic() {
        // Structural fault: the rejection is the typed `Json` arm and keeps a source
        // chain to the inner `JsonRejection`.
        let Err(structural) =
            ValidatedJson::<Probe>::from_request(json_request("not json"), &()).await
        else {
            panic!("malformed body is rejected");
        };
        assert!(matches!(structural, ValidatedJsonRejection::Json(_)));
        assert!(
            Error::source(&structural).is_some(),
            "native rejection stays reachable as the error source"
        );
        assert_eq!(structural.into_response().status(), StatusCode::BAD_REQUEST);

        // Semantic fault: no inner source, minimal 422.
        let Err(semantic) =
            ValidatedJson::<Probe>::from_request(json_request(r#"{"label":"toolong"}"#), &()).await
        else {
            panic!("over-long label is rejected");
        };
        assert!(matches!(semantic, ValidatedJsonRejection::Semantic));
        assert!(Error::source(&semantic).is_none());
        assert_eq!(
            semantic.into_response().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    // ---- ObjectOnly at the serde layer, for the direct-decode consumers ----
    //
    // A few routes cannot go through `ValidatedJson`: they keep a route-local decode
    // order (an empty-body fast path, or a confirm gate decoded only on one branch) and
    // call `serde_json::from_slice::<ObjectOnly<T>>` themselves (or the thin
    // `from_object_slice` over it), so the object-only guarantee holds identically there.
    // These pin the wrapper directly.

    // Mirrors an all-default consent DTO (#2240): every field optional, so a bare derive
    // decodes `[]` into an all-Absent value — a body-shaped-as-array reaching the route.
    #[derive(Debug, Default, Deserialize, Eq, PartialEq)]
    #[serde(default, deny_unknown_fields)]
    struct AllDefault {
        note: Option<String>,
    }

    // Mirrors a destructive-confirm DTO (#2241): `[true]` binds `confirm` positionally
    // under a bare derive, silently crossing the consent gate.
    #[derive(Debug, Default, Deserialize, Eq, PartialEq)]
    #[serde(default, deny_unknown_fields)]
    struct ConfirmLike {
        confirm: bool,
    }

    // A STRIP-unknown derive (no `deny_unknown_fields`): unknown keys are silently
    // dropped. This is the arm that must decode cleanly through the wrapper's
    // `MapAccessDeserializer` hand-off — the object shape is preserved and unknowns strip.
    #[derive(Debug, Default, Deserialize, Eq, PartialEq)]
    #[serde(default)]
    struct StripUnknown {
        label: Option<String>,
    }

    #[test]
    fn a_bare_derive_admits_arrays_which_is_the_bug_object_only_closes() {
        // Documents the exact serde behavior `ObjectOnly` exists to defeat: WITHOUT the
        // wrapper, both an empty and a value-shaped array decode successfully.
        assert_eq!(
            serde_json::from_str::<AllDefault>(r#"[]"#).unwrap(),
            AllDefault { note: None }
        );
        assert_eq!(
            serde_json::from_str::<ConfirmLike>(r#"[true]"#).unwrap(),
            ConfirmLike { confirm: true }
        );
    }

    #[test]
    fn object_only_rejects_arrays_for_a_direct_consumer() {
        // The same two arrays, wrapped, are structural decode faults — never a value.
        assert!(serde_json::from_slice::<ObjectOnly<AllDefault>>(b"[]").is_err());
        assert!(serde_json::from_slice::<ObjectOnly<ConfirmLike>>(b"[true]").is_err());
        // A scalar and a null are rejected too.
        assert!(serde_json::from_slice::<ObjectOnly<ConfirmLike>>(b"true").is_err());
        assert!(serde_json::from_slice::<ObjectOnly<ConfirmLike>>(b"null").is_err());
    }

    #[test]
    fn object_only_admits_objects_and_preserves_every_inner_t_verdict() {
        // A valid object still decodes, with the inner value intact.
        let confirmed =
            serde_json::from_slice::<ObjectOnly<ConfirmLike>>(br#"{"confirm":true}"#).unwrap();
        assert_eq!(confirmed.0, ConfirmLike { confirm: true });
        // Empty object → the inner default (proves the wrapper requires no key of its own).
        let empty = serde_json::from_slice::<ObjectOnly<AllDefault>>(b"{}").unwrap();
        assert_eq!(empty.0, AllDefault { note: None });
        // A strip-unknown derive decodes through the wrapper and drops the unknown key —
        // the object shape and the strip policy both survive the `MapAccessDeserializer`
        // hand-off (no recursion, no re-entry into the wrapper's own visitor).
        let stripped =
            serde_json::from_slice::<ObjectOnly<StripUnknown>>(br#"{"label":"ok","surprise":1}"#)
                .unwrap();
        assert_eq!(
            stripped.0,
            StripUnknown {
                label: Some("ok".to_owned())
            }
        );
        // Inner `deny_unknown_fields` still fires (the map reaches `T` unchanged).
        assert!(serde_json::from_slice::<ObjectOnly<ConfirmLike>>(br#"{"nope":1}"#).is_err());
        // A duplicate known key is still rejected by the inner derive — proof the body is
        // NOT routed through `serde_json::Value` (which would silently take last-wins).
        assert!(
            serde_json::from_slice::<ObjectOnly<ConfirmLike>>(
                br#"{"confirm":true,"confirm":false}"#
            )
            .is_err()
        );
        // Wrong field type inside the object is still the inner type's decode error.
        assert!(
            serde_json::from_slice::<ObjectOnly<ConfirmLike>>(br#"{"confirm":"yes"}"#).is_err()
        );
    }

    #[test]
    fn from_object_slice_is_the_thin_unwrapped_delegate() {
        // The ergonomic fn is exactly `from_slice::<ObjectOnly<T>>` unwrapped: same reject
        // set, same accept, single pass.
        assert!(from_object_slice::<ConfirmLike>(b"[true]").is_err());
        assert!(from_object_slice::<ConfirmLike>(b"true").is_err());
        assert_eq!(
            from_object_slice::<ConfirmLike>(br#"{"confirm":true}"#).unwrap(),
            ConfirmLike { confirm: true }
        );
    }
}
