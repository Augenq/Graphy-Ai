//! Compatibility for typed lesson calls already present in resumed transcripts.
use super::journal::text;
use serde_json::{json, Value};
pub fn is_legacy(call: &Value) -> bool {
    let name = text(call, "name");
    let a = &call["arguments"];
    (name == "record_assessment" && a.get("items").is_none())
        || (name == "set_learning_plan"
            && a["steps"]
                .as_array()
                .and_then(|x| x.first())
                .is_some_and(Value::is_object))
}
pub fn prepare(s: &Value, call: &Value) -> Result<(Vec<Value>, Value), String> {
    let state = &s["learning"];
    let steps = state["steps"].as_array().ok_or("Invalid learning state")?;
    let args = &call["arguments"];
    if !args.is_object() {
        return Err("Invalid lesson arguments".into());
    }
    let name = text(call, "name");
    let mut data = args.clone();
    let mut ops = Vec::new();
    let kind;
    match name {
        "set_learning_plan" => {
            let input = data["steps"].as_array().ok_or("Missing plan steps")?;
            if input.is_empty() || input.len() > 30 {
                return Err("Invalid plan steps".into());
            }
            let mut used = std::collections::HashSet::new();
            let mut built = Vec::new();
            for (index, step) in input.iter().enumerate() {
                let mut row = if let Some(s) = step.as_str() {
                    json!({"title":s})
                } else {
                    step.clone()
                };
                if !row.is_object() {
                    return Err("Invalid plan step".into());
                }
                if text(&row, "id").is_empty() {
                    let title = text(&row, "title").trim().to_lowercase();
                    let same = steps
                        .iter()
                        .find(|s| text(s, "title").trim().to_lowercase() == title)
                        .map(|s| text(s, "id").to_owned());
                    let mut n = index + 1;
                    while used.contains(&format!("s{n}"))
                        || steps.iter().any(|x| text(x, "id") == format!("s{n}"))
                    {
                        n += 1
                    }
                    row["id"] = json!(same
                        .filter(|id| !used.contains(id))
                        .unwrap_or(format!("s{n}")));
                }
                if !used.insert(text(&row, "id").to_owned()) {
                    return Err("Plan step IDs must be unique".into());
                }
                built.push(row);
            }
            data["steps"] = json!(built);
            kind = "learning_plan";
            ops.push(json!({"type":kind,"data":data}));
            if ["diagnosis", "planning"].contains(&text(state, "phase")) {
                ops.push(json!({"type":"learning_phase","data":{"phase":"teaching","current_step":built[0]["id"]}}));
            }
            return Ok((
                ops,
                json!({"recorded":kind,"next":"Plan saved, step 1 started. Now write its lesson in this turn."}),
            ));
        }
        "record_assessment" => {
            let outcome = text(&data, "outcome").to_string();
            if !data["used_hints"].is_boolean() {
                data["used_hints"] = json!(outcome == "with_hints");
            }
            if text(&data, "id").is_empty() {
                let mut n = state["assessments"].as_array().unwrap().len() + 1;
                while state["assessments"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|x| text(x, "id") == format!("a{n}"))
                {
                    n += 1
                }
                data["id"] = json!(format!("a{n}"));
            }
            let assessments = state["assessments"].as_array().unwrap();
            if !text(&data, "supersedes").is_empty()
                && !assessments.iter().any(|x| x["id"] == data["supersedes"])
            {
                data.as_object_mut().unwrap().remove("supersedes");
            }
            let batch = text(&data, "batch_id").to_owned();
            if batch.is_empty() {
                let exchange = crate::context::dispatch(
                    "context.chat_exchange",
                    json!({"messages":s["messages"]}),
                )?;
                if exchange[3] != true {
                    return Err("The learner has not answered anything yet".into());
                }
                if ["independent", "with_hints"].contains(&outcome.as_str())
                    && crate::context::dispatch(
                        "context.is_acknowledgement",
                        json!({"text":exchange[1]}),
                    )? == true
                {
                    return Err("A bare agreement is not evidence of a skill".into());
                }
                let question = if !text(&data, "question").is_empty() {
                    text(&data, "question").to_owned()
                } else if !exchange[0].as_str().unwrap_or("").is_empty() {
                    exchange[0].as_str().unwrap().to_owned()
                } else {
                    exchange[4].as_str().unwrap_or("").to_owned()
                };
                data["question"] = json!(question);
                data["answer"] = json!({"status":if outcome=="skipped"{"skipped"}else{"answered"},"text":exchange[1],"selected_option_ids":[],"reasoning":""});
                data["batch_id"] = json!("");
                data["question_id"] = json!("");
                if !data["topic_id"].is_string() {
                    data["topic_id"] = json!("");
                }
                data["source_message_id"] = exchange[2].clone();
            } else {
                let row = &s["resolved_questions"][&batch];
                if row["payload"]["status"] != "submitted" {
                    return Err("Assessment requires a submitted question block".into());
                }
                let qid = text(&data, "question_id").to_owned();
                let question = row["block"]["questions"]
                    .as_array()
                    .and_then(|xs| xs.iter().find(|q| text(q, "id") == qid))
                    .ok_or("Unknown question_id")?;
                let answer = row["payload"]["answers"]
                    .as_array()
                    .and_then(|xs| xs.iter().find(|a| text(a, "question_id") == qid))
                    .ok_or("Missing answer")?;
                if (answer["status"] == "skipped") != (outcome == "skipped") {
                    return Err("Skipped answer must have skipped outcome".into());
                }
                let previous = assessments
                    .iter()
                    .rev()
                    .find(|a| text(a, "batch_id") == batch && text(a, "question_id") == qid);
                if text(&data, "supersedes").is_empty() {
                    if let Some(previous) = previous {
                        data["supersedes"] = previous["id"].clone();
                    }
                } else if let Some(previous) =
                    assessments.iter().find(|a| a["id"] == data["supersedes"])
                {
                    if text(previous, "batch_id") != batch || text(previous, "question_id") != qid {
                        return Err("Correction must reference the same answer".into());
                    }
                }
                data["topic_id"] = json!(text(question, "topic_id"));
                data["question"] = question["prompt"].clone();
                data["answer"] = answer.clone();
                data["source_message_id"] = row["message_id"].clone();
            }
            kind = "learning_assessment";
        }
        _ => return Err("Unknown legacy lesson call".into()),
    }
    ops.push(json!({"type":kind,"data":data}));
    Ok((ops, json!({"recorded":kind})))
}
