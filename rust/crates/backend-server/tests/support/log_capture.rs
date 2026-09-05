//! What an operator saw, captured as structured events.
//!
//! Test-only plumbing shared by the send-door and product-send suites through `#[path]`: it
//! decides nothing about the product, so a copy per suite would be two maintenance points
//! for one mechanical thing. The FILTERING stays with each cell — which level and which
//! event a suite cares about is part of what that suite is asserting.

use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tracing_subscriber::fmt::MakeWriter;

#[derive(Clone, Default)]
pub struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl LogBuffer {
    /// Every event recorded so far, one JSON object per line as the subscriber wrote it.
    pub fn events(&self) -> Vec<Value> {
        let bytes = self.0.lock().unwrap().clone();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

pub struct LogWriter(LogBuffer);

impl Write for LogWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogBuffer {
    type Writer = LogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriter(self.clone())
    }
}
