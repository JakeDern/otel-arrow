// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

//! Previous logical-size implementation, kept for comparison with
//! [`super::memory::record_batch_logical_bytes`] while its allocation-free
//! replacement is evaluated. It sizes each column through
//! [`ArrayData::get_slice_memory_size`](arrow::array::ArrayData::get_slice_memory_size),
//! which requires materializing `ArrayData` via `to_data()`.

use arrow::array::{Array, RecordBatch};
use arrow::error::ArrowError;

/// Returns the logical Arrow buffer bytes associated with `batch` using
/// `to_data().get_slice_memory_size()` per column.
pub fn record_batch_logical_bytes_old(batch: &RecordBatch) -> Result<usize, ArrowError> {
    batch.columns().iter().try_fold(0usize, |total, array| {
        let array_bytes = array.to_data().get_slice_memory_size()?;
        total.checked_add(array_bytes).ok_or_else(|| {
            ArrowError::ComputeError(
                "Integer overflow computing logical Arrow byte size".to_string(),
            )
        })
    })
}

/// Returns the logical Arrow buffer bytes for one array via `to_data()`.
pub fn array_slice_memory_size_old(array: &dyn Array) -> Result<usize, ArrowError> {
    array.to_data().get_slice_memory_size()
}
