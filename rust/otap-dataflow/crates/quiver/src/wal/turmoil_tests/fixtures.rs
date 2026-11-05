// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

//! Minimal `RecordBundle` fixtures for the turmoil WAL simulation tests.
//!
//! The rich fixtures in `wal/tests.rs` live in a `#[cfg(test)]` module that is
//! not reachable from the `turmoil_tests` module, so this file provides the one
//! single-slot bundle shape the rotation-crash repro needs.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use arrow_array::{Int64Array, RecordBatch};
use arrow_schema::{DataType, Field, Schema};

use crate::record_bundle::{BundleDescriptor, PayloadRef, RecordBundle, SchemaFingerprint, SlotId};

/// A single-slot in-memory bundle carrying one Int64 column.
pub(super) struct FixtureBundle {
    descriptor: BundleDescriptor,
    ingestion_time: SystemTime,
    fingerprint: SchemaFingerprint,
    batch: RecordBatch,
}

impl RecordBundle for FixtureBundle {
    fn descriptor(&self) -> &BundleDescriptor {
        &self.descriptor
    }

    fn ingestion_time(&self) -> SystemTime {
        self.ingestion_time
    }

    fn payload(&self, slot: SlotId) -> Option<PayloadRef<'_>> {
        if slot == SlotId::new(0) {
            Some(PayloadRef {
                schema_fingerprint: self.fingerprint,
                batch: &self.batch,
            })
        } else {
            None
        }
    }

    fn item_count(&self) -> u64 {
        self.batch.num_rows() as u64
    }
}

fn build_batch(value: i64) -> RecordBatch {
    let schema = Arc::new(Schema::new(vec![Field::new(
        "value",
        DataType::Int64,
        false,
    )]));
    let array = Int64Array::from(vec![value; 8]);
    RecordBatch::try_new(schema, vec![Arc::new(array)]).expect("valid batch")
}

/// Builds a single-slot bundle whose schema fingerprint is seeded by
/// `fingerprint_seed` and whose single Int64 column is filled with `value`.
pub(super) fn single_slot_bundle(
    descriptor: &BundleDescriptor,
    fingerprint_seed: u8,
    value: i64,
) -> FixtureBundle {
    FixtureBundle {
        descriptor: descriptor.clone(),
        ingestion_time: UNIX_EPOCH + Duration::from_secs(42),
        fingerprint: [fingerprint_seed; 32],
        batch: build_batch(value),
    }
}
