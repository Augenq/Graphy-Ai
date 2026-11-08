use super::{journal::text, learning};
use serde_json::{json, Value};
fn call(c: &Value) -> Value {
    let mut args = c["arguments"].clone();
    if c["name"] == "ask_questions" {
        if let Some(qs) = args["questions"].as_array_mut() {
            for q in qs {
                if let Some(o) = q.as_object_mut() {
                    o.remove("correct");
                    o.remove("rubric");
                    o.remove("grading");
                }
            }
        }
    }
    let mut row = json!({"id":c["id"],"name":c["name"],"arguments":args});
    if c["argument_error"].as_bool().unwrap_or(false)
        || c["argument_error"].as_str().is_some_and(|s| !s.is_empty())
    {
        row["argument_error"] = c["argument_error"].clone();
    }
    row
}
fn ui(session: &Value, id: &str) -> Option<Value> {
    let e = session["events"]
        .as_array()?
        .iter()
        .rev()
        .find(|e| e["type"] == "learning_transaction" && text(e, "source_call") == id)?;
    let mut steps: Vec<Value> = Vec::new();
    let mut plan: Option<Vec<Value>> = None;
    for op in e["operations"].as_array()? {
        let d = &op["data"];
        match text(op, "type") {
            "learning_plan" => {
                let p = d["steps"].as_array()?.clone();
                steps.push(json!({"kind":"plan","goal":text(d,"goal"),"steps":p.iter().map(|s|s["title"].clone()).collect::<Vec<_>>()}));
                plan = Some(p)
            }
            "learning_phase" => {
                let known = plan
                    .as_ref()
                    .or_else(|| session["learning"]["steps"].as_array())?;
                let num = known
                    .iter()
                    .position(|s| s["id"] == d["current_step"])
                    .map(|x| x + 1);
                steps.push(json!({"kind":"phase","phase":d["phase"],"step":num}));
            }
            "learning_assessment" => {
                let row = learning::assessment_row(d);
                if steps.last().is_some_and(|x| x["kind"] == "assessment") {
                    steps.last_mut().unwrap()["items"]
                        .as_array_mut()
                        .unwrap()
                        .push(row)
                } else {
                    steps.push(json!({"kind":"assessment","items":[row]}));
                }
            }
            "learning_finished" => steps
                .push(json!({"kind":"finished","summary":d["summary"],"next_step":d["next_step"]})),
            _ => (),
        }
    }
    if steps.is_empty() {
        None
    } else {
        Some(json!(steps))
    }
}
fn public_result(c: &Value, result: &Value) -> Value {
    let content = if result.is_object() {
        result.get("content").cloned().unwrap_or(json!(""))
    } else {
        result.clone()
    };
    let mut content = content
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| content.to_string());
    if c["name"] == "ask_questions" {
        if let Ok(payload) = serde_json::from_str::<Value>(&content) {
            if payload.is_object() && payload.get("status").is_some() {
                let mut keep = serde_json::Map::new();
                for k in ["batch_id", "status", "answers"] {
                    if let Some(v) = payload.get(k) {
                        keep.insert(k.into(), v.clone());
                    }
                }
                content = Value::Object(keep).to_string();
            }
        }
    }
    let mut row = json!({"content":content});
    if result["error"] == true {
        row["error"] = json!(true)
    }
    if let Some(imgs) = result["images"].as_array().filter(|x| !x.is_empty()) {
        row["images"] = json!(imgs.len())
    }
    row
}
fn public_message(s: &Value, m: &Value, at: Option<&Value>) -> Value {
    let role = text(m, "role");
    let mut row = json!({"id":text(m,"id"),"role":role});
    if let Some(at) = at {
        row["at"] = at.clone();
    }
    match role {
        "user" => {
            row["content"] = m
                .get("display")
                .or_else(|| m.get("content"))
                .cloned()
                .unwrap_or(json!(""));
            if m["attachments"].as_array().is_some_and(|x| !x.is_empty()) {
                row["attachments"] = m["attachments"].clone();
            }
            if let Some(v) = m["images"].as_array().filter(|x| !x.is_empty()) {
                row["images"] = json!(v.len());
            }
        }
        "assistant" => {
            for k in ["content", "thinking", "provider", "model"] {
                row[k] = json!(text(m, k));
            }
            row["stop"] = json!(m.get("stop").and_then(Value::as_str).unwrap_or("stop"));
            row["calls"] = json!(m["calls"]
                .as_array()
                .map(|x| x.iter().map(call).collect::<Vec<_>>())
                .unwrap_or_default());
            for k in ["usage", "thinking_ms"] {
                if let Some(v) = m.get(k).filter(|x| !x.is_null()) {
                    row[k] = v.clone();
                }
            }
        }
        _ => {
            let name = text(m, "name");
            row["call_id"] = json!(text(m, "call_id"));
            row["name"] = json!(name);
            let content = text(m, "content");
            let mut out = content.to_owned();
            if name == "ask_questions" {
                if let Ok(payload) = serde_json::from_str::<Value>(content) {
                    if payload.is_object() && payload.get("status").is_some() {
                        let mut filtered = serde_json::Map::new();
                        for k in ["batch_id", "status", "answers"] {
                            if let Some(v) = payload.get(k) {
                                filtered.insert(k.into(), v.clone());
                            }
                        }
                        out = Value::Object(filtered).to_string();
                    }
                }
            }
            row["content"] = json!(out);
            if m["error"] == true {
                row["error"] = json!(true);
            }
            if let Some(v) = m["images"].as_array().filter(|x| !x.is_empty()) {
                row["images"] = json!(v.len());
            }
            if let Some(v) = m.get("ms").filter(|v| !v.is_null()) {
                row["ms"] = v.clone();
            }
            if ["set_learning_plan", "record_assessment", "finish_lesson"].contains(&name) {
                if let Some(v) = ui(s, text(m, "call_id")) {
                    row["ui"] = v;
                }
            }
        }
    }
    row
}
pub fn dispatch(op: &str, d: Value) -> Result<Value, String> {
    match op {
        "wire.public_call" => Ok(call(&d["call"])),
        "wire.public_result" => Ok(public_result(&d["call"], &d["result"])),
        "wire.public_message" => Ok(public_message(&d["session"], &d["message"], d.get("at"))),
        "wire.public_question" => {
            crate::questions::dispatch("questions.public_block", json!({"block":d["block"]}))
        }
        "wire.resolved_questions" => {
            let mut rows = serde_json::Map::new();
            for (id, r) in d["session"]["resolved_questions"]
                .as_object()
                .ok_or("Missing resolved questions")?
            {
                if r["block"].is_null() {
                    continue;
                }
                let block = crate::questions::dispatch(
                    "questions.public_block",
                    json!({"block":r["block"]}),
                )?;
                rows.insert(id.clone(),json!({"block":block,"status":r["payload"]["status"],"answers":r["payload"]["answers"],"message_id":r["message_id"]}));
            }
            Ok(Value::Object(rows))
        }
        "wire.history" => {
            let s = &d["session"];
            let events = s["events"].as_array().ok_or("Missing events")?;
            let mut out = Vec::new();
            for e in events {
                if ["message", "question_resolved"].contains(&text(e, "type"))
                    && e["message"]["synthetic"] != true
                {
                    out.push(public_message(s, &e["message"], e.get("time")));
                }
            }
            Ok(json!(out))
        }
        _ => Err("Unknown wire operation".into()),
    }
}

#[cfg(test)]
mod synthetic_tests {
    use super::*;
    #[test]
    fn synthetic_messages_stay_out_of_public_history() {
        let s = json!({"events":[
            {"type":"message","message":{"role":"user","id":"a","content":"hi"}},
            {"type":"message","message":{"role":"user","id":"b","content":"Continue: x","synthetic":true}}
        ]});
        let out = dispatch("wire.history", json!({"session":s})).unwrap();
        assert_eq!(out.as_array().unwrap().len(), 1);
    }
}
