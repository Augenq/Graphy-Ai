use super::{forms, learning, lesson};
use fs2::FileExt;
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
pub fn mkdir(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).map_err(|e| e.to_string())
}
pub fn private_open() -> OpenOptions {
    let mut opt = OpenOptions::new();
    #[cfg(unix)]
    opt.mode(0o600);
    opt
}

/// Storage bucket of sessions (the folder name kept from the removed course layer). New sessions always use it.
pub const DEFAULT_BUCKET: &str = "00000000000000000000000000000000";
pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
pub fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
pub fn folder(d: &Value) -> Result<PathBuf, String> {
    let root = text(d, "store_dir");
    if root.is_empty() {
        return Err("Missing store_dir".into());
    }
    let id = if text(d, "bucket").is_empty() {
        DEFAULT_BUCKET
    } else {
        text(d, "bucket")
    };
    if !id
        .bytes()
        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b'-')
    {
        return Err("Invalid session bucket".into());
    }
    Ok(Path::new(root)
        .join("learning")
        .join("courses")
        .join(id)
        .join("sessions"))
}
fn path(d: &Value, create: bool) -> Result<PathBuf, String> {
    let dir = folder(d)?;
    mkdir(&dir)?;
    let p = text(d, "path");
    if p.is_empty() {
        if !create {
            return Err("Missing session path".into());
        }
        return Ok(dir.join(format!(
            "{}-{}.jsonl",
            chrono::Local::now().format("%Y%m%d-%H%M%S"),
            &Uuid::new_v4().simple().to_string()[..8]
        )));
    }
    let given = Path::new(p);
    let target = if given.is_absolute() {
        given.to_path_buf()
    } else {
        dir.join(given)
    };
    let parent = target
        .parent()
        .ok_or("Invalid session path")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if parent != dir.canonicalize().map_err(|e| e.to_string())?
        || target.extension().and_then(|s| s.to_str()) != Some("jsonl")
    {
        return Err("Session does not belong to this working directory".into());
    }
    if target.exists() {
        let resolved = target.canonicalize().map_err(|e| e.to_string())?;
        if resolved.parent() != Some(parent.as_path()) {
            return Err("Session does not belong to this working directory".into());
        }
    }
    Ok(target)
}
fn snapshot(p: &Path, d: &Value) -> Value {
    json!({"path":p.to_string_lossy(),"id":"","cwd":text(d,"cwd"),"bucket":if text(d,"bucket").is_empty(){DEFAULT_BUCKET}else{text(d,"bucket")},"events":[],"messages":[],"model":"","thinking":"off","explanation_style":"structured_reference","mode":"explain","quiz_kind":"check","deadline":null,"name":"","summary":"","boundary":0,"learning":learning::initial(),"pending_question":null,"resolved_questions":{},"operation_results":{},"warning":""})
}

fn validate(s: &Value, e: &Value) -> Result<(), String> {
    super::schema::validate(e)?;
    match text(e, "type") {
        "learning_transaction" => {
            if e["version"] != 1 || !e["result"].is_object() || text(e, "source_call").is_empty() {
                return Err("Invalid learning transaction".into());
            }
            for op in e["operations"]
                .as_array()
                .ok_or("Invalid transaction operations")?
            {
                if ![
                    "learning_plan",
                    "learning_phase",
                    "learning_assessment",
                    "learning_finished",
                    "learning_evidence_ignored",
                ]
                .contains(&text(op, "type"))
                {
                    return Err("Unsupported transaction operation".into());
                }
            }
        }
        "learning_evidence_ignored" => {
            let evidence = learning::evidence(s);
            for r in e["data"]["refs"]
                .as_array()
                .ok_or("Missing evidence references")?
            {
                if evidence[r.as_str().ok_or("Invalid evidence reference")?]["candidate"] != true {
                    return Err("Only chat candidates can be marked as non-attempts".into());
                }
            }
        }
        "learning_assessment" => {
            let a = &e["data"];
            let evidence = learning::evidence(s);
            let reference = text(a, "evidence_ref");
            if !reference.is_empty() {
                let source = &evidence[reference];
                if source.is_null()
                    || source["source_message_id"] != a["source_message_id"]
                    || source["answer"]["text"] != a["answer"]["text"]
                {
                    return Err("Assessment must reference the original learner reply".into());
                }
            }
            let batch = text(a, "batch_id");
            if !batch.is_empty() {
                let row = &s["resolved_questions"][batch];
                if row["payload"]["status"] != "submitted"
                    || row["message_id"] != a["source_message_id"]
                {
                    return Err("Assessment requires the exact submitted answer".into());
                }
                let qid = text(a, "question_id");
                let answer = row["payload"]["answers"]
                    .as_array()
                    .and_then(|xs| xs.iter().find(|x| text(x, "question_id") == qid))
                    .ok_or("Unknown submitted answer")?;
                let q = row["block"]["questions"]
                    .as_array()
                    .and_then(|xs| xs.iter().find(|x| text(x, "id") == qid))
                    .ok_or("Unknown submitted question")?;
                if a["answer"] != *answer
                    || a["question"] != q["prompt"]
                    || text(a, "topic_id") != text(q, "topic_id")
                    || (answer["status"] == "skipped") != (a["outcome"] == "skipped")
                {
                    return Err(
                        "Assessment evidence must match original question and answer".into(),
                    );
                }
                let previous = s["learning"]["assessments"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|x| text(x, "batch_id") == batch && text(x, "question_id") == qid);
                if let Some(p) = previous {
                    if a["supersedes"] != p["id"] {
                        return Err(
                            "Use supersedes to correct the latest assessment of this answer".into(),
                        );
                    }
                } else if !text(a, "supersedes").is_empty() {
                    return Err("No earlier assessment to supersede".into());
                }
            } else if !text(a, "question_id").is_empty()
                || text(a, "question").is_empty()
                || text(&a["answer"], "text").is_empty()
            {
                return Err("Chat assessment needs question and answer text".into());
            }
        }
        "question_opened" => {
            let b = &e["block"];
            forms::validate_block(b, &s["learning"])?;
            let batch = text(b, "batch_id");
            let owner = s["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| {
                    m["calls"]
                        .as_array()
                        .is_some_and(|xs| xs.iter().any(|c| text(c, "id") == batch))
                })
                .ok_or("Question must match assistant call")?;
            let call = &owner["calls"][0];
            let expected = forms::event("session.question_open", &json!({"call":call}), s)?
                .ok_or("Invalid question")?;
            if expected["block"] != *b {
                return Err("Invalid question block".into());
            }
        }
        "question_draft" => {
            forms::event(
                "session.question_draft",
                &json!({"batch_id":e["batch_id"],"answers":e["answers"],"step":e["step"]}),
                s,
            )?;
        }
        "question_resolved" => {
            let expected=forms::event("session.question_resolve",&json!({"batch_id":e["batch_id"],"answers":e["payload"]["answers"],"cancel":e["payload"]["status"]=="cancelled","late":e["payload"]["late"]==true}),s)?.ok_or("Invalid resolution")?;
            if expected["payload"] != e["payload"]
                || e["message"]["role"] != "tool"
                || e["message"]["name"] != "ask_questions"
                || e["message"]["call_id"] != e["batch_id"]
                || text(&e["message"], "id").is_empty()
            {
                return Err("Invalid question resolution".into());
            }
            let content: Value =
                serde_json::from_str(text(&e["message"], "content")).map_err(|e| e.to_string())?;
            if content != e["payload"] {
                return Err("Invalid question tool result".into());
            }
        }
        _ => (),
    }
    Ok(())
}

/// Validates a `session_mode` event and returns (mode, quiz_kind, deadline). Old journals have none (or "learn"): explain.
pub fn session_mode(e: &Value) -> Result<(&'static str, &'static str, Value), String> {
    let mode = match text(e, "mode") {
        "explain" | "learn" => "explain",
        "quiz" => "quiz",
        "materials" => "materials",
        _ => return Err("Invalid session mode".into()),
    };
    let kind = match text(e, "quiz_kind") {
        // "mock_exam" was removed as a mode; old journals that have it open as a regular check
        "" | "check" | "mock_exam" => "check",
        _ => return Err("Invalid quiz kind".into()),
    };
    let deadline = match e.get("deadline") {
        None | Some(Value::Null) => Value::Null,
        Some(v) if mode == "quiz" && v.as_f64().is_some_and(|d| d.is_finite() && d > 0.0) => {
            v.clone()
        }
        _ => return Err("Invalid deadline".into()),
    };
    Ok((mode, kind, deadline))
}
fn apply(s: &mut Value, e: &Value) -> Result<(), String> {
    let kind = text(e, "type");
    if kind.is_empty() {
        return Err("Invalid event type".into());
    }
    validate(s, e)?;
    match kind {
        "header" => {
            s["id"] = e["id"].clone();
            s["cwd"] = e["cwd"].clone();
        }
        "message" => {
            if !e["message"].is_object() {
                return Err("Invalid message".into());
            }
            s["messages"]
                .as_array_mut()
                .unwrap()
                .push(e["message"].clone());
        }
        "model" => {
            s["model"] = e["model"].clone();
            s["thinking"] = e["thinking"].clone();
        }
        "explanation_style" => {
            if ![
                "deep_dive",
                "quick_take",
                "conversational_mentor",
                "socratic",
                "structured_reference",
            ]
            .contains(&text(e, "explanation_style"))
            {
                return Err("Invalid explanation style".into());
            }
            s["explanation_style"] = json!(if text(e, "explanation_style") == "socratic" {
                "socratic"
            } else {
                "structured_reference"
            });
        }
        "session_mode" => {
            let (mode, kind, deadline) = session_mode(e)?;
            s["mode"] = json!(mode);
            s["quiz_kind"] = json!(kind);
            s["deadline"] = deadline;
        }
        // Retired response-style events remain readable in existing journals.
        "token_saver" => {}
        "name" => s["name"] = e["name"].clone(),
        "compact" => {
            s["summary"] = e["summary"].clone();
            s["boundary"] = e["boundary"].clone();
        }
        "question_opened" => {
            if !s["pending_question"].is_null()
                || s["resolved_questions"]
                    .get(text(&e["block"], "batch_id"))
                    .is_some()
            {
                return Err("A question is already open or resolved".into());
            }
            s["pending_question"] = e["block"].clone();
        }
        "question_draft" => {
            if s["pending_question"]["batch_id"] != e["batch_id"] {
                return Err("Question event does not match an open block".into());
            }
            s["pending_question"]["answers"] = e["answers"].clone();
            s["pending_question"]["step"] = e["step"].clone();
        }
        "question_resolved" => {
            if s["pending_question"]["batch_id"] != e["batch_id"] {
                return Err("Question event does not match an open block".into());
            }
            let id = text(e, "batch_id");
            s["resolved_questions"][id] = json!({"block":s["pending_question"],"payload":e["payload"],"message_id":e["message"]["id"]});
            s["pending_question"] = Value::Null;
            s["messages"]
                .as_array_mut()
                .unwrap()
                .push(e["message"].clone());
        }
        "learning_transaction" => {
            if e["version"] != 1 || !e["result"].is_object() || text(e, "source_call").is_empty() {
                return Err("Invalid learning transaction".into());
            }
            for operation in e["operations"]
                .as_array()
                .ok_or("Invalid transaction operations")?
            {
                validate(s, operation)?;
                learning::apply(&mut s["learning"], operation)?;
            }
            s["operation_results"][text(e, "source_call")] = e["result"].clone();
        }
        _ => learning::apply(&mut s["learning"], e)?,
    }
    s["events"].as_array_mut().unwrap().push(e.clone());
    Ok(())
}
fn load(p: &Path, d: &Value) -> Result<Value, String> {
    let mut s = snapshot(p, d);
    if !p.exists() {
        return Ok(s);
    }
    let mut bytes = Vec::new();
    File::open(p)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| e.to_string())?;
    let mut good = 0;
    let chunks: Vec<&[u8]> = bytes.split_inclusive(|b| *b == b'\n').collect();
    for (i, line) in chunks.iter().enumerate() {
        let parsed: Result<Value, _> = serde_json::from_slice(line);
        let result = parsed
            .map_err(|e| e.to_string())
            .and_then(|e| apply(&mut s, &e));
        if let Err(err) = result {
            if i + 1 < chunks.len() {
                return Err(format!("Invalid session record at line {}: {err}", i + 1));
            }
            // The failed event may have changed the snapshot before returning an
            // error. Rebuild from the known-good prefix only on this rare path.
            s = snapshot(p, d);
            for prefix in bytes[..good].split_inclusive(|b| *b == b'\n') {
                let event: Value = serde_json::from_slice(prefix).map_err(|e| e.to_string())?;
                apply(&mut s, &event)?;
            }
            let backup = p.with_extension(format!(
                "damaged-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            fs::write(backup, &bytes[good..]).map_err(|e| e.to_string())?;
            OpenOptions::new()
                .write(true)
                .open(p)
                .and_then(|f| f.set_len(good as u64))
                .map_err(|e| e.to_string())?;
            s["warning"] = json!("Recovered session; damaged tail was preserved separately.");
            break;
        }
        good += line.len();
    }
    if !s["events"].as_array().unwrap().is_empty() {
        let h = &s["events"][0];
        if h["type"] != "header" || h["version"] != 2 {
            return Err("Unsupported session version or working directory".into());
        }
        if good > 0 && bytes[good - 1] != b'\n' {
            OpenOptions::new()
                .append(true)
                .open(p)
                .and_then(|mut f| f.write_all(b"\n"))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(s)
}
fn append(p: &Path, s: &mut Value, mut event: Value) -> Result<(), String> {
    if !event.is_object() {
        return Err("Invalid event".into());
    }
    if event.get("time").is_none() {
        event["time"] = json!(now());
    }
    // Any failed apply or write invalidates this in-memory snapshot. The caller
    // can reload it; successful writes never clone the accumulated history.
    if let Err(error) = apply(s, &event) {
        *s = Value::Null;
        return Err(error);
    }
    let write = (|| {
        let mut file = private_open()
            .create(true)
            .append(true)
            .open(p)
            .map_err(|e| format!("storage_error: {e}"))?;
        let mut encoded = serde_json::to_vec(&event).map_err(|e| e.to_string())?;
        encoded.push(b'\n');
        file.write_all(&encoded)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("storage_error: {e}"))
    })();
    if let Err(error) = write {
        *s = Value::Null;
        return Err(error);
    }
    Ok(())
}
fn repair(p: &Path, s: &mut Value) -> Result<(), String> {
    let messages = s["messages"].as_array().ok_or("Invalid messages")?.clone();
    let answered: std::collections::HashSet<String> = messages
        .iter()
        .filter(|m| m["role"] == "tool")
        .map(|m| text(m, "call_id").to_owned())
        .collect();
    for owner in &messages {
        if let Some(calls) = owner["calls"].as_array() {
            for call in calls {
                let id = text(call, "id");
                if answered.contains(id) {
                    continue;
                }
                let name = text(call, "name");
                if let Some(result) = s["operation_results"].get(id) {
                    let message = json!({"id":Uuid::new_v4().simple().to_string(),"role":"tool","call_id":id,"name":name,"content":result.to_string()});
                    append(p, s, json!({"type":"message","message":message}))?;
                    continue;
                }
                if name == "ask_questions"
                    && calls.len() == 1
                    && !["length", "error", "aborted", "empty"].contains(&text(owner, "stop"))
                {
                    if text(&s["pending_question"], "batch_id") == id {
                        continue;
                    }
                    if s["pending_question"].is_null() {
                        let reason = crate::agent::dispatch(
                            "agent.question_policy",
                            json!({"messages":s["messages"],"call":call,"phase":s["learning"]["phase"],"resolved_questions":s["resolved_questions"].as_object().is_some_and(|x|!x.is_empty()),"min_questions":3}),
                        )?;
                        if reason.as_str() == Some("") {
                            if let Ok(Some(event)) =
                                forms::event("session.question_open", &json!({"call":call}), s)
                            {
                                append(p, s, event)?;
                                continue;
                            }
                        }
                    }
                }
                let message = json!({"id":Uuid::new_v4().simple().to_string(),"role":"tool","call_id":id,"name":name,"content":"Interrupted. Outcome unknown; inspect state before repeating.","error":true});
                append(p, s, json!({"type":"message","message":message}))?;
            }
        }
    }
    Ok(())
}
fn with_lock<F>(p: &Path, f: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<Value, String>,
{
    let lock = private_open()
        .write(true)
        .create(true)
        .open(format!("{}.lock", p.display()))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "This session is open in another process".to_string())?;
    let result = f();
    FileExt::unlock(&lock).map_err(|e| e.to_string())?;
    result
}
fn mutate(op: &str, d: &Value, p: &Path, s: &mut Value) -> Result<(), String> {
    if op == "session.append" {
        append(&p, s, d["event"].clone())?;
    } else if op.starts_with("session.question_") {
        if let Some(event) = forms::event(op, &d, s)? {
            append(&p, s, event)?;
        }
    } else if op == "session.lesson_call" {
        let call = &d["call"];
        let id = text(call, "id");
        if id.is_empty() {
            return Err("Missing operation ID".into());
        }
        let result = if let Some(result) = s["operation_results"].get(id) {
            result.clone()
        } else {
            let (operations, result) = lesson::prepare(s, call)?;
            if !operations.is_empty() {
                append(
                    &p,
                    s,
                    json!({"type":"learning_transaction","version":1,"operations":operations,"source_call":id,"result":result}),
                )?;
            }
            result
        };
        s["last_result"] = result;
    }
    Ok(())
}

/// Mutate a session snapshot while the caller holds its exclusive lifetime lock.
/// The snapshot must come from a successful create/load or a prior successful
/// call for this path. Validation failures restore the previous state; a failed
/// storage write or failed restoration invalidates the snapshot (Null).
pub fn mutate_cached(op: &str, d: Value, s: &mut Value) -> Result<(), String> {
    if !matches!(
        op,
        "session.append"
            | "session.question_open"
            | "session.question_draft"
            | "session.question_resolve"
            | "session.lesson_call"
    ) {
        return Err(format!("Unsupported cached session operation: {op}"));
    }
    if d["already_locked"] != true {
        return Err("Cached mutation requires the session lifetime lock".into());
    }
    let p = path(&d, false)?;
    if !s.is_object()
        || Path::new(text(s, "path")) != p
        || text(s, "bucket")
            != if text(&d, "bucket").is_empty() {
                DEFAULT_BUCKET
            } else {
                text(&d, "bucket")
            }
    {
        return Err("Cached snapshot does not match the session".into());
    }
    let warning = s.get("warning").cloned();
    let last_result = s.get("last_result").cloned();
    let result = mutate(op, &d, &p, s);
    if let Err(error) = &result {
        if s.is_null() && !error.starts_with("storage_error: ") {
            *s = load(&p, &d).map_err(|e| {
                format!("storage_error: Failed to restore session after validation failure: {e}")
            })?;
            if let Some(warning) = warning {
                s["warning"] = warning;
            }
            if let Some(last_result) = last_result {
                s["last_result"] = last_result;
            }
        }
    }
    result
}

pub fn dispatch(op: &str, d: Value) -> Result<Value, String> {
    if op == "session.list" {
        let dir = folder(&d)?;
        if !dir.exists() {
            return Ok(json!([]));
        }
        let mut rows = Vec::new();
        for ent in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let ent = ent.map_err(|e| e.to_string())?;
            let p = ent.path();
            if p.extension().and_then(|v| v.to_str()) != Some("jsonl") {
                continue;
            }
            let data = match fs::read_to_string(&p) {
                Ok(x) => x,
                Err(_) => continue,
            };
            let mut name = String::new();
            let mut said = 0;
            let mut style = "structured_reference".to_string();
            let (mut mode, mut quiz_kind, mut deadline) = ("explain", "check", Value::Null);
            for line in data.lines() {
                if let Ok(e) = serde_json::from_str::<Value>(line) {
                    match text(&e, "type") {
                        "name" => name = text(&e, "name").to_owned(),
                        "explanation_style" => {
                            style = if text(&e, "explanation_style") == "socratic" {
                                "socratic"
                            } else {
                                "structured_reference"
                            }
                            .to_owned()
                        }
                        "session_mode" => {
                            if let Ok(m) = session_mode(&e) {
                                (mode, quiz_kind, deadline) = m
                            }
                        }
                        "message" if e["message"]["role"] == "user" => {
                            said += 1;
                            if name.is_empty() {
                                let m = &e["message"];
                                name = m
                                    .get("display")
                                    .and_then(Value::as_str)
                                    .unwrap_or(text(m, "content"))
                                    .split_whitespace()
                                    .collect::<Vec<_>>()
                                    .join(" ")
                                    .chars()
                                    .take(65)
                                    .collect();
                            }
                        }
                        _ => (),
                    }
                }
            }
            let modified = ent
                .metadata()
                .and_then(|x| x.modified())
                .ok()
                .and_then(|x| x.duration_since(UNIX_EPOCH).ok())
                .map(|x| x.as_secs_f64())
                .unwrap_or(0.0);
            if name.is_empty() {
                name = p
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
            }
            rows.push(json!({"path":p.to_string_lossy(),"name":name,"modified":modified,"said":said,"explanation_style":style,"mode":mode,"quiz_kind":quiz_kind,"deadline":deadline}));
        }
        rows.sort_by(|a, b| {
            b["modified"]
                .as_f64()
                .partial_cmp(&a["modified"].as_f64())
                .unwrap()
        });
        return Ok(json!(rows));
    }
    let p = path(&d, op == "session.create")?;
    let run = || {
        let mut s = load(&p, &d)?;
        if s["events"].as_array().unwrap().is_empty() {
            if op != "session.create" {
                return Err("Unknown session".into());
            }
            let cwd = Path::new(text(&d, "cwd"))
                .canonicalize()
                .map_err(|e| e.to_string())?;
            let event = json!({"type":"header","version":2,"id":Uuid::new_v4().simple().to_string(),"cwd":cwd.to_string_lossy(),"created":now()});
            append(&p, &mut s, event)?;
        } else if op == "session.create" {
            return Err("Session already exists".into());
        }
        if op == "session.load" {
            repair(&p, &mut s)?;
        }
        mutate(op, &d, &p, &mut s)?;
        Ok(s)
    };
    if d["already_locked"] == true {
        run()
    } else {
        with_lock(&p, run)
    }
}

#[cfg(test)]
mod style_migration_tests {
    use super::*;

    #[test]
    fn retired_token_saver_events_do_not_affect_loaded_lessons() {
        let mut state = snapshot(Path::new("lesson.jsonl"), &json!({}));
        apply(
            &mut state,
            &json!({"type":"token_saver","packs":["minimal","quiet_tools"]}),
        )
        .unwrap();
        apply(&mut state, &json!({"type":"name","name":"Existing lesson"})).unwrap();
        assert!(state.get("token_saver").is_none());
        assert_eq!(state["name"], "Existing lesson");
        assert_eq!(state["events"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn old_styles_replay_as_explanation_and_socratic_is_preserved() {
        for (old, expected) in [
            ("deep_dive", "structured_reference"),
            ("quick_take", "structured_reference"),
            ("conversational_mentor", "structured_reference"),
            ("structured_reference", "structured_reference"),
            ("socratic", "socratic"),
        ] {
            let mut state = snapshot(Path::new("lesson.jsonl"), &json!({}));
            apply(
                &mut state,
                &json!({"type":"explanation_style", "explanation_style":old}),
            )
            .unwrap();
            assert_eq!(state["explanation_style"], expected);
        }
    }

    #[test]
    fn mode_defaults_to_explain_and_round_trips() {
        let mut state = snapshot(Path::new("lesson.jsonl"), &json!({}));
        assert_eq!(state["mode"], "explain");
        assert_eq!(state["quiz_kind"], "check");
        apply(&mut state, &json!({"type":"session_mode","mode":"quiz","quiz_kind":"mock_exam","deadline":1800.0}),
        ).unwrap();
        // legacy mock_exam journals open as a regular check
        assert_eq!((state["mode"].as_str(), state["quiz_kind"].as_str()), (Some("quiz"), Some("check")));
        assert_eq!(state["deadline"], 1800.0);
        apply(&mut state, &json!({"type":"session_mode","mode":"learn"})).unwrap();
        assert_eq!(state["mode"], "explain");
        apply(&mut state, &json!({"type":"session_mode","mode":"materials"})).unwrap();
        assert_eq!(state["mode"], "materials");
        apply(&mut state, &json!({"type":"session_mode","mode":"explain"})).unwrap();
        assert_eq!(state["mode"], "explain");
        assert!(state["deadline"].is_null());
        assert!(apply(&mut state, &json!({"type":"session_mode","mode":"exam"})).is_err());
        assert!(apply(&mut state, &json!({"type":"session_mode","mode":"explain","deadline":5})).is_err());
    }
}
