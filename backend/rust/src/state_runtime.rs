//! Durable local learning state. All paths are explicit; secrets are never stored here.
pub mod forms;
mod journal;
mod learning;
mod legacy;
mod lesson;
mod migration;
mod projections;
pub mod quick;
mod schema;
mod skill_library;
mod skills;
pub mod strategy;
mod study;
pub mod teaching;
mod usage;
mod wire;

use serde_json::Value;

/// Execute a state operation. Session operations use `store_dir`,
/// `cwd` and (except create/list) a `path` in the session directory.
pub fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    match op {
        "session.create"
        | "session.load"
        | "session.append"
        | "session.list"
        | "session.question_open"
        | "session.question_draft"
        | "session.question_resolve"
        | "session.lesson_call" => journal::dispatch(op, data),
        "session.context" | "session.usage" | "session.needs_continuation" => {
            projections::dispatch(op, data)
        }
        "usage.overview" => usage::dispatch(op, data),
        _ if op.starts_with("study.") => study::dispatch(op, data),
        _ if op.starts_with("teaching.") => teaching::dispatch(op, data),
        "migration.purge_coding_sessions" => migration::dispatch(data),
        "skills.list" | "skills.load" => skills::dispatch(op, data),
        _ if op.starts_with("skills.") => skill_library::dispatch(op, data),
        "learning.context" | "learning.fold" | "learning.projection" | "learning.evidence" => {
            learning::dispatch(op, data)
        }
        _ if op.starts_with("strategy.") => strategy::dispatch(op, data),
        "wire.public_call"
        | "wire.public_result"
        | "wire.public_message"
        | "wire.history"
        | "wire.public_question"
        | "wire.resolved_questions" => wire::dispatch(op, data),
        _ => Err(format!("Unknown state operation: {op}")),
    }
}

/// Mutate a trusted session snapshot under the caller's lifetime session lock.
/// Validation failures restore the snapshot. Storage errors invalidate it and must be latched.
pub fn mutate_cached(op: &str, data: Value, snapshot: &mut Value) -> Result<(), String> {
    journal::mutate_cached(op, data, snapshot)
}
