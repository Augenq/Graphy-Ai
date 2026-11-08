use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;

pub fn initial() -> Value {
    json!({"goal":"", "phase":"diagnosis", "steps":[], "current_step":"", "assessments":[],
        "summary":"", "next_step":"", "finished":false, "skills":[], "plan_version":0, "ignored_evidence":[]})
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.chars().count() <= 100
        && s.chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}
pub fn apply(s: &mut Value, event: &Value) -> Result<(), String> {
    let d = event.get("data").unwrap_or(&Value::Null);
    match text(event, "type") {
        "learning_transaction" => {
            for e in event["operations"]
                .as_array()
                .ok_or("Invalid transaction operations")?
            {
                apply(s, e)?;
            }
        }
        "learning_plan" => {
            let steps = d["steps"].as_array().ok_or("Missing plan steps")?;
            if steps.is_empty()
                || steps.len() > 30
                || d.get("goal").is_some_and(|v| {
                    !v.as_str()
                        .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 300)
                })
            {
                return Err("Invalid plan".into());
            }
            let mut ids = HashSet::new();
            for step in steps {
                let id = text(step, "id");
                let title = text(step, "title");
                if !valid_id(id)
                    || title.trim().is_empty()
                    || title.chars().count() > 240
                    || !step
                        .as_object()
                        .is_some_and(|x| x.keys().all(|k| k == "id" || k == "title"))
                    || !ids.insert(id)
                {
                    return Err("Invalid or duplicate plan step".into());
                }
            }
            if !text(d, "goal").is_empty() {
                s["goal"] = d["goal"].clone();
            }
            s["plan_version"] = json!(s["plan_version"].as_u64().unwrap_or(0) + 1);
            s["steps"] = d["steps"].clone();
            if !steps.iter().any(|x| x["id"] == s["current_step"]) {
                s["current_step"] = json!("");
            }
        }
        "learning_phase" => {
            if !["diagnosis", "planning", "teaching", "practice", "review"]
                .contains(&text(d, "phase"))
            {
                return Err("Invalid learning phase".into());
            }
            let step = text(d, "current_step");
            if !step.is_empty()
                && !s["steps"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|x| text(x, "id") == step)
            {
                return Err("Unknown current step".into());
            }
            s["phase"] = d["phase"].clone();
            s["current_step"] = json!(step);
            s["finished"] = json!(false);
        }
        "learning_assessment" => {
            let id = text(d, "id");
            if !valid_id(id)
                || !["independent", "with_hints", "gap", "uncertain", "skipped"]
                    .contains(&text(d, "outcome"))
                || text(d, "feedback").trim().is_empty()
                || text(d, "feedback").chars().count() > 8000
                || !d["used_hints"].is_boolean()
                || d.get("supersedes")
                    .is_some_and(|v| !v.as_str().is_some_and(valid_id))
            {
                return Err("Invalid assessment".into());
            }
            if d["used_hints"] == true && d["outcome"] == "independent" {
                return Err("An answer with hints cannot be independent".into());
            }
            let rows = s["assessments"].as_array_mut().unwrap();
            if rows.iter().any(|x| text(x, "id") == id) {
                return Err("Duplicate assessment ID".into());
            }
            if !text(d, "supersedes").is_empty()
                && !rows.iter().any(|x| text(x, "id") == text(d, "supersedes"))
            {
                return Err("No earlier assessment to supersede".into());
            }
            rows.push(d.clone());
        }
        "learning_evidence_ignored" => {
            let refs = d["refs"].as_array().ok_or("Missing evidence references")?;
            if refs.len() > 8 || refs.iter().any(|x| !x.is_string()) {
                return Err("Invalid evidence references".into());
            }
            let ignored = s["ignored_evidence"].as_array_mut().unwrap();
            for r in refs {
                if !ignored.contains(r) {
                    ignored.push(r.clone());
                }
            }
        }
        "learning_finished" => {
            if text(d, "summary").trim().is_empty()
                || text(d, "summary").chars().count() > 8000
                || !d["next_step"].is_string()
                || text(d, "next_step").chars().count() > 8000
            {
                return Err("Invalid lesson summary".into());
            }
            s["summary"] = d["summary"].clone();
            s["next_step"] = d["next_step"].clone();
            s["phase"] = json!("review");
            s["finished"] = json!(true);
        }
        "learning_skill" => {
            let name = text(d, "name");
            if name.trim().is_empty()
                || name.chars().count() > 64
                || text(d, "path").trim().is_empty()
                || text(d, "path").chars().count() > 4096
                || d.get("instructions")
                    .is_some_and(|v| !v.as_str().is_some_and(|s| s.chars().count() <= 49152))
            {
                return Err("Invalid skill".into());
            }
            let skills = s["skills"].as_array_mut().unwrap();
            if let Some(old) = skills.iter_mut().find(|x| text(x, "name") == name) {
                for (k, v) in d.as_object().unwrap() {
                    old[k] = v.clone();
                }
            } else {
                skills.push(d.clone());
            }
        }
        "learning_goal" => {
            if text(d, "goal").trim().is_empty() || text(d, "goal").chars().count() > 8000 {
                return Err("Invalid goal".into());
            }
        }
        "learning_sources" | "learning_source_notes" => (),
        kind if kind.starts_with("learning_") => return Err("Unsupported learning event".into()),
        _ => (),
    }
    Ok(())
}
pub fn active(rows: &[Value]) -> Vec<Value> {
    let replaced: HashSet<&str> = rows
        .iter()
        .map(|x| text(x, "supersedes"))
        .filter(|x| !x.is_empty())
        .collect();
    rows.iter()
        .filter(|x| !replaced.contains(text(x, "id")))
        .cloned()
        .collect()
}
pub fn reference(message: &str, question: &str) -> String {
    format!(
        "E{:x}",
        Sha256::digest(format!("{message}:{question}").as_bytes())
    )[..11]
        .to_owned()
}
pub fn normalized_task(text: &str) -> String {
    let normalized: String = text.nfkc().collect();
    crate::context::casefold(&normalized)
        .replace('`', "")
        .replace("**", "")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .trim_matches(|c| matches!(c, '.' | '?' | '!' | ':' | ';'))
        .to_string()
}
pub fn assessment_evidence(row: &Value) -> String {
    if !text(row, "evidence_ref").is_empty() {
        text(row, "evidence_ref").to_owned()
    } else {
        reference(text(row, "source_message_id"), text(row, "question_id"))
    }
}
/// Evidence insertion order matches Python: all chat candidates, then submitted forms.
pub fn evidence_order(snapshot: &Value) -> Vec<String> {
    let evidence = evidence(snapshot);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    if let Some(messages) = snapshot["messages"].as_array() {
        for message in messages {
            if text(message, "role") == "user" {
                let r = reference(text(message, "id"), "");
                if evidence.get(&r).is_some() && seen.insert(r.clone()) {
                    out.push(r);
                }
            }
        }
    }
    if let Some(events) = snapshot["events"].as_array() {
        for event in events {
            if text(event, "type") != "question_resolved" {
                continue;
            }
            let row = &snapshot["resolved_questions"][text(event, "batch_id")];
            if row["payload"]["status"] != "submitted" {
                continue;
            }
            if let Some(qs) = row["block"]["questions"].as_array() {
                for q in qs {
                    let r = reference(text(row, "message_id"), text(q, "id"));
                    if evidence.get(&r).is_some() && seen.insert(r.clone()) {
                        out.push(r);
                    }
                }
            }
        }
    }
    // Snapshots supplied by callers can contain resolved forms without events.
    if let Some(items) = evidence.as_object() {
        for r in items.keys() {
            if seen.insert(r.clone()) {
                out.push(r.clone());
            }
        }
    }
    out
}
pub fn evidence(snapshot: &Value) -> Value {
    let mut result = serde_json::Map::new();
    let mut previous: Option<&Value> = None;
    if let Some(messages) = snapshot["messages"].as_array() {
        for m in messages {
            match text(m, "role") {
                "assistant" if !text(m, "content").trim().is_empty() => previous = Some(m),
                "user" => {
                    let answer = text(m, "content");
                    if let Some(p) = previous {
                        if !answer.trim().is_empty() && !answer.trim_start().starts_with('/') {
                            let id = text(m, "id");
                            let r = reference(id, "");
                            result.insert(r.clone(),json!({"evidence_ref":r,"source_message_id":id,"question":text(p,"content"),"answer":{"status":"answered","text":answer,"selected_option_ids":[],"reasoning":""},"batch_id":"","question_id":"","topic_id":"","candidate":true}));
                        }
                    }
                    previous = None;
                }
                _ => (),
            }
        }
    }
    if let Some(resolved) = snapshot["resolved_questions"].as_object() {
        for (batch, row) in resolved {
            if row["payload"]["status"] != "submitted" {
                continue;
            }
            if let (Some(qs), Some(answers)) = (
                row["block"]["questions"].as_array(),
                row["payload"]["answers"].as_array(),
            ) {
                for (q, a) in qs.iter().zip(answers) {
                    let id = text(row, "message_id");
                    let qid = text(q, "id");
                    let r = reference(id, qid);
                    result.insert(r.clone(),json!({"evidence_ref":r,"source_message_id":id,"question":q["prompt"],"answer":a,"batch_id":batch,"question_id":qid,"topic_id":text(q,"topic_id")}));
                }
            }
        }
    }
    Value::Object(result)
}
pub fn projection(s: &Value) -> Value {
    let phase = text(s, "phase");
    let label = match phase {
        "diagnosis" => "Диагностика",
        "planning" => "Планирование",
        "teaching" => "Обучение",
        "practice" => "Практика",
        "review" => "Итог",
        _ => "",
    };
    let steps = s["steps"].as_array().cloned().unwrap_or_default();
    let index = steps
        .iter()
        .position(|x| x["id"] == s["current_step"])
        .map(|i| i + 1);
    let rows = active(
        s["assessments"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );
    json!({"goal":s["goal"],"phase":phase,"phase_label":label,"steps":steps.iter().map(|x|json!({"id":x["id"],"title":x["title"]})).collect::<Vec<_>>(),"current_step":s["current_step"],"current_index":index,"finished":s["finished"],"summary":s["summary"],"next_step":s["next_step"],"assessments":rows.iter().map(assessment_row).collect::<Vec<_>>()})
}
pub fn assessment_row(a: &Value) -> Value {
    json!({"id":a["id"],"question":if text(a,"task").is_empty(){text(a,"question")}else{text(a,"task")},"outcome":a["outcome"],"feedback":text(a,"feedback"),"used_hints":a["used_hints"].as_bool().unwrap_or(false),"topic_id":text(a,"topic_id"),"supersedes":text(a,"supersedes"),"mode":a["mode"],"hint_level":a["hint_level"],"hint_log":a["hint_log"],"error_type":a["error_type"]})
}
fn context(s: &Value) -> Value {
    let steps = s["steps"].as_array().cloned().unwrap_or_default();
    let current = steps
        .iter()
        .position(|x| x["id"] == s["current_step"])
        .map(|i| i + 1);
    let rows = active(
        s["assessments"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );
    let observations = rows
        .iter()
        .skip(rows.len().saturating_sub(6))
        .map(|a| {
            let mut row = serde_json::Map::new();
            for k in ["id", "evidence_ref", "topic_id", "outcome", "assistance"] {
                if let Some(v) = a.get(k) {
                    row.insert(k.into(), v.clone());
                }
            }
            row.insert(
                "feedback".into(),
                json!(text(a, "feedback").chars().take(300).collect::<String>()),
            );
            Value::Object(row)
        })
        .collect::<Vec<_>>();
    let mut output = json!({"goal":s["goal"],"phase":s["phase"],"plan_version":s["plan_version"],"plan":steps.iter().map(|x|x["title"].clone()).collect::<Vec<_>>(),"step":current,"observations":observations,"summary":s["summary"],"next_step":s["next_step"],"finished":s["finished"],"loaded_skills":s["skills"].as_array().into_iter().flatten().map(|x|x["name"].clone()).collect::<Vec<_>>()});
    output.as_object_mut().unwrap().retain(|_, v| {
        !v.is_null() && v != "" && v != false && v != 0 && !v.as_array().is_some_and(Vec::is_empty)
    });
    output
}
pub fn dispatch(op: &str, d: Value) -> Result<Value, String> {
    match op {
        "learning.fold" => {
            let mut s = initial();
            for e in d["events"].as_array().ok_or("Missing events")? {
                apply(&mut s, e)?;
            }
            Ok(s)
        }
        "learning.context" => Ok(context(&d["learning"])),
        "learning.projection" => Ok(projection(&d["learning"])),
        "learning.evidence" => Ok(evidence(&d["session"])),
        _ => Err("Unknown learning operation".into()),
    }
}
