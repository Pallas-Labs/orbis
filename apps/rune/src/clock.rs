//! The app's wall clock. Headless renders freeze it at one instant in UTC ([`freeze`]), and a
//! test freezes it on its own thread ([`freeze_here`]), so a scene that says "2 min ago" or
//! "Friday" says the same on every run and in every time zone. Read time only through [`now`].

use std::cell::Cell;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// The instant a frozen clock shows: Friday 15 January 2027, 08:00 UTC.
pub const FROZEN_AT: f64 = 1_800_000_000.0;

static FROZEN: OnceLock<f64> = OnceLock::new();

thread_local! {
    /// A test's frozen clock, on its thread alone: tests run side by side.
    static FROZEN_HERE: Cell<Option<f64>> = const { Cell::new(None) };
}

/// Stops the clock at [`FROZEN_AT`] for the rest of the process. Call it before the first [`now`].
pub fn freeze() {
    FROZEN.get_or_init(|| FROZEN_AT);
}

/// Stops the clock at [`FROZEN_AT`] on this thread alone.
#[cfg(test)]
pub fn freeze_here() {
    FROZEN_HERE.set(Some(FROZEN_AT));
}

/// Seconds since 1970, UTC.
#[allow(dead_code)] // Remove once the app shows a time.
pub fn now() -> f64 {
    let frozen = FROZEN_HERE.get().or_else(|| FROZEN.get().copied());
    frozen.unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64()))
}
