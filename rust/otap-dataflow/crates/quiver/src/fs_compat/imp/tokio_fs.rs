// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

//! Crash-injecting wrappers around turmoil's `tokio::fs` shim.
//!
//! Each wrapper mirrors the subset of the real `tokio::fs` API that quiver uses.
//! Before any operation that mutates on-disk state it consults the crash oracle
//! (`super::super::sim::maybe_crash`), which may panic to simulate a power loss
//! at that instant. Read-only operations pass straight through.

use std::io::{Result, SeekFrom};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};
use turmoil::fs::shim::tokio::fs as shim;

use crate::fs_compat::sim::{self, FsOp};

pub(crate) use turmoil::fs::shim::std::fs::Metadata;

/// Crash-injecting async file handle.
#[derive(Debug)]
pub(crate) struct File {
    inner: shim::File,
    path: PathBuf,
}

impl File {
    fn with_path(inner: shim::File, path: PathBuf) -> Self {
        Self { inner, path }
    }

    /// Opens a file in read-only mode. (Read-only open: no crash.)
    pub(crate) async fn open<P: AsRef<Path>>(path: P) -> Result<File> {
        let path = path.as_ref().to_path_buf();
        let inner = shim::File::open(&path).await?;
        Ok(File::with_path(inner, path))
    }

    /// Opens a file in write-only mode, creating it if it does not exist.
    /// (Mutating open: oracle first.)
    pub(crate) async fn create<P: AsRef<Path>>(path: P) -> Result<File> {
        let path = path.as_ref().to_path_buf();
        sim::maybe_crash(FsOp::OpenMutating, &path);
        let inner = shim::File::create(&path).await?;
        Ok(File::with_path(inner, path))
    }

    /// Converts a sync file (from this facade) into an async one.
    pub(crate) fn from_std(std: super::std_fs::File) -> File {
        let path = std.path_buf();
        File::with_path(shim::File::from_std(std.into_inner()), path)
    }

    /// Converts this async file into a sync file (from this facade).
    ///
    /// `async` to mirror the real `tokio::fs::File::into_std` signature so call
    /// sites can `.await` it unchanged. turmoil's conversion is synchronous, so
    /// this never actually yields.
    pub(crate) async fn into_std(self) -> super::std_fs::File {
        super::std_fs::File::from_inner(self.inner.into_std(), self.path)
    }

    /// Fsync all data and metadata. (Durability op: oracle first.)
    pub(crate) async fn sync_all(&self) -> Result<()> {
        sim::maybe_crash(FsOp::SyncAll, &self.path);
        self.inner.sync_all().await
    }

    /// Fsync file data. (Durability op: oracle first.)
    pub(crate) async fn sync_data(&self) -> Result<()> {
        sim::maybe_crash(FsOp::SyncData, &self.path);
        self.inner.sync_data().await
    }

    /// Truncate/extend. (Mutating: oracle first.)
    pub(crate) async fn set_len(&self, size: u64) -> Result<()> {
        sim::maybe_crash(FsOp::SetLen, &self.path);
        self.inner.set_len(size).await
    }

    /// Query metadata. (Read-only.)
    pub(crate) async fn metadata(&self) -> Result<Metadata> {
        self.inner.metadata().await
    }
}

impl AsyncRead for File {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for File {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize>> {
        // A write mutates on-disk (pending) state: consult the oracle first.
        sim::maybe_crash(FsOp::Write, &self.path);
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<()>> {
        // flush on the shim is a no-op (it does not reach durable storage), so
        // it is not a crash point.
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl AsyncSeek for File {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> Result<()> {
        Pin::new(&mut self.inner).start_seek(position)
    }

    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<u64>> {
        Pin::new(&mut self.inner).poll_complete(cx)
    }
}

/// Crash-injecting async open options.
///
/// Some builder methods are not exercised by the current call sites but are kept
/// for API completeness with `tokio::fs::OpenOptions`.
#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
pub(crate) struct OpenOptions {
    inner: shim::OpenOptions,
    read: bool,
    write: bool,
    append: bool,
    truncate: bool,
    create: bool,
    create_new: bool,
}

#[allow(dead_code)]
impl OpenOptions {
    pub(crate) fn new() -> Self {
        Self {
            inner: shim::OpenOptions::new(),
            ..Default::default()
        }
    }

    pub(crate) fn read(&mut self, v: bool) -> &mut Self {
        self.read = v;
        let _ = self.inner.read(v);
        self
    }

    pub(crate) fn write(&mut self, v: bool) -> &mut Self {
        self.write = v;
        let _ = self.inner.write(v);
        self
    }

    pub(crate) fn append(&mut self, v: bool) -> &mut Self {
        self.append = v;
        let _ = self.inner.append(v);
        self
    }

    pub(crate) fn truncate(&mut self, v: bool) -> &mut Self {
        self.truncate = v;
        let _ = self.inner.truncate(v);
        self
    }

    pub(crate) fn create(&mut self, v: bool) -> &mut Self {
        self.create = v;
        let _ = self.inner.create(v);
        self
    }

    pub(crate) fn create_new(&mut self, v: bool) -> &mut Self {
        self.create_new = v;
        let _ = self.inner.create_new(v);
        self
    }

    pub(crate) async fn open<P: AsRef<Path>>(&self, path: P) -> Result<File> {
        let path = path.as_ref().to_path_buf();
        // Opening with create/truncate/create_new mutates the directory entry or
        // file length, so it is a crash point. A pure read/write-without-create
        // open does not change on-disk state.
        if self.create || self.truncate || self.create_new {
            sim::maybe_crash(FsOp::OpenMutating, &path);
        }
        let inner = self.inner.open(&path).await?;
        Ok(File::with_path(inner, path))
    }
}

// ----- Free functions -----

pub(crate) async fn create_dir_all<P: AsRef<Path>>(path: P) -> Result<()> {
    let path = path.as_ref();
    sim::maybe_crash(FsOp::CreateDir, path);
    shim::create_dir_all(path).await
}

pub(crate) async fn remove_file<P: AsRef<Path>>(path: P) -> Result<()> {
    let path = path.as_ref();
    sim::maybe_crash(FsOp::RemoveFile, path);
    shim::remove_file(path).await
}

pub(crate) async fn rename<P: AsRef<Path>, Q: AsRef<Path>>(from: P, to: Q) -> Result<()> {
    let (from, to) = (from.as_ref(), to.as_ref());
    sim::maybe_crash(FsOp::Rename, from);
    shim::rename(from, to).await
}

pub(crate) async fn set_permissions<P: AsRef<Path>>(
    path: P,
    perm: super::std_fs::Permissions,
) -> Result<()> {
    let path = path.as_ref();
    sim::maybe_crash(FsOp::SetPermissions, path);
    shim::set_permissions(path, perm).await
}

// Only used on non-unix platforms (set_readonly path); allow unused elsewhere.
#[allow(dead_code)]
pub(crate) async fn metadata<P: AsRef<Path>>(path: P) -> Result<Metadata> {
    // Read-only.
    shim::metadata(path).await
}

pub(crate) async fn read<P: AsRef<Path>>(path: P) -> Result<Vec<u8>> {
    // Read-only.
    shim::read(path).await
}
