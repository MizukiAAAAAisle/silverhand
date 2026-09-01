//! Local-filesystem adapter for the driver-free blob-store contract.
//!
//! # Threat boundary
//!
//! The configured root is created once, rejected when it is itself a symlink,
//! and then canonicalized into the adapter's only path authority. Typed keys
//! reject traversal, absolute paths and platform separators before this module
//! sees them. Every existing descendant is checked with `symlink_metadata` and
//! canonical containment before an operation: physical ancestors and leaves
//! may never be symlinks. Alias ancestors follow the same rule, while an alias
//! leaf must be this adapter's relative, same-directory symlink to a validated
//! physical basename.
//!
//! These checks defend corrupted database coordinates and symlinks planted
//! before an operation. They do **not** claim to defeat another process running
//! as the same OS principal that swaps a directory between check and open. The
//! blob root is therefore a backend-exclusive directory, not a shared
//! adversarial filesystem. Descriptor-relative `openat`/no-follow handling is a
//! future hardening boundary and is intentionally not simulated here.

use std::{
    error::Error,
    fmt,
    future::Future,
    io,
    path::{Component, Path, PathBuf},
};

use silverhand_backend_core::foundation::blob_store::{
    BlobAliasId, BlobDeleteOutcome, BlobNamespace, BlobRead, BlobReadOutcome, BlobStorageKey,
    BlobStore, StorageKind, StoredBlob,
};
use tokio::{fs, io::AsyncWriteExt as _};

const RANDOM_BYTES: usize = 16;
const COLLISION_ATTEMPTS: usize = 16;

pub trait BlobKeyEntropy: Clone + Send + Sync + 'static {
    fn fill(&self, destination: &mut [u8]) -> Result<(), getrandom::Error>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct HostBlobKeyEntropy;

impl BlobKeyEntropy for HostBlobKeyEntropy {
    fn fill(&self, destination: &mut [u8]) -> Result<(), getrandom::Error> {
        getrandom::fill(destination)
    }
}

/// A local path whose provenance is a successful filesystem alias operation.
/// Trusted local consumers may inspect it, but application code cannot forge
/// one from an arbitrary [`PathBuf`].
///
/// ```compile_fail
/// use std::path::PathBuf;
/// use silverhand_backend_filesystem::foundation::blob_store::LocalBlobAliasPath;
/// let forged = LocalBlobAliasPath(PathBuf::from("/tmp/not-storage-owned"));
/// # let _ = forged;
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalBlobAliasPath(PathBuf);

impl LocalBlobAliasPath {
    fn storage_owned(path: PathBuf) -> Self {
        Self(path)
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }

    pub fn into_path(self) -> PathBuf {
        self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalBlobAliasOutcome {
    Located(LocalBlobAliasPath),
    MissingPhysical,
}

/// Deleting a stale generation is a typed no-op: it cannot unlink the stable
/// alias after that alias has already moved to another physical blob.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalBlobAliasDeleteOutcome {
    Deleted,
    AlreadyMissing,
    TargetMismatch,
}

/// Filesystem-only stable-alias capability, independent from the generic byte
/// object [`BlobStore`]. Remote adapters have no local-path obligation.
pub trait LocalBlobAliasStore: Clone + Send + Sync + 'static {
    type Error: Error + Send + Sync + 'static;

    fn materialize_alias(
        &self,
        physical: &StoredBlob,
        alias: &BlobAliasId,
    ) -> impl Future<Output = Result<LocalBlobAliasOutcome, Self::Error>> + Send;

    fn delete_alias(
        &self,
        physical: &StoredBlob,
        alias: &BlobAliasId,
    ) -> impl Future<Output = Result<LocalBlobAliasDeleteOutcome, Self::Error>> + Send;
}

#[derive(Clone, Debug)]
pub struct LocalBlobStore<E = HostBlobKeyEntropy> {
    root: PathBuf,
    entropy: E,
}

impl LocalBlobStore<HostBlobKeyEntropy> {
    pub async fn open(root: impl AsRef<Path>) -> Result<Self, LocalBlobStoreError> {
        Self::open_with_entropy(root, HostBlobKeyEntropy).await
    }
}

impl<E: BlobKeyEntropy> LocalBlobStore<E> {
    async fn open_with_entropy(
        root: impl AsRef<Path>,
        entropy: E,
    ) -> Result<Self, LocalBlobStoreError> {
        let requested = root.as_ref();
        match fs::symlink_metadata(requested).await {
            Ok(metadata) => ensure_directory(&metadata, PathRole::Root)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(requested)
                    .await
                    .map_err(|source| io_error("create blob root", source))?;
                let metadata = fs::symlink_metadata(requested)
                    .await
                    .map_err(|source| io_error("inspect created blob root", source))?;
                ensure_directory(&metadata, PathRole::Root)?;
            }
            Err(source) => return Err(io_error("inspect blob root", source)),
        }
        let root = fs::canonicalize(requested)
            .await
            .map_err(|source| io_error("canonicalize blob root", source))?;
        let metadata = fs::symlink_metadata(&root)
            .await
            .map_err(|source| io_error("inspect canonical blob root", source))?;
        ensure_directory(&metadata, PathRole::Root)?;
        Ok(Self { root, entropy })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    async fn put_inner(
        &self,
        namespace: &BlobNamespace,
        normalized_content_type: &str,
        bytes: Vec<u8>,
    ) -> Result<StoredBlob, LocalBlobStoreError> {
        let parent = self.ensure_namespace(namespace).await?;
        let extension = extension_for_normalized_content_type(normalized_content_type);
        for _ in 0..COLLISION_ATTEMPTS {
            let token = self.random_token()?;
            let basename = format!("blob-{token}{extension}");
            let path = parent.join(&basename);
            let mut file = match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .await
            {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(source) => return Err(io_error("create physical blob", source)),
            };
            if let Err(source) = file.write_all(&bytes).await {
                drop(file);
                let _ = fs::remove_file(&path).await;
                return Err(io_error("write physical blob", source));
            }
            if let Err(source) = file.flush().await {
                drop(file);
                let _ = fs::remove_file(&path).await;
                return Err(io_error("flush physical blob", source));
            }
            drop(file);
            let key = BlobStorageKey::parse(format!("{}/{basename}", namespace.as_str()))
                .map_err(|_| LocalBlobStoreError::Invariant("minted blob key is invalid"))?;
            return Ok(StoredBlob::new(StorageKind::Local, key));
        }
        Err(LocalBlobStoreError::CollisionBudgetExhausted)
    }

    async fn read_inner(&self, blob: &StoredBlob) -> Result<BlobReadOutcome, LocalBlobStoreError> {
        let Some((path, metadata)) = self.physical(blob).await? else {
            return Ok(BlobReadOutcome::Missing);
        };
        let expected = metadata.len();
        let bytes = fs::read(&path)
            .await
            .map_err(|source| io_error("read physical blob", source))?;
        if bytes.len() as u64 != expected {
            return Err(LocalBlobStoreError::PhysicalChangedDuringRead);
        }
        Ok(BlobReadOutcome::Found(BlobRead::exact(bytes)))
    }

    async fn delete_inner(
        &self,
        blob: &StoredBlob,
    ) -> Result<BlobDeleteOutcome, LocalBlobStoreError> {
        let Some((path, _)) = self.physical(blob).await? else {
            return Ok(BlobDeleteOutcome::AlreadyMissing);
        };
        fs::remove_file(path)
            .await
            .map_err(|source| io_error("delete physical blob", source))?;
        Ok(BlobDeleteOutcome::Deleted)
    }

    async fn materialize_alias_inner(
        &self,
        physical: &StoredBlob,
        alias: &BlobAliasId,
    ) -> Result<LocalBlobAliasOutcome, LocalBlobStoreError> {
        let Some((physical_path, _)) = self.physical(physical).await? else {
            return Ok(LocalBlobAliasOutcome::MissingPhysical);
        };
        let parent = physical_path
            .parent()
            .ok_or(LocalBlobStoreError::Invariant(
                "physical blob has no parent",
            ))?;
        let physical_basename = physical_path
            .file_name()
            .ok_or(LocalBlobStoreError::Invariant(
                "physical blob has no basename",
            ))?;
        let alias_path = parent.join(alias_basename(physical.key(), alias)?);

        match fs::symlink_metadata(&alias_path).await {
            Ok(metadata) => {
                if !metadata.file_type().is_symlink() {
                    return Err(LocalBlobStoreError::UnsafeAliasLeaf);
                }
                let old_target = fs::read_link(&alias_path)
                    .await
                    .map_err(|source| io_error("read alias target", source))?;
                self.validate_owned_alias_target(parent, &old_target)
                    .await?;
                if old_target == Path::new(physical_basename) {
                    return Ok(LocalBlobAliasOutcome::Located(
                        LocalBlobAliasPath::storage_owned(alias_path),
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source) => return Err(io_error("inspect alias leaf", source)),
        }

        for _ in 0..COLLISION_ATTEMPTS {
            let temp = parent.join(format!(".alias-temp-{}", self.random_token()?));
            match create_relative_file_symlink(Path::new(physical_basename), &temp).await {
                Ok(()) => {
                    if let Err(source) = fs::rename(&temp, &alias_path).await {
                        let _ = fs::remove_file(&temp).await;
                        return Err(io_error("atomically relink alias", source));
                    }
                    return Ok(LocalBlobAliasOutcome::Located(
                        LocalBlobAliasPath::storage_owned(alias_path),
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(source) => return Err(io_error("create temporary alias", source)),
            }
        }
        Err(LocalBlobStoreError::CollisionBudgetExhausted)
    }

    async fn delete_alias_inner(
        &self,
        physical: &StoredBlob,
        alias: &BlobAliasId,
    ) -> Result<LocalBlobAliasDeleteOutcome, LocalBlobStoreError> {
        self.assert_local(physical)?;
        let Some(parent) = self.existing_parent(physical.key()).await? else {
            return Ok(LocalBlobAliasDeleteOutcome::AlreadyMissing);
        };
        let expected_target =
            physical
                .key()
                .segments()
                .next_back()
                .ok_or(LocalBlobStoreError::Invariant(
                    "physical blob key has no basename",
                ))?;
        let alias_path = parent.join(alias_basename(physical.key(), alias)?);
        match fs::symlink_metadata(&alias_path).await {
            Ok(metadata) => {
                if !metadata.file_type().is_symlink() {
                    return Err(LocalBlobStoreError::UnsafeAliasLeaf);
                }
                let target = fs::read_link(&alias_path)
                    .await
                    .map_err(|source| io_error("read alias target before delete", source))?;
                validate_alias_target(&target)?;
                if target != Path::new(expected_target) {
                    return Ok(LocalBlobAliasDeleteOutcome::TargetMismatch);
                }
                self.validate_owned_alias_target(&parent, &target).await?;
                fs::remove_file(alias_path)
                    .await
                    .map_err(|source| io_error("unlink alias", source))?;
                Ok(LocalBlobAliasDeleteOutcome::Deleted)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Ok(LocalBlobAliasDeleteOutcome::AlreadyMissing)
            }
            Err(source) => Err(io_error("inspect alias before delete", source)),
        }
    }

    async fn ensure_namespace(
        &self,
        namespace: &BlobNamespace,
    ) -> Result<PathBuf, LocalBlobStoreError> {
        let mut current = self.root.clone();
        for segment in namespace.segments() {
            let next = current.join(segment);
            loop {
                match fs::symlink_metadata(&next).await {
                    Ok(metadata) => {
                        ensure_directory(&metadata, PathRole::PhysicalAncestor)?;
                        break;
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        match fs::create_dir(&next).await {
                            Ok(()) => continue,
                            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                            Err(source) => {
                                return Err(io_error("create blob namespace", source));
                            }
                        }
                    }
                    Err(source) => return Err(io_error("inspect blob namespace", source)),
                }
            }
            current = self
                .canonical_inside(&next, "canonicalize blob namespace")
                .await?;
        }
        Ok(current)
    }

    async fn existing_parent(
        &self,
        key: &BlobStorageKey,
    ) -> Result<Option<PathBuf>, LocalBlobStoreError> {
        let mut segments = key.segments().peekable();
        let mut current = self.root.clone();
        while let Some(segment) = segments.next() {
            if segments.peek().is_none() {
                return Ok(Some(current));
            }
            let next = current.join(segment);
            let metadata = match fs::symlink_metadata(&next).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(source) => return Err(io_error("inspect physical ancestor", source)),
            };
            ensure_directory(&metadata, PathRole::PhysicalAncestor)?;
            current = self
                .canonical_inside(&next, "canonicalize physical ancestor")
                .await?;
        }
        Err(LocalBlobStoreError::Invariant("blob key has no leaf"))
    }

    async fn physical(
        &self,
        blob: &StoredBlob,
    ) -> Result<Option<(PathBuf, std::fs::Metadata)>, LocalBlobStoreError> {
        self.assert_local(blob)?;
        let Some(parent) = self.existing_parent(blob.key()).await? else {
            return Ok(None);
        };
        let leaf = blob
            .key()
            .segments()
            .next_back()
            .ok_or(LocalBlobStoreError::Invariant("blob key has no leaf"))?;
        let path = parent.join(leaf);
        let metadata = match fs::symlink_metadata(&path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(io_error("inspect physical blob", source)),
        };
        if metadata.file_type().is_symlink() {
            return Err(LocalBlobStoreError::PhysicalSymlink);
        }
        if !metadata.is_file() {
            return Err(LocalBlobStoreError::PhysicalNotFile);
        }
        let canonical = self
            .canonical_inside(&path, "canonicalize physical blob")
            .await?;
        Ok(Some((canonical, metadata)))
    }

    async fn canonical_inside(
        &self,
        path: &Path,
        operation: &'static str,
    ) -> Result<PathBuf, LocalBlobStoreError> {
        let canonical = fs::canonicalize(path)
            .await
            .map_err(|source| io_error(operation, source))?;
        if canonical.strip_prefix(&self.root).is_err() {
            return Err(LocalBlobStoreError::EscapesRoot);
        }
        Ok(canonical)
    }

    async fn validate_owned_alias_target(
        &self,
        parent: &Path,
        target: &Path,
    ) -> Result<(), LocalBlobStoreError> {
        validate_alias_target(target)?;
        let target_path = parent.join(target);
        match fs::symlink_metadata(&target_path).await {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(LocalBlobStoreError::UnsafeAliasTarget);
                }
                self.canonical_inside(&target_path, "canonicalize existing alias target")
                    .await?;
                Ok(())
            }
            // A stale adapter-owned alias may outlive its old physical blob.
            // It remains safe to relink or unlink because no target is followed.
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(io_error("inspect existing alias target", source)),
        }
    }

    fn assert_local(&self, blob: &StoredBlob) -> Result<(), LocalBlobStoreError> {
        if blob.storage() != StorageKind::Local {
            return Err(LocalBlobStoreError::ForeignStorage {
                actual: blob.storage(),
            });
        }
        Ok(())
    }

    fn random_token(&self) -> Result<String, LocalBlobStoreError> {
        let mut bytes = [0_u8; RANDOM_BYTES];
        self.entropy
            .fill(&mut bytes)
            .map_err(LocalBlobStoreError::Entropy)?;
        Ok(hex(&bytes))
    }
}

impl<E: BlobKeyEntropy> BlobStore for LocalBlobStore<E> {
    type Error = LocalBlobStoreError;

    async fn put(
        &self,
        namespace: &BlobNamespace,
        normalized_content_type: &str,
        bytes: Vec<u8>,
    ) -> Result<StoredBlob, Self::Error> {
        self.put_inner(namespace, normalized_content_type, bytes)
            .await
    }

    async fn read(&self, blob: &StoredBlob) -> Result<BlobReadOutcome, Self::Error> {
        self.read_inner(blob).await
    }

    async fn delete(&self, blob: &StoredBlob) -> Result<BlobDeleteOutcome, Self::Error> {
        self.delete_inner(blob).await
    }
}

impl<E: BlobKeyEntropy> LocalBlobAliasStore for LocalBlobStore<E> {
    type Error = LocalBlobStoreError;

    async fn materialize_alias(
        &self,
        physical: &StoredBlob,
        alias: &BlobAliasId,
    ) -> Result<LocalBlobAliasOutcome, Self::Error> {
        self.materialize_alias_inner(physical, alias).await
    }

    async fn delete_alias(
        &self,
        physical: &StoredBlob,
        alias: &BlobAliasId,
    ) -> Result<LocalBlobAliasDeleteOutcome, Self::Error> {
        self.delete_alias_inner(physical, alias).await
    }
}

#[derive(Debug)]
pub enum LocalBlobStoreError {
    Io {
        operation: &'static str,
        source: io::Error,
    },
    Entropy(getrandom::Error),
    InvalidRoot,
    PhysicalAncestorSymlink,
    PhysicalAncestorNotDirectory,
    PhysicalSymlink,
    PhysicalNotFile,
    UnsafeAliasLeaf,
    UnsafeAliasTarget,
    EscapesRoot,
    ForeignStorage {
        actual: StorageKind,
    },
    PhysicalChangedDuringRead,
    CollisionBudgetExhausted,
    Invariant(&'static str),
}

impl fmt::Display for LocalBlobStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { operation, .. } => {
                write!(formatter, "filesystem operation failed: {operation}")
            }
            Self::Entropy(_) => formatter.write_str("blob key entropy is unavailable"),
            Self::InvalidRoot => formatter.write_str("blob root is not a backend-owned directory"),
            Self::PhysicalAncestorSymlink => {
                formatter.write_str("physical blob ancestor is a symlink")
            }
            Self::PhysicalAncestorNotDirectory => {
                formatter.write_str("physical blob ancestor is not a directory")
            }
            Self::PhysicalSymlink => formatter.write_str("physical blob leaf is a symlink"),
            Self::PhysicalNotFile => formatter.write_str("physical blob leaf is not a file"),
            Self::UnsafeAliasLeaf => {
                formatter.write_str("blob alias leaf is not an adapter-owned symlink")
            }
            Self::UnsafeAliasTarget => {
                formatter.write_str("blob alias target is not a relative physical basename")
            }
            Self::EscapesRoot => formatter.write_str("blob coordinate escapes the canonical root"),
            Self::ForeignStorage { actual } => write!(
                formatter,
                "cannot use {} coordinate with local blob storage",
                actual.as_str()
            ),
            Self::PhysicalChangedDuringRead => {
                formatter.write_str("physical blob size changed while it was read")
            }
            Self::CollisionBudgetExhausted => {
                formatter.write_str("random blob-key collision retry budget was exhausted")
            }
            Self::Invariant(message) => {
                write!(formatter, "blob adapter invariant failed: {message}")
            }
        }
    }
}

impl Error for LocalBlobStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Entropy(source) => Some(source),
            _ => None,
        }
    }
}

fn io_error(operation: &'static str, source: io::Error) -> LocalBlobStoreError {
    LocalBlobStoreError::Io { operation, source }
}

#[derive(Clone, Copy)]
enum PathRole {
    Root,
    PhysicalAncestor,
}

fn ensure_directory(
    metadata: &std::fs::Metadata,
    role: PathRole,
) -> Result<(), LocalBlobStoreError> {
    if metadata.file_type().is_symlink() {
        return Err(match role {
            PathRole::Root => LocalBlobStoreError::InvalidRoot,
            PathRole::PhysicalAncestor => LocalBlobStoreError::PhysicalAncestorSymlink,
        });
    }
    if !metadata.is_dir() {
        return Err(match role {
            PathRole::Root => LocalBlobStoreError::InvalidRoot,
            PathRole::PhysicalAncestor => LocalBlobStoreError::PhysicalAncestorNotDirectory,
        });
    }
    Ok(())
}

fn extension_for_normalized_content_type(content_type: &str) -> &'static str {
    match content_type {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "application/pdf" => ".pdf",
        "text/plain" => ".txt",
        "text/markdown" => ".md",
        "application/json" => ".json",
        "text/csv" => ".csv",
        "application/zip" => ".zip",
        "application/x-tar" => ".tar",
        "application/gzip" => ".gz",
        "audio/mpeg" => ".mp3",
        "audio/wav" => ".wav",
        "video/mp4" => ".mp4",
        "video/quicktime" => ".mov",
        _ => ".bin",
    }
}

fn alias_basename(
    physical: &BlobStorageKey,
    alias: &BlobAliasId,
) -> Result<String, LocalBlobStoreError> {
    let physical_basename =
        physical
            .segments()
            .next_back()
            .ok_or(LocalBlobStoreError::Invariant(
                "physical blob key has no basename",
            ))?;
    let extension = Path::new(physical_basename)
        .extension()
        .and_then(|value| value.to_str())
        .ok_or(LocalBlobStoreError::Invariant(
            "physical blob key has no safe extension",
        ))?;
    let basename = format!("alias-{}.{}", alias.encoded(), extension);
    BlobStorageKey::parse(format!("aliases/{basename}"))
        .map_err(|_| LocalBlobStoreError::UnsafeAliasLeaf)?;
    Ok(basename)
}

fn validate_alias_target(target: &Path) -> Result<(), LocalBlobStoreError> {
    let mut components = target.components();
    let Some(Component::Normal(name)) = components.next() else {
        return Err(LocalBlobStoreError::UnsafeAliasTarget);
    };
    if components.next().is_some() {
        return Err(LocalBlobStoreError::UnsafeAliasTarget);
    }
    let Some(name) = name.to_str() else {
        return Err(LocalBlobStoreError::UnsafeAliasTarget);
    };
    if BlobStorageKey::parse(format!("files/{name}")).is_err() {
        return Err(LocalBlobStoreError::UnsafeAliasTarget);
    }
    Ok(())
}

#[cfg(unix)]
async fn create_relative_file_symlink(target: &Path, link: &Path) -> io::Result<()> {
    fs::symlink(target, link).await
}

#[cfg(windows)]
async fn create_relative_file_symlink(target: &Path, link: &Path) -> io::Result<()> {
    fs::symlink_file(target, link).await
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(DIGITS[(byte >> 4) as usize] as char);
        encoded.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        fs as std_fs,
        sync::{Arc, Mutex},
    };

    use super::*;

    #[derive(Clone)]
    struct ScriptedEntropy(Arc<Mutex<VecDeque<u8>>>);

    impl ScriptedEntropy {
        fn new(fill_bytes: impl IntoIterator<Item = u8>) -> Self {
            Self(Arc::new(Mutex::new(fill_bytes.into_iter().collect())))
        }
    }

    impl BlobKeyEntropy for ScriptedEntropy {
        fn fill(&self, destination: &mut [u8]) -> Result<(), getrandom::Error> {
            let byte = self.0.lock().unwrap().pop_front().unwrap_or(0x7f);
            destination.fill(byte);
            Ok(())
        }
    }

    fn namespace() -> BlobNamespace {
        BlobNamespace::from_segments(["attachments", "channel-1"]).unwrap()
    }

    fn local(key: &str) -> StoredBlob {
        StoredBlob::new(StorageKind::Local, BlobStorageKey::parse(key).unwrap())
    }

    fn foreign(key: &str) -> StoredBlob {
        StoredBlob::new(StorageKind::S3, BlobStorageKey::parse(key).unwrap())
    }

    #[tokio::test]
    async fn put_mints_a_random_namespaced_key_and_uses_only_normalized_mime_for_extension() {
        let temp = tempfile::tempdir().unwrap();
        let store =
            LocalBlobStore::open_with_entropy(temp.path(), ScriptedEntropy::new([0x11, 0x22]))
                .await
                .unwrap();

        let png = store
            .put(&namespace(), "image/png", b"png".to_vec())
            .await
            .unwrap();
        let untrusted = store
            .put(
                &namespace(),
                "IMAGE/PNG; name=../../evil",
                b"opaque".to_vec(),
            )
            .await
            .unwrap();

        assert_eq!(
            png.key().as_str(),
            "attachments/channel-1/blob-11111111111111111111111111111111.png"
        );
        assert_eq!(
            untrusted.key().as_str(),
            "attachments/channel-1/blob-22222222222222222222222222222222.bin"
        );
        assert!(png.key().as_str().find("evil").is_none());
    }

    #[tokio::test]
    async fn create_new_collision_retries_without_overwriting_the_first_blob() {
        let temp = tempfile::tempdir().unwrap();
        let store = LocalBlobStore::open_with_entropy(
            temp.path(),
            ScriptedEntropy::new([0x31, 0x31, 0x32]),
        )
        .await
        .unwrap();

        let first = store
            .put(&namespace(), "application/octet-stream", b"first".to_vec())
            .await
            .unwrap();
        let second = store
            .put(&namespace(), "application/octet-stream", b"second".to_vec())
            .await
            .unwrap();

        assert_ne!(first, second);
        let BlobReadOutcome::Found(first_read) = store.read(&first).await.unwrap() else {
            panic!("first blob disappeared");
        };
        assert_eq!(first_read.bytes(), b"first");
        let BlobReadOutcome::Found(second_read) = store.read(&second).await.unwrap() else {
            panic!("second blob disappeared");
        };
        assert_eq!(second_read.bytes(), b"second");
    }

    #[tokio::test]
    async fn read_reports_exact_bytes_and_delete_is_explicitly_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let store = LocalBlobStore::open_with_entropy(temp.path(), ScriptedEntropy::new([0x41]))
            .await
            .unwrap();
        let blob = store
            .put(&namespace(), "text/plain", b"hello".to_vec())
            .await
            .unwrap();

        let BlobReadOutcome::Found(read) = store.read(&blob).await.unwrap() else {
            panic!("blob was not found");
        };
        assert_eq!(read.bytes(), b"hello");
        assert_eq!(read.actual_size(), 5);
        assert_eq!(
            store.delete(&blob).await.unwrap(),
            BlobDeleteOutcome::Deleted
        );
        assert_eq!(
            store.delete(&blob).await.unwrap(),
            BlobDeleteOutcome::AlreadyMissing
        );
        assert_eq!(store.read(&blob).await.unwrap(), BlobReadOutcome::Missing);
    }

    #[tokio::test]
    async fn foreign_storage_is_rejected_before_any_disk_lookup() {
        let temp = tempfile::tempdir().unwrap();
        let store = LocalBlobStore::open(temp.path()).await.unwrap();
        let ref_ = foreign("missing/foreign.bin");
        assert!(matches!(
            store.read(&ref_).await.unwrap_err(),
            LocalBlobStoreError::ForeignStorage {
                actual: StorageKind::S3
            }
        ));
        assert!(matches!(
            store.delete(&ref_).await.unwrap_err(),
            LocalBlobStoreError::ForeignStorage {
                actual: StorageKind::S3
            }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preexisting_symlink_ancestor_is_rejected_instead_of_followed() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("attachments")).unwrap();
        let store = LocalBlobStore::open(root.path()).await.unwrap();

        assert!(matches!(
            store
                .put(&namespace(), "text/plain", b"blocked".to_vec())
                .await
                .unwrap_err(),
            LocalBlobStoreError::PhysicalAncestorSymlink
        ));
        assert!(std_fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn physical_symlink_leaf_is_never_read_or_deleted() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std_fs::create_dir_all(root.path().join("attachments/channel-1")).unwrap();
        let leaf = root
            .path()
            .join("attachments/channel-1/blob-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin");
        symlink(outside.path(), &leaf).unwrap();
        let store = LocalBlobStore::open(root.path()).await.unwrap();
        let blob = local("attachments/channel-1/blob-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin");

        assert!(matches!(
            store.read(&blob).await.unwrap_err(),
            LocalBlobStoreError::PhysicalSymlink
        ));
        assert!(matches!(
            store.delete(&blob).await.unwrap_err(),
            LocalBlobStoreError::PhysicalSymlink
        ));
        assert!(outside.path().exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn alias_is_owned_relative_same_directory_and_relinks_atomically() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalBlobStore::open_with_entropy(
            root.path(),
            ScriptedEntropy::new([0x51, 0x52, 0x61, 0x62]),
        )
        .await
        .unwrap();
        let first = store
            .put(&namespace(), "image/png", b"first".to_vec())
            .await
            .unwrap();
        let second = store
            .put(&namespace(), "image/png", b"second".to_vec())
            .await
            .unwrap();
        let alias = BlobAliasId::from_semantic_id("attachment:a?").unwrap();

        let LocalBlobAliasOutcome::Located(path) =
            store.materialize_alias(&first, &alias).await.unwrap()
        else {
            panic!("physical blob was unexpectedly missing");
        };
        let target = std_fs::read_link(path.as_path()).unwrap();
        assert_eq!(target.components().count(), 1);
        assert_eq!(
            target,
            Path::new(first.key().segments().next_back().unwrap())
        );
        let stable_path = path.into_path();

        let LocalBlobAliasOutcome::Located(relinked) =
            store.materialize_alias(&second, &alias).await.unwrap()
        else {
            panic!("replacement blob was unexpectedly missing");
        };
        assert_eq!(relinked.as_path(), stable_path);
        assert_eq!(
            std_fs::read_link(&stable_path).unwrap(),
            Path::new(second.key().segments().next_back().unwrap())
        );
        assert_eq!(std_fs::read(&stable_path).unwrap(), b"second");

        // A delayed cleanup for the displaced generation is a normal
        // post-commit interleaving. It observes that the stable alias has moved
        // and must not unlink the new generation's live address.
        assert_eq!(
            store.delete_alias(&first, &alias).await.unwrap(),
            LocalBlobAliasDeleteOutcome::TargetMismatch
        );
        assert!(stable_path.exists());
        assert_eq!(std_fs::read(&stable_path).unwrap(), b"second");

        assert_eq!(
            store.delete_alias(&second, &alias).await.unwrap(),
            LocalBlobAliasDeleteOutcome::Deleted
        );
        assert!(!stable_path.exists());
        assert!(matches!(
            store.read(&second).await.unwrap(),
            BlobReadOutcome::Found(_)
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn absolute_or_escaping_alias_target_is_refused_and_never_unlinked() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let store = LocalBlobStore::open_with_entropy(root.path(), ScriptedEntropy::new([0x71]))
            .await
            .unwrap();
        let blob = store
            .put(&namespace(), "text/plain", b"body".to_vec())
            .await
            .unwrap();
        let alias = BlobAliasId::from_semantic_id("attachment-1").unwrap();
        let physical = root.path().join(blob.key().as_str());
        let alias_path = physical
            .parent()
            .unwrap()
            .join(alias_basename(blob.key(), &alias).unwrap());
        let outside = tempfile::NamedTempFile::new().unwrap();
        symlink(outside.path(), &alias_path).unwrap();

        assert!(matches!(
            store.materialize_alias(&blob, &alias).await.unwrap_err(),
            LocalBlobStoreError::UnsafeAliasTarget
        ));
        assert!(matches!(
            store.delete_alias(&blob, &alias).await.unwrap_err(),
            LocalBlobStoreError::UnsafeAliasTarget
        ));
        assert!(alias_path.exists());
        assert!(outside.path().exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn same_directory_alias_target_that_is_itself_a_symlink_is_refused() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let store = LocalBlobStore::open_with_entropy(root.path(), ScriptedEntropy::new([0x73]))
            .await
            .unwrap();
        let blob = store
            .put(&namespace(), "text/plain", b"body".to_vec())
            .await
            .unwrap();
        let alias = BlobAliasId::from_semantic_id("attachment-2").unwrap();
        let physical = root.path().join(blob.key().as_str());
        let parent = physical.parent().unwrap();
        let malicious_target = parent.join("blob-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.txt");
        let outside = tempfile::NamedTempFile::new().unwrap();
        symlink(outside.path(), &malicious_target).unwrap();
        let alias_path = parent.join(alias_basename(blob.key(), &alias).unwrap());
        symlink(malicious_target.file_name().unwrap(), &alias_path).unwrap();

        assert!(matches!(
            store.materialize_alias(&blob, &alias).await.unwrap_err(),
            LocalBlobStoreError::UnsafeAliasTarget
        ));
        assert_eq!(
            store.delete_alias(&blob, &alias).await.unwrap(),
            LocalBlobAliasDeleteOutcome::TargetMismatch
        );
        assert!(
            std_fs::symlink_metadata(alias_path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(outside.path().exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_root_is_rejected_before_canonicalization() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().unwrap();
        let real = tempfile::tempdir().unwrap();
        let link = parent.path().join("blob-root");
        symlink(real.path(), &link).unwrap();
        assert!(matches!(
            LocalBlobStore::open(&link).await.unwrap_err(),
            LocalBlobStoreError::InvalidRoot
        ));
    }

    #[tokio::test]
    async fn directory_leaf_is_not_a_physical_blob() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalBlobStore::open(root.path()).await.unwrap();
        std_fs::create_dir_all(root.path().join("attachments/channel-1/not-a-file.bin")).unwrap();
        let blob = local("attachments/channel-1/not-a-file.bin");
        assert!(matches!(
            store.read(&blob).await.unwrap_err(),
            LocalBlobStoreError::PhysicalNotFile
        ));
    }
}
