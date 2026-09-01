//! Driver-free blob identity and storage contracts.
//!
//! A stored blob is named by one validated `(storage, storage_key)` coordinate.
//! Callers can select a typed namespace, content type and byte payload, but they
//! cannot supply a filesystem path or physical basename. Alias ids are a
//! lossless encoding of a semantic id: two different ids can never collapse to
//! the same alias spelling.

use std::{error::Error, future::Future};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

const MAX_KEY_BYTES: usize = 4_096;
const MAX_SEGMENT_BYTES: usize = 255;
const MAX_SEGMENTS: usize = 64;
const MAX_ALIAS_ID_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageKind {
    Local,
    S3,
    Oss,
}

impl StorageKind {
    pub fn parse(raw: &str) -> Result<Self, UnknownStorageKind> {
        match raw {
            "local" => Ok(Self::Local),
            "s3" => Ok(Self::S3),
            "oss" => Ok(Self::Oss),
            _ => Err(UnknownStorageKind),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::S3 => "s3",
            Self::Oss => "oss",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UnknownStorageKind;

impl std::fmt::Display for UnknownStorageKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("storage kind is outside the published closed set")
    }
}

impl Error for UnknownStorageKind {}

/// A validated relative object key. Every component is a portable safe segment;
/// absolute paths, traversal, repeated separators and backslashes have no value
/// of this type.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct BlobStorageKey(String);

impl BlobStorageKey {
    pub fn parse(raw: impl Into<String>) -> Result<Self, InvalidBlobStorageKey> {
        let raw = raw.into();
        validate_relative_segments(&raw).map_err(|_| InvalidBlobStorageKey)?;
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn segments(&self) -> impl DoubleEndedIterator<Item = &str> {
        self.0.split('/')
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidBlobStorageKey;

impl std::fmt::Display for InvalidBlobStorageKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("blob storage key is not a safe relative coordinate")
    }
}

impl Error for InvalidBlobStorageKey {}

/// A typed directory coordinate chosen by an application capability. It is not
/// a path-building escape hatch: construction validates every segment verbatim
/// and never sanitizes two different spellings into one.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct BlobNamespace(String);

impl BlobNamespace {
    pub fn from_segments<'a>(
        segments: impl IntoIterator<Item = &'a str>,
    ) -> Result<Self, InvalidBlobNamespace> {
        let segments: Vec<&str> = segments.into_iter().collect();
        if segments.is_empty() {
            return Err(InvalidBlobNamespace);
        }
        let raw = segments.join("/");
        validate_relative_segments(&raw).map_err(|_| InvalidBlobNamespace)?;
        Ok(Self(raw))
    }

    /// Build a scope for an opaque semantic identity without assuming that the
    /// identity already obeys a path grammar. Its exact UTF-8 bytes are encoded
    /// losslessly and split at fixed boundaries, so even legacy ids containing
    /// separators stay distinct without becoming path components.
    pub fn for_semantic_id(
        static_scope: &str,
        semantic_id: &str,
    ) -> Result<Self, InvalidBlobNamespace> {
        if semantic_id.is_empty() {
            return Err(InvalidBlobNamespace);
        }
        validate_relative_segments(static_scope).map_err(|_| InvalidBlobNamespace)?;
        let encoded = URL_SAFE_NO_PAD.encode(semantic_id.as_bytes());
        let mut raw = format!("{static_scope}/id");
        for chunk in encoded.as_bytes().chunks(200) {
            let chunk = std::str::from_utf8(chunk).map_err(|_| InvalidBlobNamespace)?;
            raw.push('/');
            raw.push_str(chunk);
        }
        validate_relative_segments(&raw).map_err(|_| InvalidBlobNamespace)?;
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn segments(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidBlobNamespace;

impl std::fmt::Display for InvalidBlobNamespace {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("blob namespace is not a safe relative coordinate")
    }
}

impl Error for InvalidBlobNamespace {}

/// A collision-free physical-alias identity.
///
/// The encoded spelling is base64url of the exact UTF-8 semantic id, not a
/// lossy sanitizer. Thus `a?`, `a!` and every other distinct accepted id remain
/// distinct on disk. Empty and unbounded ids are rejected before encoding.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct BlobAliasId(String);

impl BlobAliasId {
    pub fn from_semantic_id(raw: &str) -> Result<Self, InvalidBlobAliasId> {
        if raw.is_empty() || raw.len() > MAX_ALIAS_ID_BYTES {
            return Err(InvalidBlobAliasId);
        }
        Ok(Self(URL_SAFE_NO_PAD.encode(raw.as_bytes())))
    }

    pub fn encoded(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidBlobAliasId;

impl std::fmt::Display for InvalidBlobAliasId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("blob alias id is empty or exceeds its bounded grammar")
    }
}

impl Error for InvalidBlobAliasId {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredBlob {
    storage: StorageKind,
    key: BlobStorageKey,
}

impl StoredBlob {
    pub fn new(storage: StorageKind, key: BlobStorageKey) -> Self {
        Self { storage, key }
    }

    pub const fn storage(&self) -> StorageKind {
        self.storage
    }

    pub fn key(&self) -> &BlobStorageKey {
        &self.key
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlobRead {
    bytes: Vec<u8>,
    actual_size: u64,
}

impl BlobRead {
    pub fn exact(bytes: Vec<u8>) -> Self {
        Self {
            actual_size: bytes.len() as u64,
            bytes,
        }
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    pub const fn actual_size(&self) -> u64 {
        self.actual_size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BlobReadOutcome {
    Found(BlobRead),
    Missing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlobDeleteOutcome {
    Deleted,
    AlreadyMissing,
}

/// Driver-neutral byte-object storage. Local path aliases are deliberately not
/// part of this contract: they are a separate filesystem capability, so a
/// remote S3/Oss adapter never has to fabricate a local-path concept.
pub trait BlobStore: Clone + Send + Sync + 'static {
    type Error: Error + Send + Sync + 'static;

    fn put(
        &self,
        namespace: &BlobNamespace,
        normalized_content_type: &str,
        bytes: Vec<u8>,
    ) -> impl Future<Output = Result<StoredBlob, Self::Error>> + Send;

    fn read(
        &self,
        blob: &StoredBlob,
    ) -> impl Future<Output = Result<BlobReadOutcome, Self::Error>> + Send;

    fn delete(
        &self,
        blob: &StoredBlob,
    ) -> impl Future<Output = Result<BlobDeleteOutcome, Self::Error>> + Send;
}

fn validate_relative_segments(raw: &str) -> Result<(), ()> {
    if raw.is_empty() || raw.len() > MAX_KEY_BYTES || raw.starts_with('/') || raw.contains('\\') {
        return Err(());
    }
    let segments: Vec<&str> = raw.split('/').collect();
    if segments.is_empty() || segments.len() > MAX_SEGMENTS {
        return Err(());
    }
    if segments.iter().any(|segment| {
        segment.is_empty()
            || segment.len() > MAX_SEGMENT_BYTES
            || *segment == "."
            || *segment == ".."
            || !segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    }) {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_kind_is_one_closed_bijection() {
        for (raw, kind) in [
            ("local", StorageKind::Local),
            ("s3", StorageKind::S3),
            ("oss", StorageKind::Oss),
        ] {
            assert_eq!(StorageKind::parse(raw), Ok(kind));
            assert_eq!(kind.as_str(), raw);
        }
        assert!(StorageKind::parse("filesystem").is_err());
    }

    #[test]
    fn storage_keys_reject_every_path_escape_spelling() {
        for raw in [
            "",
            "/absolute/blob.bin",
            "../outside.bin",
            "attachments/../outside.bin",
            "attachments/./blob.bin",
            "attachments//blob.bin",
            "attachments\\blob.bin",
            "C:\\outside.bin",
            "attachments/blob?.bin",
        ] {
            assert!(
                BlobStorageKey::parse(raw).is_err(),
                "unsafe key was accepted: {raw:?}"
            );
        }
        assert_eq!(
            BlobStorageKey::parse("attachments/channel-1/blob-a1.bin")
                .unwrap()
                .as_str(),
            "attachments/channel-1/blob-a1.bin"
        );
    }

    #[test]
    fn namespaces_validate_verbatim_instead_of_sanitizing() {
        assert!(BlobNamespace::from_segments([]).is_err());
        assert!(BlobNamespace::from_segments(["attachments", "../foreign"]).is_err());
        assert!(BlobNamespace::from_segments(["attachments", "channel\\other"]).is_err());
        assert_eq!(
            BlobNamespace::from_segments(["attachments", "channel-1"])
                .unwrap()
                .as_str(),
            "attachments/channel-1"
        );

        let slash = BlobNamespace::for_semantic_id("attachments", "channel/a").unwrap();
        let backslash = BlobNamespace::for_semantic_id("attachments", "channel\\a").unwrap();
        assert_ne!(slash, backslash);
        assert!(slash.as_str().starts_with("attachments/id/"));
        assert!(BlobNamespace::for_semantic_id("../attachments", "channel").is_err());
        assert!(BlobNamespace::for_semantic_id("attachments", "").is_err());
    }

    #[test]
    fn alias_encoding_is_lossless_and_collision_free() {
        let question = BlobAliasId::from_semantic_id("a?").unwrap();
        let bang = BlobAliasId::from_semantic_id("a!").unwrap();
        let unicode = BlobAliasId::from_semantic_id("附件-1").unwrap();
        assert_ne!(question, bang);
        assert_ne!(question, unicode);
        assert!(
            question
                .encoded()
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        );
        assert!(BlobAliasId::from_semantic_id("").is_err());
        assert!(BlobAliasId::from_semantic_id(&"x".repeat(MAX_ALIAS_ID_BYTES + 1)).is_err());
    }

    #[test]
    fn blob_read_reports_the_bytes_actual_length() {
        let read = BlobRead::exact(vec![1, 2, 3]);
        assert_eq!(read.actual_size(), 3);
        assert_eq!(read.bytes(), &[1, 2, 3]);
    }
}
