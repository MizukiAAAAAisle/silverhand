//! Attachments carried by a direct-pair first send.
//!
//! The pair does not exist when the request arrives, so files cannot go through
//! the channel upload door first. The initiation door reads and validates every
//! file before the pair is opened, then stages them here under the opened pair
//! through the same admission, blob write and create unit as an ordinary upload.
//!
//! Each file's id is derived from the viewer, the target, the client message id
//! and the file's position. A retry of the same send therefore names the same
//! attachments: a file whose row already exists in this pair is reused rather
//! than uploaded twice, and the send unit's client-message replay answers with
//! the message the first attempt committed.

use std::future::Future;

use axum::{
    extract::{DefaultBodyLimit, FromRequest, Multipart, Request},
    http::{StatusCode, header},
    response::Response,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use silverhand_backend_core::{
    conversation_messaging::messaging::{
        AttachmentId, ClientMessageId, PrincipalIdentity, SendClock,
        collaboration::attachment::{
            AttachmentContentType, AttachmentCreateUnitOfWork, AttachmentDownloadReadPort,
            AttachmentFilename, AttachmentWriteAdmissionPort, AttachmentWriteAdmissionRefusal,
        },
    },
    foundation::blob_store::BlobStore,
    foundation::identity::{ConversationId, UserId},
};

use super::{
    ATTACHMENT_ID_BYTES, MAX_FILE_BYTES, UploadFailure, coded, detect_content_type, error,
    persist_upload, sanitize_filename,
};
use crate::conversation_messaging::messaging::admission::MAX_MESSAGE_ATTACHMENTS;

/// The whole first-send envelope. It matches the outer request perimeter, which
/// already bounds every body; a full set of maximum-size files does not fit and
/// is refused as too large.
const FIRST_SEND_MAX_BODY_BYTES: usize = 128 * 1024 * 1024;

/// One file that passed name and type validation, waiting for its pair.
#[derive(Clone, Debug)]
pub struct StagedFirstSendFile {
    id: AttachmentId,
    filename: AttachmentFilename,
    content_type: AttachmentContentType,
    bytes: Vec<u8>,
}

impl StagedFirstSendFile {
    pub fn id(&self) -> &AttachmentId {
        &self.id
    }

    pub fn content_type(&self) -> &AttachmentContentType {
        &self.content_type
    }
}

/// Stores first-send files under the pair the initiation door opened.
pub trait FirstSendUploads: Send + Sync + 'static {
    fn stage(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
        file: StagedFirstSendFile,
    ) -> impl Future<Output = Result<(), UploadFailure>> + Send;
}

/// The production [`FirstSendUploads`]: the attachment read and write ports and
/// the blob store the channel upload door uses.
#[derive(Clone)]
pub struct FirstSendAttachmentStore<R, W, B, E> {
    reads: R,
    writes: W,
    blobs: B,
    environment: E,
}

impl<R, W, B, E> FirstSendAttachmentStore<R, W, B, E> {
    pub fn new(reads: R, writes: W, blobs: B, environment: E) -> Self {
        Self {
            reads,
            writes,
            blobs,
            environment,
        }
    }
}

impl<R, W, B, E> FirstSendUploads for FirstSendAttachmentStore<R, W, B, E>
where
    R: AttachmentDownloadReadPort + Send + Sync + 'static,
    W: AttachmentWriteAdmissionPort + AttachmentCreateUnitOfWork + Send + Sync + 'static,
    B: BlobStore,
    E: SendClock + Send + Sync + 'static,
{
    async fn stage(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
        file: StagedFirstSendFile,
    ) -> Result<(), UploadFailure> {
        match self.reads.download(viewer, &file.id).await {
            Ok(Ok(existing)) => {
                let Ok(existing) = existing.bind(viewer, &file.id) else {
                    tracing::error!("first-send attachment reuse identity seal failed");
                    return Err(UploadFailure::Internal);
                };
                if existing.record().channel() == conversation {
                    return Ok(());
                }
                // The derived id names a row outside this pair. The create below
                // collides with it and the send fails without touching that row.
            }
            Ok(Err(_)) => {}
            Err(error) => {
                tracing::error!(
                    error_chain = crate::foundation::safe_log_field::safe_display(
                        &(crate::foundation::error::describe(&error))
                    ),
                    "first-send attachment reuse lookup failed"
                );
                return Err(UploadFailure::Internal);
            }
        }
        let admission = match self.writes.admit_create(viewer, conversation).await {
            Ok(Ok(value)) => match value.bind(viewer, conversation) {
                Ok(value) => value,
                Err(error) => {
                    tracing::error!(
                        error_chain = crate::foundation::safe_log_field::safe_display(
                            &(crate::foundation::error::describe(&error))
                        ),
                        "first-send attachment admission identity seal failed"
                    );
                    return Err(UploadFailure::Internal);
                }
            },
            Ok(Err(AttachmentWriteAdmissionRefusal::NotFound)) => {
                return Err(UploadFailure::NotFound);
            }
            Ok(Err(AttachmentWriteAdmissionRefusal::Forbidden)) => {
                return Err(UploadFailure::Forbidden);
            }
            Err(error) => {
                tracing::error!(
                    error_chain = crate::foundation::safe_log_field::safe_display(
                        &(crate::foundation::error::describe(&error))
                    ),
                    "first-send attachment admission failed"
                );
                return Err(UploadFailure::Internal);
            }
        };
        persist_upload(
            &self.writes,
            &self.blobs,
            &self.environment,
            &admission,
            viewer,
            conversation,
            file.id,
            file.filename,
            file.content_type,
            file.bytes,
        )
        .await
        .map(|_| ())
    }
}

/// A read first-send envelope: the `payload` JSON part as written, and the files
/// in their submitted order, each still without an id.
pub(crate) struct FirstSendMultipart {
    pub(crate) payload: Option<serde_json::Value>,
    pub(crate) files: Vec<UnplacedFirstSendFile>,
}

pub(crate) struct UnplacedFirstSendFile {
    filename: AttachmentFilename,
    content_type: AttachmentContentType,
    bytes: Vec<u8>,
}

impl UnplacedFirstSendFile {
    pub(crate) fn content_type(&self) -> &AttachmentContentType {
        &self.content_type
    }

    pub(crate) fn place(self, id: AttachmentId) -> StagedFirstSendFile {
        StagedFirstSendFile {
            id,
            filename: self.filename,
            content_type: self.content_type,
            bytes: self.bytes,
        }
    }
}

pub(crate) fn is_multipart(request: &Request) -> bool {
    request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("multipart/form-data")
        })
}

/// Reads the envelope within its bound and validates every file before anything
/// is stored: count, size, name and type answer exactly as the upload door does.
pub(crate) async fn read_first_send_multipart(
    mut request: Request,
) -> Result<FirstSendMultipart, Box<Response>> {
    if let Some(declared) = request.headers().get(header::CONTENT_LENGTH) {
        let declared = declared
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| Box::new(error(StatusCode::BAD_REQUEST, "invalid content-length")))?;
        if declared > FIRST_SEND_MAX_BODY_BYTES as u64 {
            return Err(Box::new(too_large()));
        }
    }
    DefaultBodyLimit::max(FIRST_SEND_MAX_BODY_BYTES).apply(&mut request);
    let mut multipart = Multipart::from_request(request, &())
        .await
        .map_err(|rejection| Box::new(read_failure(rejection.status())))?;
    let mut payload = None;
    let mut payload_seen = false;
    let mut files = Vec::new();
    loop {
        let field = multipart
            .next_field()
            .await
            .map_err(|failure| Box::new(read_failure(failure.status())))?;
        let Some(field) = field else { break };
        match field.name() {
            Some("payload") if !payload_seen => {
                payload_seen = true;
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|failure| Box::new(read_failure(failure.status())))?;
                payload = serde_json::from_slice(&bytes).ok();
            }
            Some("file") => {
                let Some(raw_filename) = field.file_name().map(str::to_owned) else {
                    continue;
                };
                if files.len() == MAX_MESSAGE_ATTACHMENTS {
                    return Err(Box::new(coded(
                        StatusCode::BAD_REQUEST,
                        "too many attachments",
                        "too_many_attachments",
                    )));
                }
                let explicit = field.content_type().map(str::to_owned);
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|failure| Box::new(read_failure(failure.status())))?
                    .to_vec();
                files.push(validate_file(&raw_filename, explicit.as_deref(), bytes)?);
            }
            _ => {}
        }
    }
    Ok(FirstSendMultipart { payload, files })
}

fn validate_file(
    raw_filename: &str,
    explicit: Option<&str>,
    bytes: Vec<u8>,
) -> Result<UnplacedFirstSendFile, Box<Response>> {
    if bytes.is_empty() {
        return Err(Box::new(coded(
            StatusCode::BAD_REQUEST,
            "attachment buffer is empty",
            "invalid_buffer",
        )));
    }
    if bytes.len() > MAX_FILE_BYTES {
        return Err(Box::new(too_large()));
    }
    let Some(filename) =
        sanitize_filename(raw_filename).and_then(|raw| AttachmentFilename::parse(raw).ok())
    else {
        return Err(Box::new(coded(
            StatusCode::BAD_REQUEST,
            "attachment filename is invalid",
            "invalid_filename",
        )));
    };
    let Some(content_type) = detect_content_type(explicit, &bytes, filename.as_str()) else {
        return Err(Box::new(coded(
            StatusCode::BAD_REQUEST,
            "attachment content type is invalid",
            "invalid_content_type",
        )));
    };
    Ok(UnplacedFirstSendFile {
        filename,
        content_type,
        bytes,
    })
}

/// The id a first-send file takes. Stable across retries of one send, distinct
/// across positions, sends, targets and viewers, and shaped like a minted id.
pub(crate) fn first_send_attachment_id(
    viewer: &UserId,
    target: &PrincipalIdentity,
    client_message_id: &ClientMessageId,
    ordinal: usize,
) -> AttachmentId {
    let mut hasher = Sha256::new();
    for part in [
        "silverhand.first-send-attachment.v1",
        viewer.as_str(),
        match target {
            PrincipalIdentity::Agent(_) => "agent",
            PrincipalIdentity::Human(_) => "human",
        },
        target.as_str(),
        client_message_id.as_str(),
        &ordinal.to_string(),
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    AttachmentId::parse(URL_SAFE_NO_PAD.encode(&digest[..ATTACHMENT_ID_BYTES]))
        .expect("a non-empty encoding is a valid attachment id")
}

fn read_failure(status: StatusCode) -> Response {
    if status == StatusCode::PAYLOAD_TOO_LARGE {
        too_large()
    } else {
        error(StatusCode::BAD_REQUEST, "multipart/form-data required")
    }
}

fn too_large() -> Response {
    coded(
        StatusCode::PAYLOAD_TOO_LARGE,
        "attachment exceeds 10 MiB",
        "too_large",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_send_ids_are_stable_per_position_and_distinct_otherwise() {
        let viewer = UserId::parse("u-1").unwrap();
        let agent = PrincipalIdentity::Agent(
            silverhand_backend_core::foundation::identity::AgentId::parse("a-1").unwrap(),
        );
        let human = PrincipalIdentity::Human(UserId::parse("a-1").unwrap());
        let send = ClientMessageId::parse("3f2b8c1e-7a4d-4b6e-9c2f-1a2b3c4d5e6f".into()).unwrap();
        let other = ClientMessageId::parse("3f2b8c1e-7a4d-4b6e-9c2f-1a2b3c4d5e70".into()).unwrap();

        let first = first_send_attachment_id(&viewer, &agent, &send, 0);
        assert_eq!(first, first_send_attachment_id(&viewer, &agent, &send, 0));
        assert_eq!(first.as_str().len(), 16);
        for distinct in [
            first_send_attachment_id(&viewer, &agent, &send, 1),
            first_send_attachment_id(&viewer, &agent, &other, 0),
            first_send_attachment_id(&viewer, &human, &send, 0),
            first_send_attachment_id(&UserId::parse("u-2").unwrap(), &agent, &send, 0),
        ] {
            assert_ne!(first, distinct);
        }
    }
}
