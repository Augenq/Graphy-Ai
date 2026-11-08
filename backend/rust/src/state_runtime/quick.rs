//! Storage bucket of chats. Chats are plain; they all live in the default bucket folder.
//! Older stores may still hold sessions in other bucket folders (former courses): they stay readable.
use super::journal::DEFAULT_BUCKET;

pub const QUICK: &str = DEFAULT_BUCKET;
