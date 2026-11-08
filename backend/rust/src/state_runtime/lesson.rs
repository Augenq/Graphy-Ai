use super::{journal::text, learning};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
fn pending(s: &Value) -> Result<Vec<String>, String> {
    let evidence = learning::evidence(s);
    let rows = learning::active(
        s["learning"]["assessments"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );
    let mut out = Vec::new();
    {
        for r in learning::evidence_order(s) {
            let source = &evidence[&r];
            if rows.iter().any(|a| learning::assessment_evidence(a) == r)
                || s["learning"]["ignored_evidence"]
                    .as_array()
                    .is_some_and(|x| x.contains(&json!(r)))
            {
                continue;
            }
            let candidate =
                crate::context::dispatch("context.candidate_attempt", json!({"source":source}))?;
            if candidate == true {
                out.push(r.clone())
            }
        }
    }
    Ok(out)
}
fn obj_keys(v: &Value, allowed: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|x| x.keys().all(|k| allowed.contains(&k.as_str())))
}
pub fn prepare(s: &Value, call: &Value) -> Result<(Vec<Value>, Value), String> {
    if !s["pending_question"].is_null() {
        return Err("Resolve the open question first".into());
    }
    if super::legacy::is_legacy(call) {
        return super::legacy::prepare(s, call);
    }
    let name = text(call, "name");
    let args = &call["arguments"];
    let state = &s["learning"];
    let steps = state["steps"].as_array().ok_or("Invalid learning state")?;
    let mut ops = Vec::new();
    let result;
    match name {
        "set_learning_plan" => {
            if !obj_keys(args, &["goal", "steps", "step"])
                || !args["goal"].is_string()
                || text(args, "goal").chars().count() > 300
            {
                return Err("Invalid plan goal".into());
            }
            let titles = args["steps"].as_array().ok_or("Missing plan steps")?;
            if titles.is_empty() || titles.len() > 30 {
                return Err("Invalid plan steps".into());
            }
            let mut seen = HashSet::new();
            let mut clean = Vec::new();
            for t in titles {
                let t = t.as_str().ok_or("Invalid plan title")?.trim();
                if t.is_empty() || t.chars().count() > 240 || !seen.insert(t.to_lowercase()) {
                    return Err("Use distinct nonempty step titles".into());
                }
                clean.push(t.to_string());
            }
            let requested_step = match args.get("step") {
                None | Some(Value::Null) => None,
                Some(v) => Some(
                    v.as_u64()
                        .filter(|n| *n > 0 && (*n as usize) <= clean.len())
                        .ok_or("Invalid step")? as usize,
                ),
            };
            if state["goal"] == args["goal"]
                && requested_step.is_none_or(|n| {
                    steps
                        .get(n - 1)
                        .is_some_and(|step| step["id"] == state["current_step"])
                })
                && steps
                    .iter()
                    .map(|s| text(s, "title"))
                    .eq(clean.iter().map(String::as_str))
            {
                return Ok((
                    ops,
                    json!({"recorded":"unchanged","step":state["current_step"]}),
                ));
            }
            let mut used = HashSet::new();
            for e in s["events"].as_array().ok_or("Missing events")? {
                let entries = e["operations"]
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![e.clone()]);
                for entry in entries {
                    if entry["type"] == "learning_plan" {
                        if let Some(rows) = entry["data"]["steps"].as_array() {
                            for row in rows {
                                used.insert(text(row, "id").to_owned());
                            }
                        }
                    }
                }
            }
            let mut new_steps = Vec::new();
            for title in clean {
                let old = if state["goal"] == args["goal"] {
                    steps.iter().find(|x| text(x, "title") == title)
                } else {
                    None
                };
                let identifier = if let Some(old) = old {
                    text(old, "id").to_owned()
                } else {
                    let mut n = 1;
                    while used.contains(&format!("s{n}")) {
                        n += 1
                    }
                    format!("s{n}")
                };
                used.insert(identifier.clone());
                new_steps.push(json!({"id":identifier,"title":title}));
            }
            let current = requested_step
                .map(|n| &new_steps[n - 1])
                .or_else(|| new_steps.iter().find(|x| x["id"] == state["current_step"]))
                .unwrap_or(&new_steps[0])["id"]
                .clone();
            let phase = if ["diagnosis", "planning", "review"].contains(&text(state, "phase")) {
                "teaching"
            } else {
                text(state, "phase")
            };
            let pos = new_steps.iter().position(|x| x["id"] == current).unwrap() + 1;
            ops.push(
                json!({"type":"learning_plan","data":{"goal":args["goal"],"steps":new_steps}}),
            );
            ops.push(
                json!({"type":"learning_phase","data":{"phase":phase,"current_step":current}}),
            );
            result = json!({"recorded":"learning_plan","step":pos,"next":"Plan saved. Now write this step's explanation in this turn."});
        }
        "finish_lesson" => {
            if !obj_keys(args, &["summary", "next_step"])
                || text(args, "summary").trim().is_empty()
                || !args["next_step"].is_string()
                || text(args, "summary").chars().count() > 8000
                || text(args, "next_step").chars().count() > 8000
            {
                return Err("Invalid lesson summary".into());
            }
            if state["finished"] == true
                && state["summary"] == args["summary"]
                && state["next_step"] == args["next_step"]
            {
                return Ok((ops, json!({"recorded":"unchanged"})));
            }
            ops.push(json!({"type":"learning_finished","data":args}));
            result = json!({"recorded":"learning_finished"});
        }
        "record_assessment" => return assess(s, args),
        _ => return Err("Unknown lesson tool".into()),
    }
    Ok((ops, result))
}

fn python_string(s: &str) -> String {
    use std::fmt::Write;
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if !(' '..='~').contains(&c) => {
                let mut units = [0; 2];
                for u in c.encode_utf16(&mut units) {
                    write!(&mut out, "\\u{u:04x}").unwrap();
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
fn assessment_id(
    reference: &str,
    task: &str,
    outcome: &str,
    assistance: &str,
    feedback: &str,
    previous: Option<&Value>,
) -> String {
    // Python json.dumps([key, content, prior], sort_keys=True) uses ASCII escapes
    // and spaces after separators; its bytes are part of the durable identifier.
    let prior = previous
        .map(|p| python_string(text(p, "id")))
        .unwrap_or_else(|| "null".into());
    let encoded = format!(
        "[[{}, {}], {{\"assistance\": {}, \"feedback\": {}, \"outcome\": {}}}, {}]",
        python_string(reference),
        python_string(task),
        python_string(assistance),
        python_string(feedback),
        python_string(outcome),
        prior
    );
    format!("A{:x}", Sha256::digest(encoded.as_bytes()))[..11].to_string()
}
const LADDER_TOP: u64 = 4;
/// Hint fields as stored in the journal (`hint_level`, `hint_log`, `error_type`), copied from a validated item.
fn stored_hint_fields(item: &Value) -> Value {
    let mut out = json!({});
    if let Some(l) = item["hint_level"].as_u64() {
        out["hint_level"] = json!(l.min(LADDER_TOP));
    }
    let log: Vec<Value> = item["hint_log"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let level = e["level"].as_u64()?.clamp(1, LADDER_TOP);
            let note: String = text(e, "note").chars().take(200).collect();
            Some(if note.is_empty() {
                json!({"level":level})
            } else {
                json!({"level":level,"note":note})
            })
        })
        .take(8)
        .collect();
    if !log.is_empty() {
        out["hint_log"] = json!(log);
    }
    if let Some(t) = item["error_type"].as_str().filter(|t| !t.is_empty()) {
        out["error_type"] = json!(t.chars().take(100).collect::<String>());
    }
    out
}
/// Optional hint/error fields of an assessment item (additive metadata).
fn hint_fields_valid(item: &Value) -> bool {
    let level_ok = |v: &Value| v.as_u64().is_some_and(|n| n <= LADDER_TOP);
    item.get("hint_level")
        .is_none_or(|v| v.is_null() || level_ok(v))
        && item.get("hint_log").is_none_or(|v| {
            v.is_null()
                || v.as_array().is_some_and(|a| {
                    a.len() <= 8
                        && a.iter().all(|e| {
                            e["level"]
                                .as_u64()
                                .is_some_and(|n| (1..=LADDER_TOP).contains(&n))
                                && e.get("note").is_none_or(|n| n.is_string())
                        })
                })
        })
        && item
            .get("error_type")
            .is_none_or(|v| v.is_null() || v.as_str().is_some_and(|t| t.chars().count() <= 100))
}
fn assess(s: &Value, args: &Value) -> Result<(Vec<Value>, Value), String> {
    if !obj_keys(args, &["items", "ignore_refs"]) {
        return Err("Invalid assessment arguments".into());
    }
    let items = args["items"].as_array().ok_or("Missing assessment items")?;
    let ignored = match args.get("ignore_refs") {
        None | Some(Value::Null) => vec![],
        Some(v) => v.as_array().ok_or("Invalid ignored evidence")?.clone(),
    };
    let mut unique = HashSet::new();
    if ignored.len() > 8
        || ignored
            .iter()
            .any(|v| v.as_str().map_or(true, |s| !unique.insert(s)))
    {
        return Err("Invalid ignored evidence".into());
    }
    if items.len() > 8 {
        return Err("Too many assessments".into());
    }
    let evidence = learning::evidence(s);
    let active = learning::active(
        s["learning"]["assessments"]
            .as_array()
            .ok_or("Invalid assessments")?,
    );
    let prior_pending = pending(s)?;
    if items.is_empty() && ignored.is_empty() {
        if !prior_pending.is_empty() {
            return Err("Provide actual assessment items or ignore_refs for pending non-attempt chat replies".into());
        }
        return Ok((
            vec![],
            json!({"saved":[],"unassessed":[],"note":"No pending attempts; no assessment was created."}),
        ));
    }
    if items.iter().any(|i| ignored.contains(&i["evidence_ref"])) {
        return Err("An answer cannot be both assessed and ignored".into());
    }
    let mut operations = Vec::new();
    let mut saved = Vec::new();
    let mut seen = HashSet::new();
    let mut auto_ignored = Vec::new();
    for item in items {
        if !obj_keys(
            item,
            &[
                "evidence_ref",
                "outcome",
                "assistance",
                "feedback",
                "correction",
                "task",
                "hint_level",
                "hint_log",
                "error_type",
            ],
        ) || !item["evidence_ref"].is_string()
            || !["independent", "with_hints", "gap", "uncertain", "skipped"]
                .contains(&text(item, "outcome"))
            || !["none", "hints", "solution", "unknown"].contains(&text(item, "assistance"))
            || !item["feedback"].is_string()
            || item
                .get("correction")
                .is_some_and(|v| !v.is_null() && !v.is_boolean())
            || item
                .get("task")
                .is_some_and(|v| !v.is_null() && !v.is_string())
            || !hint_fields_valid(item)
        {
            return Err("Invalid assessment item".into());
        }
        let r = text(item, "evidence_ref");
        let source = &evidence[r];
        if source.is_null() {
            return Err(format!(
                "Use ONE supplied evidence_ref per item; never join references. Available: {}",
                prior_pending
                    .iter()
                    .rev()
                    .take(8)
                    .rev()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if source["candidate"] == true
            && crate::context::dispatch("context.candidate_attempt", json!({"source":source}))?
                != true
        {
            auto_ignored.push(json!(r));
            continue;
        }
        let mut task = text(item, "task").to_owned();
        let mut task_source = None;
        if !task.is_empty() {
            let normalized = learning::normalized_task(&task);
            let source_message = text(source, "source_message_id");
            let content = if source["candidate"] == true {
                let messages = s["messages"].as_array().ok_or("Invalid messages")?;
                messages
                    .iter()
                    .take_while(|m| text(m, "id") != source_message)
                    .filter(|m| ["user", "assistant"].contains(&text(m, "role")))
                    .collect::<Vec<_>>()
            } else {
                vec![source]
            };
            task_source = content
                .iter()
                .rev()
                .find(|m| {
                    let content = if source["candidate"] == true {
                        text(m, "content")
                    } else {
                        text(m, "question")
                    };
                    learning::normalized_task(content).contains(&normalized)
                })
                .map(|m| {
                    if source["candidate"] == true {
                        text(m, "id").to_owned()
                    } else {
                        source_message.to_owned()
                    }
                });
            if task_source.is_none() {
                return Err("Omit task for a single-task reply; otherwise quote the original task without paraphrasing".into());
            }
        }
        let normalized = learning::normalized_task(&task);
        let key = (r.to_owned(), normalized.clone());
        if !seen.insert(key) {
            return Err("Duplicate evidence/task in one assessment batch".into());
        }
        let outcome = text(item, "outcome");
        let assistance = text(item, "assistance");
        if outcome == "independent" && assistance != "none" {
            return Err("independent requires assistance=none".into());
        }
        if outcome == "with_hints" && !["hints", "solution"].contains(&assistance) {
            return Err("with_hints requires assistance=hints or solution".into());
        }
        if source["candidate"] != true {
            if (source["answer"]["status"] == "skipped") != (outcome == "skipped") {
                return Err("Skipped submissions require outcome=skipped".into());
            }
            if source["answer"]["status"] == "dont_know" && outcome != "gap" {
                return Err("\"I don't know\" is a declared gap: use outcome=gap".into());
            }
            let resolved = &s["resolved_questions"][text(source, "batch_id")];
            if let Some(correct) = resolved["payload"]["formal_results"]
                .as_array()
                .and_then(|xs| {
                    xs.iter()
                        .find(|x| x["question_id"] == source["question_id"])
                })
                .and_then(|x| x["correct"].as_bool())
            {
                if correct && outcome == "gap"
                    || !correct && ["independent", "with_hints"].contains(&outcome)
                {
                    return Err("Outcome contradicts the committed answer key".into());
                }
            }
        }
        let question = if task.is_empty() {
            text(source, "question").to_owned()
        } else {
            task.clone()
        };
        let mut previous = active.iter().find(|a| {
            learning::assessment_evidence(a) == r
                && learning::normalized_task(text(a, "task")) == normalized
        });
        let same_ref = active
            .iter()
            .filter(|a| learning::assessment_evidence(a) == r)
            .collect::<Vec<_>>();
        if previous.is_none() && task.is_empty() && same_ref.len() == 1 {
            previous = Some(same_ref[0]);
            task = text(same_ref[0], "task").to_owned();
        }
        if let Some(p) = previous {
            if p["outcome"] == item["outcome"]
                && p["assistance"] == item["assistance"]
                && p["feedback"] == item["feedback"]
            {
                saved.push(p["id"].clone());
                continue;
            }
            if item["correction"] != true {
                return Err("Assessment already exists. Set correction=true to deliberately revise this same original attempt".into());
            }
        }
        let id = assessment_id(
            r,
            &normalized,
            outcome,
            assistance,
            text(item, "feedback"),
            previous,
        );
        let mut answer = source["answer"].clone();
        if source["candidate"] == true && outcome == "skipped" {
            answer["status"] = json!("skipped");
        }
        let mut data = json!({"id":id,"evidence_ref":r,"source_message_id":source["source_message_id"],"batch_id":source["batch_id"],"question_id":source["question_id"],"topic_id":source["topic_id"],"question":question,"answer":answer,"task":task,"outcome":outcome,"assistance":assistance,"feedback":item["feedback"],"used_hints":(["hints","solution"].contains(&assistance))});
        if s["mode"] == "quiz" {
            data["mode"] = json!("quiz");
        }
        if let Some(extra) = stored_hint_fields(item).as_object() {
            data.as_object_mut().unwrap().extend(extra.clone());
        }
        if let Some(p) = previous {
            data["supersedes"] = p["id"].clone();
        }
        if let Some(id) = task_source {
            data["task_source_message_id"] = json!(id);
        }
        operations.push(json!({"type":"learning_assessment","data":data}));
        saved.push(json!(id));
    }
    if !auto_ignored.is_empty() {
        let mut unique = Vec::new();
        for item in &auto_ignored {
            if !unique.contains(item) {
                unique.push(item.clone());
            }
        }
        operations.push(json!({"type":"learning_evidence_ignored","data":{"refs":unique}}));
    }
    if !ignored.is_empty() {
        operations.push(json!({"type":"learning_evidence_ignored","data":{"refs":ignored}}));
    }
    let remaining = prior_pending
        .into_iter()
        .filter(|r| {
            !items.iter().any(|i| text(i, "evidence_ref") == r) && !ignored.contains(&json!(r))
        })
        .collect::<Vec<_>>();
    let mut result = json!({"saved":saved,"unassessed":remaining.iter().rev().take(8).rev().collect::<Vec<_>>()});
    if !auto_ignored.is_empty() {
        result["ignored"] = json!(auto_ignored);
        result["note"]=json!("These messages are requests or acknowledgements, not skipped exercises or assessed skill.");
    }
    Ok((operations, result))
}
