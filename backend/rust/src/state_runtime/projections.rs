use super::{journal::text, learning};
use serde_json::{json, Value};
fn question_message(s: &Value, m: &Value) -> Value {
    let r = &s["resolved_questions"][text(m, "call_id")];
    if r.is_null() {
        return m.clone();
    }
    let payload = &r["payload"];
    let value = if payload["status"] == "cancelled" {
        json!({"status":"cancelled","note":"The learner cancelled this test. Do not reopen it unless requested."})
    } else {
        let mut attempts = Vec::new();
        let questions = r["block"]["questions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let answers = payload["answers"].as_array().cloned().unwrap_or_default();
        for (q, a) in questions.iter().zip(&answers) {
            let selected = a["selected_option_ids"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let options = q["options"].as_array().cloned().unwrap_or_default();
            let labels = selected
                .iter()
                .filter_map(|id| {
                    options
                        .iter()
                        .find(|o| o["id"] == *id)
                        .map(|o| o["label"].clone())
                })
                .collect::<Vec<_>>();
            let verdict = payload["formal_results"]
                .as_array()
                .and_then(|x| x.iter().find(|x| x["question_id"] == q["id"]))
                .map(|x| x["correct"].clone())
                .unwrap_or(Value::Null);
            let mut attempt = json!({"evidence_ref":learning::reference(text(r,"message_id"),text(q,"id")),"question":q["prompt"],"status":a["status"],"answer":if text(a,"text").is_empty(){json!(labels)}else{a["text"].clone()},"reasoning":a["reasoning"],"key_verdict":verdict});
            if !selected.is_empty() {
                attempt["selected_option_numbers"] = json!(options
                    .iter()
                    .enumerate()
                    .filter(|(_, o)| selected.contains(&o["id"]))
                    .map(|(i, _)| i + 1)
                    .collect::<Vec<_>>());
            }
            attempts.push(attempt);
        }
        json!({"status":"submitted","attempts":attempts,"note":"Choice answers contain selected option TEXTS. selected_option_numbers are validated UI selections, not typed answers. Assess their meaning and reasoning; never mark a correct selection wrong for its transport format. Grade against the key you committed in your call; status dont_know is a declared gap, not an error."})
    };
    let mut row = m.clone();
    row["content"] = json!(value.to_string());
    row
}
pub fn dispatch(op: &str, d: Value) -> Result<Value, String> {
    let s = &d["session"];
    match op {
        "session.context" => {
            let mut out = Vec::new();
            if !text(s, "summary").is_empty() {
                out.push(json!({"role":"user","content":format!("Earlier conversation summary:\n{}",text(s,"summary"))}));
            }
            let boundary = s["boundary"].as_u64().unwrap_or(0) as usize;
            let messages = s["messages"].as_array().ok_or("Missing messages")?;
            for m in messages.iter().skip(boundary) {
                if m["stop"] == "empty" {
                    continue;
                }
                out.push(if m["name"] == "ask_questions" {
                    question_message(s, m)
                } else {
                    m.clone()
                });
            }
            Ok(json!(out))
        }
        "session.usage" => {
            let mut totals = json!({"input":0,"output":0,"cache_read":0,"cache_write":0,"cost":0.0,"unknown_cost":false});
            for e in s["events"].as_array().ok_or("Missing events")? {
                if e["type"] != "usage" {
                    continue;
                }
                let u = &e["usage"];
                for k in ["input", "output", "cache_read", "cache_write"] {
                    totals[k] = json!(totals[k].as_i64().unwrap_or(0) + u[k].as_i64().unwrap_or(0));
                }
                if let Some(cost) = u["cost"].as_f64() {
                    totals["cost"] = json!(totals["cost"].as_f64().unwrap_or(0.0) + cost)
                } else {
                    totals["unknown_cost"] = json!(true)
                }
            }
            Ok(totals)
        }
        "session.needs_continuation" => {
            if !s["pending_question"].is_null() {
                return Ok(json!(false));
            }
            let last = s["messages"].as_array().and_then(|xs| xs.last());
            Ok(json!(last.is_some_and(|x| ["tool", "user"]
                .contains(&text(x, "role"))
                || ["error", "aborted", "empty"]
                    .contains(&text(x, "stop")))))
        }
        _ => Err("Unknown session projection".into()),
    }
}
