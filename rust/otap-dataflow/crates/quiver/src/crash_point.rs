// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

//! Named points in durability-critical code where a simulation test can stop
//! the process.
//!
//! Each point sits between a filesystem mutation and the `fsync` that would
//! make it durable. A turmoil test registers a `turmoil::barriers::Barrier`
//! with `Reaction::Suspend` for one point, steps the simulation until the host
//! is parked there, and then calls `Sim::crash` + `Sim::bounce`. The crash
//! discards every filesystem operation that was not yet synced, which leaves
//! exactly the on-disk state a power loss at that line would.
//!
//! On a normal build [`crash_point`] is an empty `async fn` and compiles away.
//! Under `--cfg quiver_turmoil` it forwards to `turmoil::barriers::trigger`,
//! which is a no-op unless a test registered a barrier matching the point, so
//! the seeded `turmoil_sim` sweep is unaffected.

/// A named location where a simulation test may suspend and crash the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(quiver_turmoil), allow(dead_code))]
pub(crate) enum CrashPoint {
    /// In WAL rotation, after the active `wal` was renamed to `wal.N` (and the
    /// rename made durable) but before the fresh active `wal` file and its
    /// header are created.
    WalRotationRenamed,
    /// In WAL purge, after covered rotated `wal.N` files were removed but
    /// before the WAL directory is fsynced, so the removals are not durable.
    WalPurgeUnsynced,
}

/// Gives a simulation test the chance to suspend execution at `point`.
#[cfg(quiver_turmoil)]
pub(crate) async fn crash_point(point: CrashPoint) {
    turmoil::barriers::trigger(point).await;
}

/// Gives a simulation test the chance to suspend execution at `point`.
///
/// No-op outside the turmoil simulation build.
#[cfg(not(quiver_turmoil))]
#[inline(always)]
pub(crate) async fn crash_point(_point: CrashPoint) {}
