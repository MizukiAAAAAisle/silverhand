//! Shared wire-admission vocabulary for JSON write faces.
//!
//! Two things every JSON write route needs, written once so no endpoint re-rolls them:
//!
//!  * [`ValidatedJson<T>`] — a `FromRequest` extractor that decodes the body with
//!    axum's native [`Json`] (so a malformed body, a wrong-typed field, and a missing
//!    `Content-Type` keep their native `400`/`422`/`415` rejections verbatim — the same
//!    typed [`JsonRejection`], not a re-rendered copy), then runs the type's
//!    `garde::Validate` and collapses ANY validation failure to the minimal semantic
//!    refusal [`invalid_input`] (`422 {"error":"invalid input"}`). The garde `Report` is
//!    deliberately never serialized — no endpoint publishes a validation-issue schema.
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
//! [`within_utf16_max`]: silverhand_backend_core::wire_text::within_utf16_max

use std::error::Error;
use std::fmt;

use axum::{
    Json,
    extract::{FromRequest, Request, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use garde::Validate;
use serde::de::DeserializeOwned;
use serde_json::json;
use silverhand_backend_core::wire_text;

use crate::wire_patch::PatchField;

/// The one terminal semantic-refusal string, shared with the sibling write faces and
/// the ratified `PATCH /api/me` precedent. Validation never publishes its reasons.
const INVALID_INPUT: &str = "invalid input";

/// The minimal semantic-validation refusal: `422 {"error":"invalid input"}`. Structural
/// decode faults do NOT come here — they keep axum's native `Json` rejection.
pub(crate) fn invalid_input() -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({ "error": INVALID_INPUT })),
    )
        .into_response()
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
            ValidatedJsonRejection::Json(rejection) => rejection.into_response(),
            ValidatedJsonRejection::Semantic => invalid_input(),
        }
    }
}

/// Decode `T` with native [`Json`], then enforce its `garde::Validate` rules.
///
/// The two failure planes stay distinct on the wire (see [`ValidatedJsonRejection`]):
///  * a structural fault (bad JSON, wrong field type, missing `Content-Type`) forwards
///    the native [`JsonRejection`] unchanged — the extractor never rewrites it;
///  * a stateless-rule fault collapses to [`invalid_input`], the garde `Report` dropped.
pub(crate) struct ValidatedJson<T>(pub(crate) T);

impl<T, S> FromRequest<S> for ValidatedJson<T>
where
    T: DeserializeOwned + Validate<Context = ()>,
    S: Send + Sync,
{
    type Rejection = ValidatedJsonRejection;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let Json(value) = Json::<T>::from_request(req, state)
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
/// [`within_utf16_max`]: silverhand_backend_core::wire_text::within_utf16_max
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
    async fn a_top_level_array_keeps_the_native_object_shape_rejection_and_never_reaches_the_handler()
     {
        // A well-formed JSON value of the wrong SHAPE — a top-level array, not the
        // expected object. This is the object-shape native rejection (distinct from a
        // wrong-typed field INSIDE an object): the native `Json` layer classifies it, the
        // handler is never reached, and it is not our semantic envelope.
        let outcome = run(json_request(r#"[1, 2]"#)).await;
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
}
