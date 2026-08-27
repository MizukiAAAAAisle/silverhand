//! The machine's runtime catalogue: what the machine this process runs on has
//! installed, read once per window by a component the process owns.
//!
//! A namespace declares and re-exports only, so the cached detector itself is the
//! `detector` leaf; `machine`, `search` and `version` are the three facts it reads —
//! what this machine is, where executables may live, and what a binary says its
//! version is.

mod detector;
mod machine;
mod search;
mod version;

pub use detector::{
    DETECTION_WINDOW, DetectionClock, MachineRuntimeDetector, SystemDetectionClock,
};
pub use machine::{DetectionPlatform, MachineFacts};
