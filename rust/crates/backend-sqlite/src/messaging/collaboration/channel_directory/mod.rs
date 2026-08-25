//! SQLite channel-directory adapters.

mod read;

pub use read::{ChannelDirectoryStoreError, SqliteChannelDirectoryRead};
