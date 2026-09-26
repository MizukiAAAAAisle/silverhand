//! Request-boundary admission for the two internal agent-profile WRITES —
//! `POST /internal/agents/{aid}/profile` (text + optional avatar, one multipart)
//! and `POST /internal/agents/{aid}/avatar` (avatar only). This checkpoint owns
//! ONLY the transport decode and the request algebra: it turns a multipart body
//! into either a fully validated request value or a terminal refusal, and never
//! writes a row, stores a blob, or announces anything.
//!
//! ## What lives here, and what deliberately does not
//!
//! The self-pin credential layer
//! ([`require_runtime_credential`](crate::host_runtime::runtime_credential::require_runtime_credential))
//! already bound `{aid}` to the caller's own agent before any of this runs, so the
//! product's `agent id required` / `404` / `403` ladder collapses upstream to a
//! single indistinguishable `401`. Everything below is therefore body-level only.
//!
//! The validated-request types ([`ValidatedAvatar`], [`ValidatedProfileEdit`])
//! express ONLY an admitted request: no committed-fact, storage pointer, row
//! witness, blob-cleanup fate, or announce outcome. Those belong to the write unit
//! of work — a later checkpoint that consumes #2225's canonical agents-row write,
//! agent-avatar blob authority, and committed-fact/pointer shapes directly. This
//! module defines no write/blob port and drives no fake orchestration; a
//! [`ValidatedProfileEdit`] is the whole edit as ONE atomic value (text updates and
//! the single avatar action together), not the product's two-write sequence.
//!
//! `DELETE /internal/agents/{aid}/avatar` carries no body, so it needs no request
//! admission at all — its only ladder is the layer's, and its clear/no-op algebra
//! is the write UoW's.
//!
//! ## Reused authorities
//!
//! Size + declared-MIME validation is [`validate_avatar`] (the closed allowlist,
//! the `5 MiB` cap, the empty→too-large→unsupported order); `display_name`
//! validation is [`DisplayName::parse`] (`trim → 1..=64 UTF-16 units → no
//! control/line-separator chars`, byte-for-byte the product's `DisplayNameSchema`).
//! This module mints no second copy of either rule.

use axum::{
    Json,
    extract::{FromRequest, Multipart, Request, multipart::Field},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use silverhand_backend_core::{
    identity_access::avatar::{
        AVATAR_MAX_BYTES, AvatarContentType, AvatarRejection, validate_avatar,
    },
    identity_access::user_identity::DisplayName,
};

use crate::foundation::multipart_transport::{accumulate_capped, declared_content_type, drain};

/// The maximum `description` length in UTF-16 code units — the product's
/// `z.string().max(2000)`. Distinct from the display-name bound: no trim, and an
/// empty string is a valid (clear-to-empty) value.
pub const DESCRIPTION_MAX_UTF16: usize = 2000;

// ===========================================================================
// Validated-request types — a validated request, nothing more.
// ===========================================================================

/// A validated `description` field: at most [`DESCRIPTION_MAX_UTF16`] UTF-16 code
/// units, untrimmed, empty permitted. An ADMISSION type only — it is the shape of a
/// validated request field, never the committed row's column (that is #2225's).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileDescription(String);

impl ProfileDescription {
    /// Validate a raw form value. Length is counted in UTF-16 code units, matching
    /// the product's `z.string().max(2000)` (JS `String.length`); the value is
    /// stored verbatim, with no trimming.
    pub fn parse(raw: &str) -> Option<Self> {
        (raw.encode_utf16().count() <= DESCRIPTION_MAX_UTF16).then(|| Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Client-declared avatar bytes that PASSED size + declared-MIME admission. Carries
/// the validated content type and the buffered bytes; it holds no storage pointer
/// and no row witness. The write unit of work (a later checkpoint) is what turns
/// this into a stored blob and a repointed row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedAvatar {
    bytes: Vec<u8>,
    content_type: AvatarContentType,
}

impl ValidatedAvatar {
    pub fn content_type(&self) -> AvatarContentType {
        self.content_type
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// What a validated profile edit does to the avatar, as ONE decision: leave it
/// untouched (no `avatar_action` field), clear it, or set it to validated bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AvatarAction {
    Leave,
    Clear,
    Set(ValidatedAvatar),
}

/// A validated `POST /profile` edit — the fields that passed admission, as ONE
/// atomic request value. `None` on a text field means "unchanged" (the field was
/// absent from the form); `Some` means "set to this validated value" (an empty
/// description included). Fields are private with a sole producer
/// ([`admit_profile_edit`]), so the "at least one field to update" invariant — the
/// product's `no fields to update` guard, enforced during admission — can never be
/// bypassed by constructing an empty edit. No committed-fact, pointer, cleanup, or
/// announce lives here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedProfileEdit {
    display_name: Option<DisplayName>,
    description: Option<ProfileDescription>,
    avatar: AvatarAction,
}

impl ValidatedProfileEdit {
    pub fn display_name(&self) -> Option<&DisplayName> {
        self.display_name.as_ref()
    }

    pub fn description(&self) -> Option<&ProfileDescription> {
        self.description.as_ref()
    }

    pub fn avatar(&self) -> &AvatarAction {
        &self.avatar
    }
}

// ===========================================================================
// Refusals — the body-level ladder (the credential ladder is the layer's).
// ===========================================================================

/// Every way write admission can refuse before any write/blob effect. The
/// credential/`{aid}` verdict is NOT here — a non-self caller is a `401` from the
/// self-pin layer, upstream of this module.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProfileAdmissionRefusal {
    /// The body was not a parseable `multipart/form-data` stream — the product's
    /// `c.req.formData()` throw.
    MultipartRequired,
    /// No `file` part, or the first `file` entry is not a `File` — the avatar-only
    /// route's `!(file instanceof File)` refusal.
    FileFieldRequired,
    /// `avatar_action` was present but not `"set"` or `"clear"`.
    InvalidAvatarAction,
    /// Neither a text field nor an avatar action was supplied.
    NothingToUpdate,
    /// A text field failed its schema (`display_name` or `description`). The
    /// product returns a Zod `issues` array alongside; this lane serves the stable
    /// `{ error }` and drops the volatile issue list.
    InvalidText,
    /// `avatar_action` was `"set"` but no `File` part accompanied it.
    FileFieldRequiredForSet,
    /// The avatar payload failed size/declared-MIME validation.
    Avatar(AvatarRejection),
}

/// The `{ error }` refusal body (the transport/algebra string refusals).
#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

/// The `{ error, code }` refusal body the avatar validation faults use.
#[derive(Serialize)]
struct ErrorCodeBody {
    error: &'static str,
    code: &'static str,
}

impl IntoResponse for ProfileAdmissionRefusal {
    fn into_response(self) -> Response {
        match self {
            Self::MultipartRequired => bad_request("multipart/form-data required"),
            Self::FileFieldRequired => bad_request("file field required"),
            Self::InvalidAvatarAction => bad_request("avatar_action must be \"set\" or \"clear\""),
            Self::NothingToUpdate => bad_request("no fields to update"),
            Self::InvalidText => bad_request("invalid input"),
            Self::FileFieldRequiredForSet => {
                bad_request("file field required for avatar_action=set")
            }
            Self::Avatar(rejection) => {
                let status = match rejection {
                    AvatarRejection::Empty => StatusCode::BAD_REQUEST,
                    AvatarRejection::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
                    AvatarRejection::UnsupportedType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
                };
                (
                    status,
                    Json(ErrorCodeBody {
                        error: rejection.message(),
                        code: rejection.code(),
                    }),
                )
                    .into_response()
            }
        }
    }
}

fn bad_request(error: &'static str) -> Response {
    (StatusCode::BAD_REQUEST, Json(ErrorBody { error })).into_response()
}

// ===========================================================================
// Admission entry points.
// ===========================================================================

/// Admit a standalone `POST /internal/agents/{aid}/avatar`. Consumes the multipart
/// `file` part and validates its size + declared MIME. On success the caller holds
/// a [`ValidatedAvatar`] and NOTHING has been stored.
///
/// The WHOLE envelope is consumed to true EOF, mirroring TS's `await c.req.formData()`
/// (which parses every part before `form.get('file')` is read): the first `file`-named
/// part wins — File or not, like `form.get('file')` — and every remaining part is
/// chunk-drained with zero accumulation. A malformed/truncated trailing part therefore
/// still surfaces as the terminal `multipart/form-data required` 400 BEFORE any
/// candidate is validated or stored — an envelope-parse fault outranks both the
/// size/MIME `validate_candidate` verdict and `file field required`, exactly as the
/// `formData()` throw precedes `form.get` in the product.
pub async fn admit_avatar_upload(
    request: Request,
) -> Result<ValidatedAvatar, ProfileAdmissionRefusal> {
    let mut multipart = Multipart::from_request(request, &())
        .await
        .map_err(|_| ProfileAdmissionRefusal::MultipartRequired)?;

    // `Some(Some(_))` = a first `file`-named File captured; `Some(None)` = a first
    // `file`-named plain part (present but not a `File` → `file field required`, like
    // `form.get('file') instanceof File`); `None` = no `file` part seen yet.
    let mut file_slot: Option<Option<UploadedFile>> = None;
    loop {
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return Err(ProfileAdmissionRefusal::MultipartRequired),
        };
        // Snapshot the discriminators so the field can be moved into a consuming read
        // below without holding a borrow across the match.
        let name = field.name().map(str::to_owned);
        let is_file = field.file_name().is_some();
        match name.as_deref() {
            Some("file") if file_slot.is_none() => {
                if is_file {
                    let content_type = declared_content_type(&field);
                    // Stops at the cap + 1; the field's remaining chunks (if any) are
                    // driven off the stream by the next `next_field()`, so an oversize
                    // candidate never lets a later envelope fault slip past unseen.
                    let bytes = accumulate_capped(&mut field, AVATAR_MAX_BYTES as usize + 1)
                        .await
                        .map_err(|_| ProfileAdmissionRefusal::MultipartRequired)?;
                    file_slot = Some(Some(UploadedFile {
                        bytes,
                        content_type,
                    }));
                } else {
                    drain(&mut field)
                        .await
                        .map_err(|_| ProfileAdmissionRefusal::MultipartRequired)?;
                    file_slot = Some(None);
                }
            }
            // Every other part — unknown, duplicate, or a later `file` — is drained to
            // advance the stream with zero accumulation, so the loop reaches true EOF.
            _ => drain(&mut field)
                .await
                .map_err(|_| ProfileAdmissionRefusal::MultipartRequired)?,
        }
    }

    match file_slot {
        Some(Some(file)) => validate_candidate(file),
        _ => Err(ProfileAdmissionRefusal::FileFieldRequired),
    }
}

/// Admit a `POST /internal/agents/{aid}/profile`. One multipart carries the text
/// fields (`display_name`, `description`, `avatar_action`) and — only when
/// `avatar_action === "set"` — a `file` part. The refusal order mirrors the product
/// exactly: avatar-action validity → nothing-to-update → text schema →
/// file-required-for-set → avatar validation.
pub async fn admit_profile_edit(
    request: Request,
) -> Result<ValidatedProfileEdit, ProfileAdmissionRefusal> {
    let mut multipart = Multipart::from_request(request, &())
        .await
        .map_err(|_| ProfileAdmissionRefusal::MultipartRequired)?;

    // Collect the form once. `display_name`/`description` are first-wins (mirroring
    // `form.get`) and captured only when the part is a non-file value
    // (`typeof raw === 'string'`); a File under those names is ignored, exactly as
    // TS's `typeof !== 'string'` guard drops it. `avatar_action`, by contrast, takes
    // the FIRST slot whether or not it is a File — `form.get('avatar_action')`
    // returns the first entry, and a `File` there is `!== "set"/"clear"`, so it must
    // reach the invalid-action refusal rather than be silently ignored. The first
    // `file`-named part is remembered whether or not it is a `File`, so the "set needs
    // a File" check mirrors `form.get('file') instanceof File`.
    let mut display_name_raw: Option<String> = None;
    let mut description_raw: Option<String> = None;
    let mut avatar_action_slot: Option<AvatarActionSlot> = None;
    let mut file_slot: Option<Option<UploadedFile>> = None;

    loop {
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return Err(ProfileAdmissionRefusal::MultipartRequired),
        };
        // Snapshot the discriminating attributes so the field itself can be moved
        // into a consuming read below without holding a borrow across the match.
        let name = field.name().map(str::to_owned);
        let is_file = field.file_name().is_some();
        match name.as_deref() {
            Some("display_name") if !is_file && display_name_raw.is_none() => {
                display_name_raw = Some(field_text(field).await?);
            }
            Some("description") if !is_file && description_raw.is_none() => {
                description_raw = Some(field_text(field).await?);
            }
            Some("avatar_action") if avatar_action_slot.is_none() => {
                // First slot wins, File or not: a File here is a present-but-invalid
                // action, not an absent one.
                if is_file {
                    drain(&mut field)
                        .await
                        .map_err(|_| ProfileAdmissionRefusal::MultipartRequired)?;
                    avatar_action_slot = Some(AvatarActionSlot::NonText);
                } else {
                    avatar_action_slot = Some(AvatarActionSlot::Text(field_text(field).await?));
                }
            }
            Some("file") if file_slot.is_none() => {
                if is_file {
                    let content_type = declared_content_type(&field);
                    let bytes = accumulate_capped(&mut field, AVATAR_MAX_BYTES as usize + 1)
                        .await
                        .map_err(|_| ProfileAdmissionRefusal::MultipartRequired)?;
                    file_slot = Some(Some(UploadedFile {
                        bytes,
                        content_type,
                    }));
                } else {
                    // A `file`-named plain field: present, but not a `File`.
                    drain(&mut field)
                        .await
                        .map_err(|_| ProfileAdmissionRefusal::MultipartRequired)?;
                    file_slot = Some(None);
                }
            }
            _ => {
                // An unknown or duplicate part: drain it so the stream advances.
                drain(&mut field)
                    .await
                    .map_err(|_| ProfileAdmissionRefusal::MultipartRequired)?;
            }
        }
    }

    // 1. `avatar_action` validity (present → must be "set" | "clear"; a File slot is
    // present-but-invalid).
    let avatar_action = match avatar_action_slot {
        None => None,
        Some(AvatarActionSlot::NonText) => {
            return Err(ProfileAdmissionRefusal::InvalidAvatarAction);
        }
        Some(AvatarActionSlot::Text(raw)) => match raw.as_str() {
            "set" => Some(AvatarActionKind::Set),
            "clear" => Some(AvatarActionKind::Clear),
            _ => return Err(ProfileAdmissionRefusal::InvalidAvatarAction),
        },
    };

    let has_text = display_name_raw.is_some() || description_raw.is_some();

    // 2. Nothing to do: no text field present AND no avatar action.
    if !has_text && avatar_action.is_none() {
        return Err(ProfileAdmissionRefusal::NothingToUpdate);
    }

    // 3. Text schema — `display_name` and `description`.
    let display_name = match display_name_raw {
        Some(raw) => {
            Some(DisplayName::parse(&raw).map_err(|_| ProfileAdmissionRefusal::InvalidText)?)
        }
        None => None,
    };
    let description = match description_raw {
        Some(raw) => {
            Some(ProfileDescription::parse(&raw).ok_or(ProfileAdmissionRefusal::InvalidText)?)
        }
        None => None,
    };

    // 4. Avatar action: `set` needs a `File`, then validate it.
    let avatar = match avatar_action {
        None => AvatarAction::Leave,
        Some(AvatarActionKind::Clear) => AvatarAction::Clear,
        Some(AvatarActionKind::Set) => match file_slot {
            Some(Some(file)) => AvatarAction::Set(validate_candidate(file)?),
            _ => return Err(ProfileAdmissionRefusal::FileFieldRequiredForSet),
        },
    };

    Ok(ValidatedProfileEdit {
        display_name,
        description,
        avatar,
    })
}

/// The parsed `avatar_action` kinds, before a `set` has bound its file.
#[derive(Clone, Copy)]
enum AvatarActionKind {
    Set,
    Clear,
}

/// The FIRST `avatar_action` slot, captured before validity is judged. A non-file
/// part carries its text; a `File` part is `NonText` — present, but never `"set"` or
/// `"clear"`, so it refuses as an invalid action rather than being ignored.
enum AvatarActionSlot {
    Text(String),
    NonText,
}

// ===========================================================================
// Route-local admission helpers (transport plumbing is shared).
// ===========================================================================

/// A multipart `file` part reduced to what avatar validation needs.
struct UploadedFile {
    bytes: Vec<u8>,
    content_type: String,
}

/// Turn a buffered file part into a [`ValidatedAvatar`], or the matching avatar
/// refusal. Validation order (empty → too-large → unsupported) is [`validate_avatar`]'s.
fn validate_candidate(file: UploadedFile) -> Result<ValidatedAvatar, ProfileAdmissionRefusal> {
    match validate_avatar(file.bytes.len() as u64, &file.content_type) {
        Ok(content_type) => Ok(ValidatedAvatar {
            bytes: file.bytes,
            content_type,
        }),
        Err(rejection) => Err(ProfileAdmissionRefusal::Avatar(rejection)),
    }
}

/// Read a non-file part's value as text, folding a decode fault into the terminal
/// `multipart/form-data required` refusal.
async fn field_text(field: Field<'_>) -> Result<String, ProfileAdmissionRefusal> {
    field
        .text()
        .await
        .map_err(|_| ProfileAdmissionRefusal::MultipartRequired)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        extract::DefaultBodyLimit,
        http::{Request, header::CONTENT_TYPE},
        routing::post,
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    const BOUNDARY: &str = "TestBoundary123";

    /// One multipart part: a name, an optional filename (present ⇒ a `File`), an
    /// optional `Content-Type` header, and a raw body.
    struct Part {
        name: &'static str,
        filename: Option<&'static str>,
        content_type: Option<&'static str>,
        body: Vec<u8>,
    }

    impl Part {
        fn text(name: &'static str, value: &str) -> Self {
            Self {
                name,
                filename: None,
                content_type: None,
                body: value.as_bytes().to_vec(),
            }
        }

        fn file(name: &'static str, content_type: &'static str, body: Vec<u8>) -> Self {
            Self {
                name,
                filename: Some("upload.bin"),
                content_type: Some(content_type),
                body,
            }
        }
    }

    /// Encode parts into a `multipart/form-data` body with [`BOUNDARY`].
    fn encode(parts: &[Part]) -> Vec<u8> {
        let mut out = Vec::new();
        for part in parts {
            out.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
            let mut disposition = format!("Content-Disposition: form-data; name=\"{}\"", part.name);
            if let Some(filename) = part.filename {
                disposition.push_str(&format!("; filename=\"{filename}\""));
            }
            disposition.push_str("\r\n");
            out.extend_from_slice(disposition.as_bytes());
            if let Some(content_type) = part.content_type {
                out.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
            }
            out.extend_from_slice(b"\r\n");
            out.extend_from_slice(&part.body);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
        out
    }

    fn multipart_request(parts: &[Part]) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/internal/agents/a1/profile")
            .header(
                CONTENT_TYPE,
                format!("multipart/form-data; boundary={BOUNDARY}"),
            )
            .body(Body::from(encode(parts)))
            .unwrap()
    }

    fn json_request(raw: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/internal/agents/a1/profile")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(raw.to_owned()))
            .unwrap()
    }

    /// Drive `admit_avatar_upload` through a real router with the axum default 2 MB
    /// body limit DISABLED — mirroring the production 128 MiB request perimeter the
    /// composition root mounts, without which axum caps the streamed body at 2 MB
    /// before the domain's own size check ever runs. Returns the wire status so an
    /// oversize body's `413` can be asserted end-to-end (a bare `from_request` call
    /// would trip the 2 MB default and mis-report `multipart/form-data required`).
    async fn admit_avatar_status(parts: &[Part]) -> StatusCode {
        async fn probe(request: Request<Body>) -> Response {
            match admit_avatar_upload(request).await {
                Ok(_) => StatusCode::OK.into_response(),
                Err(refusal) => refusal.into_response(),
            }
        }
        let app = Router::new()
            .route("/p", post(probe))
            .layer(DefaultBodyLimit::disable());
        let request = Request::builder()
            .method("POST")
            .uri("/p")
            .header(
                CONTENT_TYPE,
                format!("multipart/form-data; boundary={BOUNDARY}"),
            )
            .body(Body::from(encode(parts)))
            .unwrap();
        app.oneshot(request).await.unwrap().status()
    }

    async fn refusal_body(refusal: ProfileAdmissionRefusal) -> (StatusCode, Value) {
        let response = refusal.into_response();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    // ---- avatar-only admission ----

    #[tokio::test]
    async fn a_well_formed_png_is_admitted() {
        let request = multipart_request(&[Part::file("file", "image/png", vec![1, 2, 3])]);
        let avatar = admit_avatar_upload(request).await.expect("admitted");
        assert_eq!(avatar.content_type(), AvatarContentType::Png);
        assert_eq!(avatar.bytes(), &[1, 2, 3]);
    }

    #[tokio::test]
    async fn a_non_multipart_body_is_multipart_required() {
        let refusal = admit_avatar_upload(json_request("{}")).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::MultipartRequired);
    }

    #[tokio::test]
    async fn a_missing_file_part_is_file_field_required() {
        let request = multipart_request(&[Part::text("other", "x")]);
        let refusal = admit_avatar_upload(request).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::FileFieldRequired);
    }

    #[tokio::test]
    async fn a_non_file_file_part_is_file_field_required() {
        // A `file`-named plain field (no filename) is not a `File`.
        let request = multipart_request(&[Part::text("file", "not-a-file")]);
        let refusal = admit_avatar_upload(request).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::FileFieldRequired);
    }

    #[tokio::test]
    async fn an_empty_file_is_avatar_missing() {
        let request = multipart_request(&[Part::file("file", "image/png", vec![])]);
        let refusal = admit_avatar_upload(request).await.unwrap_err();
        assert_eq!(
            refusal,
            ProfileAdmissionRefusal::Avatar(AvatarRejection::Empty)
        );
    }

    #[tokio::test]
    async fn an_unsupported_type_is_avatar_unsupported_type() {
        let request = multipart_request(&[Part::file("file", "text/plain", vec![1])]);
        let refusal = admit_avatar_upload(request).await.unwrap_err();
        assert_eq!(
            refusal,
            ProfileAdmissionRefusal::Avatar(AvatarRejection::UnsupportedType)
        );
    }

    #[tokio::test]
    async fn an_oversize_file_is_avatar_too_large_via_the_bounded_read() {
        // One byte past the cap: the bounded read stops at cap + 1, which is exactly
        // enough for validate_avatar to return the precise 413 without buffering more.
        // Routed with the body limit disabled so the 5 MiB+1 body reaches the reader
        // (as it would behind the production 128 MiB perimeter).
        let body = vec![0u8; 5 * 1024 * 1024 + 1];
        let status = admit_avatar_status(&[Part::file("file", "image/png", body)]).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn a_file_at_the_cap_is_admitted() {
        // The exact cap is admitted end-to-end — the boundary the bounded read must
        // not misclassify as too-large.
        let body = vec![0u8; 5 * 1024 * 1024];
        let status = admit_avatar_status(&[Part::file("file", "image/png", body)]).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn an_empty_unsupported_file_is_rejected_as_empty_first() {
        // Order proof through admission: empty beats unsupported-type.
        let request = multipart_request(&[Part::file("file", "text/plain", vec![])]);
        let refusal = admit_avatar_upload(request).await.unwrap_err();
        assert_eq!(
            refusal,
            ProfileAdmissionRefusal::Avatar(AvatarRejection::Empty)
        );
    }

    #[tokio::test]
    async fn an_uppercase_declared_mime_is_admitted() {
        // The transport passes the declared type through unfolded; `validate_avatar`'s
        // `AvatarContentType::parse` lowercases before its exact match, so `IMAGE/PNG` admits.
        let request = multipart_request(&[Part::file("file", "IMAGE/PNG", vec![1, 2, 3])]);
        let avatar = admit_avatar_upload(request).await.expect("admitted");
        assert_eq!(avatar.content_type(), AvatarContentType::Png);
    }

    #[tokio::test]
    async fn a_declared_mime_with_params_stays_unsupported() {
        // The sole MIME authority lowercases but never strips `;params`, so a parameterized
        // type is outside the exact allowlist and is 415, matching TS.
        let request = multipart_request(&[Part::file("file", "IMAGE/PNG; CHARSET=X", vec![1])]);
        let refusal = admit_avatar_upload(request).await.unwrap_err();
        assert_eq!(
            refusal,
            ProfileAdmissionRefusal::Avatar(AvatarRejection::UnsupportedType)
        );
    }

    // ---- profile-edit admission ----

    #[tokio::test]
    async fn only_display_name_is_a_single_leave_edit() {
        let request = multipart_request(&[Part::text("display_name", "  New Name  ")]);
        let edit = admit_profile_edit(request).await.expect("admitted");
        // display_name is trimmed by DisplayName::parse.
        assert_eq!(
            edit.display_name().map(DisplayName::as_str),
            Some("New Name")
        );
        assert_eq!(edit.description(), None);
        assert_eq!(edit.avatar(), &AvatarAction::Leave);
    }

    #[tokio::test]
    async fn a_present_empty_description_updates_to_empty() {
        let request = multipart_request(&[Part::text("description", "")]);
        let edit = admit_profile_edit(request).await.expect("admitted");
        assert_eq!(edit.description().map(ProfileDescription::as_str), Some(""));
        assert_eq!(edit.display_name(), None);
    }

    #[tokio::test]
    async fn no_known_fields_is_nothing_to_update() {
        let request = multipart_request(&[Part::text("junk", "x")]);
        let refusal = admit_profile_edit(request).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::NothingToUpdate);
    }

    #[tokio::test]
    async fn invalid_avatar_action_beats_nothing_to_update() {
        // avatar_action validity is checked before the nothing-to-update guard.
        let request = multipart_request(&[Part::text("avatar_action", "bogus")]);
        let refusal = admit_profile_edit(request).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::InvalidAvatarAction);
    }

    #[tokio::test]
    async fn a_first_slot_file_avatar_action_is_invalid_not_ignored() {
        // `form.get('avatar_action')` returns the FIRST entry; a File there is
        // `!== "set"/"clear"`, so it must refuse as an invalid action — NOT be
        // ignored (which would fall through to the later text `set` or to
        // nothing-to-update).
        let request = multipart_request(&[
            Part::file("avatar_action", "text/plain", vec![1]),
            Part::text("avatar_action", "set"),
        ]);
        let refusal = admit_profile_edit(request).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::InvalidAvatarAction);
    }

    #[tokio::test]
    async fn a_large_unknown_part_is_chunk_drained_and_a_later_field_still_parses() {
        // The unknown part is discarded chunk-by-chunk with zero accumulation, so it
        // never charges the request ceiling into memory; the trailing known field is
        // still admitted.
        let junk = "x".repeat(256 * 1024);
        let request = multipart_request(&[
            Part::text("junk", &junk),
            Part::text("display_name", "Name"),
        ]);
        let edit = admit_profile_edit(request).await.expect("admitted");
        assert_eq!(edit.display_name().map(DisplayName::as_str), Some("Name"));
    }

    #[tokio::test]
    async fn an_overlong_display_name_is_invalid_text() {
        let request = multipart_request(&[Part::text("display_name", &"a".repeat(65))]);
        let refusal = admit_profile_edit(request).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::InvalidText);
    }

    #[tokio::test]
    async fn an_overlong_description_is_invalid_text() {
        let request = multipart_request(&[Part::text(
            "description",
            &format!("{}a", "😀".repeat(1000)),
        )]);
        let refusal = admit_profile_edit(request).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::InvalidText);
    }

    #[tokio::test]
    async fn a_description_at_the_cap_is_admitted() {
        let request = multipart_request(&[Part::text("description", &"😀".repeat(1000))]);
        let edit = admit_profile_edit(request).await.expect("admitted");
        assert_eq!(
            edit.description().map(ProfileDescription::as_str),
            Some("😀".repeat(1000).as_str())
        );
    }

    #[tokio::test]
    async fn text_schema_beats_file_required_for_set() {
        // Invalid display_name AND avatar_action=set without a file: the text schema
        // fault is reported first.
        let request = multipart_request(&[
            Part::text("display_name", &"a".repeat(65)),
            Part::text("avatar_action", "set"),
        ]);
        let refusal = admit_profile_edit(request).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::InvalidText);
    }

    #[tokio::test]
    async fn avatar_action_set_without_a_file_is_file_field_required_for_set() {
        let request = multipart_request(&[
            Part::text("display_name", "Name"),
            Part::text("avatar_action", "set"),
        ]);
        let refusal = admit_profile_edit(request).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::FileFieldRequiredForSet);
    }

    #[tokio::test]
    async fn avatar_action_set_with_a_non_file_file_part_is_file_field_required_for_set() {
        // A `file`-named plain field is not a `File`, so `set` still lacks its file.
        let request = multipart_request(&[
            Part::text("avatar_action", "set"),
            Part::text("file", "not-a-file"),
        ]);
        let refusal = admit_profile_edit(request).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::FileFieldRequiredForSet);
    }

    #[tokio::test]
    async fn avatar_action_set_with_a_valid_file_is_a_set_edit() {
        let request = multipart_request(&[
            Part::text("avatar_action", "set"),
            Part::file("file", "image/gif", vec![9, 9]),
        ]);
        let edit = admit_profile_edit(request).await.expect("admitted");
        match edit.avatar() {
            AvatarAction::Set(avatar) => {
                assert_eq!(avatar.content_type(), AvatarContentType::Gif);
                assert_eq!(avatar.bytes(), &[9, 9]);
            }
            other => panic!("expected Set, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn avatar_action_set_with_an_unsupported_file_is_rejected() {
        let request = multipart_request(&[
            Part::text("avatar_action", "set"),
            Part::file("file", "text/plain", vec![1]),
        ]);
        let refusal = admit_profile_edit(request).await.unwrap_err();
        assert_eq!(
            refusal,
            ProfileAdmissionRefusal::Avatar(AvatarRejection::UnsupportedType)
        );
    }

    #[tokio::test]
    async fn avatar_action_clear_alone_is_a_valid_clear_edit() {
        let request = multipart_request(&[Part::text("avatar_action", "clear")]);
        let edit = admit_profile_edit(request).await.expect("admitted");
        assert_eq!(edit.avatar(), &AvatarAction::Clear);
        assert_eq!(edit.display_name(), None);
        assert_eq!(edit.description(), None);
    }

    #[tokio::test]
    async fn a_duplicate_display_name_is_first_wins() {
        let request = multipart_request(&[
            Part::text("display_name", "first"),
            Part::text("display_name", "second"),
        ]);
        let edit = admit_profile_edit(request).await.expect("admitted");
        assert_eq!(edit.display_name().map(DisplayName::as_str), Some("first"));
    }

    #[tokio::test]
    async fn profile_edit_on_a_non_multipart_body_is_multipart_required() {
        let refusal = admit_profile_edit(json_request("{}")).await.unwrap_err();
        assert_eq!(refusal, ProfileAdmissionRefusal::MultipartRequired);
    }

    // ---- refusal wire projection ----

    #[tokio::test]
    async fn each_refusal_renders_its_status_and_body() {
        assert_eq!(
            refusal_body(ProfileAdmissionRefusal::MultipartRequired).await,
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "multipart/form-data required" })
            )
        );
        assert_eq!(
            refusal_body(ProfileAdmissionRefusal::FileFieldRequired).await,
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "file field required" })
            )
        );
        assert_eq!(
            refusal_body(ProfileAdmissionRefusal::InvalidAvatarAction).await,
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "avatar_action must be \"set\" or \"clear\"" })
            )
        );
        assert_eq!(
            refusal_body(ProfileAdmissionRefusal::NothingToUpdate).await,
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "no fields to update" })
            )
        );
        assert_eq!(
            refusal_body(ProfileAdmissionRefusal::InvalidText).await,
            (StatusCode::BAD_REQUEST, json!({ "error": "invalid input" }))
        );
        assert_eq!(
            refusal_body(ProfileAdmissionRefusal::FileFieldRequiredForSet).await,
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "file field required for avatar_action=set" })
            )
        );
        assert_eq!(
            refusal_body(ProfileAdmissionRefusal::Avatar(AvatarRejection::Empty)).await,
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "Avatar file is empty.", "code": "avatar_missing" })
            )
        );
        assert_eq!(
            refusal_body(ProfileAdmissionRefusal::Avatar(AvatarRejection::TooLarge)).await,
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({ "error": "Avatar must be 5 MB or smaller.", "code": "avatar_too_large" })
            )
        );
        assert_eq!(
            refusal_body(ProfileAdmissionRefusal::Avatar(
                AvatarRejection::UnsupportedType
            ))
            .await,
            (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                json!({
                    "error": "Avatar must be a PNG, JPEG, GIF, or WEBP image.",
                    "code": "avatar_unsupported_type"
                })
            )
        );
    }
}
