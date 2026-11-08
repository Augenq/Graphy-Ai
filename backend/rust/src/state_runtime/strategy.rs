//! Transparent, editable strategy memory ("Память").
//!
//! What the tutor did before a learner's graded attempt (explanation form, style, hint level)
//! is paired with the result of that attempt and kept as a plain-language **observation** in
//! `learning/memory/observations.jsonl` (append-only; edits and deletes are further events).
//! A small deterministic rule engine (`rules`) turns the active observations into a **profile**;
//! every change of the profile is a versioned snapshot with a human-readable reason. The profile
//! becomes a short "learner notes" block in the lesson context (`notes`), always as data and
//! never above the learner's explicit request. Journals stay the source of truth: the observation
//! log can be rebuilt from them (`strategy.rescan`).
//!
//! Interface kept for a later contextual bandit: `rules::choose(context) -> Choice` (strategy + reason).
mod notes;
mod observe;
mod rules;
mod store;

use super::journal::text;
use serde_json::{json, Value};

pub use rules::{choose, Choice};

pub fn dispatch(op: &str, d: Value) -> Result<Value, String> {
    let root = text(&d, "store_dir");
    if root.is_empty() {
        return Err("Missing store_dir".into());
    }
    let now = super::journal::now();
    let store = store::Store::new(root);
    match op {
        "strategy.overview" => store.overview(now),
        "strategy.observe" => store.observe_session(&d["session"], now),
        "strategy.rescan" => store.rescan(now),
        "strategy.notes" => Ok(json!({"notes": store.notes(now)})),
        "strategy.edit" => store.edit(text(&d, "id"), d.get("text"), d.get("tag"), now),
        "strategy.delete" => store.delete(text(&d, "id"), now),
        "strategy.rollback" => {
            let v = d["version"].as_u64().ok_or("Missing version")?;
            store.rollback(v, now)
        }
        "strategy.settings" => store.set_settings(&d, now),
        _ => Err("Unknown strategy operation".into()),
    }
}

#[cfg(test)]
mod tests;
