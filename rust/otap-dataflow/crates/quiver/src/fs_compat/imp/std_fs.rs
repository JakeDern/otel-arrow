// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

//! Crash-injecting wrappers around turmoil's `std::fs` shim.
//!
//! The sync `File` wrapper is what the segment writer drives through
//! `BufWriter<File>` and Arrow IPC, so intercepting writes here is how the
//! oracle crashes mid-segment-write. Before any mutating operation it consults
//! the crash oracle (`super::super::sim::maybe_crash`).

use std::io::{Read, Result, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use turmoil::fs::shim::std::fs as shim;

use crate::fs_compat::sim::{self, FsOp};

pub(crate) use turmoil::fs::shim::std::fs::{Metadata, Permissions};

/// Crash-injecting sync file handle.
#[derive(Debug)]
pub(crate) struct File {
    inner: shim::File,
    path: PathBuf,
}

impl File {
    pub(crate) fn from_inner(inner: shim::File, path: PathBuf) -> Self {
        Self { inner, path }
    }

    pub(crate) fn into_inner(self) -> shim::File {
        self.inner
    }

    pub(crate) fn path_buf(&self) -> PathBuf {
        self.path.clone()
    }

    /// Open a file in read-only mode. (Read-only: no crash.)
    pub(crate) fn open<P: AsRef<Path>>(path: P) -> Result<File> {
        let path = path.as_ref().to_path_buf();
        let inner = shim::File::open(&path)?;
        Ok(File { inner, path })
    }

    /// Query metadata. (Read-only.)
    pub(crate) fn metadata(&self) -> Result<Metadata> {
        self.inner.metadata()
    }
}

impl Read for File {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        self.inner.read(buf)
    }
}

impl Write for File {
    fn write(&mut self, buf: &[u8]) -> Result<usize> {
        sim::maybe_crash(FsOp::Write, &self.path);
        self.inner.write(buf)
    }

    fn flush(&mut self) -> Result<()> {
        // shim flush is a no-op and does not reach durable storage.
        self.inner.flush()
    }
}

impl Seek for File {
    fn seek(&mut self, pos: SeekFrom) -> Result<u64> {
        self.inner.seek(pos)
    }
}

/// Crash-injecting sync open options.
///
/// Some builder methods are not exercised by the current call sites but are kept
/// for API completeness with `std::fs::OpenOptions`.
#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
pub(crate) struct OpenOptions {
    inner: shim::OpenOptions,
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
        let _ = self.inner.read(v);
        self
    }

    pub(crate) fn write(&mut self, v: bool) -> &mut Self {
        let _ = self.inner.write(v);
        self
    }

    pub(crate) fn append(&mut self, v: bool) -> &mut Self {
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

    pub(crate) fn open<P: AsRef<Path>>(&self, path: P) -> Result<File> {
        let path = path.as_ref().to_path_buf();
        if self.create || self.truncate || self.create_new {
            sim::maybe_crash(FsOp::OpenMutating, &path);
        }
        let inner = self.inner.open(&path)?;
        Ok(File { inner, path })
    }
}

// ----- Free functions -----

pub(crate) fn metadata<P: AsRef<Path>>(path: P) -> Result<Metadata> {
    shim::metadata(path)
}

pub(crate) fn read_dir<P: AsRef<Path>>(path: P) -> Result<shim::ReadDir> {
    shim::read_dir(path)
}

pub(crate) fn create_dir_all<P: AsRef<Path>>(path: P) -> Result<()> {
    let path = path.as_ref();
    sim::maybe_crash(FsOp::CreateDir, path);
    shim::create_dir_all(path)
}

pub(crate) fn remove_file<P: AsRef<Path>>(path: P) -> Result<()> {
    let path = path.as_ref();
    sim::maybe_crash(FsOp::RemoveFile, path);
    shim::remove_file(path)
}

pub(crate) fn set_permissions<P: AsRef<Path>>(path: P, perm: Permissions) -> Result<()> {
    let path = path.as_ref();
    sim::maybe_crash(FsOp::SetPermissions, path);
    shim::set_permissions(path, perm)
}
