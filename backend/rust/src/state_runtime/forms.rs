use super::journal::text;
use serde_json::{json, Value};
use std::collections::HashSet;
use uuid::Uuid;
fn id(s: &str) -> bool {
    !s.is_empty()
        && s.chars().count() <= 100
        && s.chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}
fn nonempty(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= max
}
fn keys(v: &Value, allowed: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|x| x.keys().all(|k| allowed.contains(&k.as_str())))
}
pub fn validate_block(b: &Value, learning: &Value) -> Result<(), String> {
    if !keys(
        b,
        &[
            "title",
            "purpose",
            "questions",
            "batch_id",
            "step",
            "answers",
        ],
    ) || !nonempty(text(b, "title"), 200)
        || !["diagnosis", "check", "practice", "clarification", "exam"].contains(&text(b, "purpose"))
    {
        return Err("Invalid question block".into());
    }
    let qs = b["questions"].as_array().ok_or("Missing questions")?;
    if qs.is_empty() || qs.len() > 8 || b.to_string().len() > 100_000 {
        return Err("Invalid question count or size".into());
    }
    let mut seen = HashSet::new();
    for q in qs {
        let qid = text(q, "id");
        let typ = text(q, "type");
        if !keys(
            q,
            &[
                "id",
                "type",
                "prompt",
                "topic_id",
                "options",
                "allow_custom_answer",
                "grading",
            ],
        ) || !id(qid)
            || !seen.insert(qid)
            || !nonempty(text(q, "prompt"), 8000)
            || !["free_text", "single_choice", "multiple_choice"].contains(&typ)
        {
            return Err("Invalid question".into());
        }
        let topic = text(q, "topic_id");
        let steps = learning["steps"].as_array().ok_or("Invalid lesson state")?;
        if !topic.is_empty()
            && (!id(topic) || (!steps.is_empty() && !steps.iter().any(|s| text(s, "id") == topic)))
        {
            return Err("Unknown topic_id".into());
        }
        if q.get("allow_custom_answer")
            .is_some_and(|v| !v.is_boolean())
        {
            return Err("Invalid custom answer setting".into());
        }
        let options = q
            .get("options")
            .map(|x| x.as_array().ok_or("Invalid options"))
            .transpose()?
            .cloned()
            .unwrap_or_default();
        if (typ == "free_text" && !options.is_empty())
            || (typ != "free_text" && !(2..=8).contains(&options.len()))
        {
            return Err("Invalid options for question type".into());
        }
        let mut ids = HashSet::new();
        let mut labels = HashSet::new();
        for o in &options {
            if !keys(o, &["id", "label"])
                || !id(text(o, "id"))
                || !nonempty(text(o, "label"), 8000)
                || !ids.insert(text(o, "id"))
                || !labels.insert(text(o, "label").trim().to_lowercase())
            {
                return Err("Invalid or duplicate option".into());
            }
        }
        if let Some(g) = q.get("grading") {
            if !keys(g, &["correct_option_ids", "explanation", "rubric"]) {
                return Err("Invalid grading".into());
            }
            for field in ["explanation", "rubric"] {
                if let Some(v) = g.get(field) {
                    if !v.as_str().is_some_and(|s| nonempty(s, 8000)) {
                        return Err("Invalid grading text".into());
                    }
                }
            }
            if let Some(correct) = g.get("correct_option_ids") {
                let list = correct.as_array().ok_or("Invalid answer key")?;
                let mut unique = HashSet::new();
                if list.is_empty()
                    || typ == "free_text"
                    || (typ == "single_choice" && list.len() != 1)
                    || list.iter().any(|x| {
                        x.as_str()
                            .map_or(true, |s| !ids.contains(s) || !unique.insert(s))
                    })
                {
                    return Err("Invalid answer key".into());
                }
            }
        }
    }
    Ok(())
}
fn answers(block: &Value, a: &Value, final_answer: bool) -> Result<Value, String> {
    let input = a.as_array().ok_or("Provide one answer per question")?;
    let mut normalized = Vec::new();
    for v in input {
        let mut v = v.clone();
        if let Some(o) = v.as_object_mut() {
            o.remove("confidence");
        }
        if !keys(
            &v,
            &[
                "question_id",
                "status",
                "selected_option_ids",
                "text",
                "reasoning",
            ],
        ) || !id(text(&v, "question_id"))
            || !["answered", "skipped", "dont_know", "draft"].contains(&text(&v, "status"))
            || !v["text"]
                .as_str()
                .is_some_and(|s| s.chars().count() <= 16000)
            || !v["reasoning"]
                .as_str()
                .is_some_and(|s| s.chars().count() <= 16000)
        {
            return Err("Invalid answer".into());
        }
        let ids = v["selected_option_ids"]
            .as_array()
            .ok_or("Invalid selected options")?;
        let mut seen = HashSet::new();
        if ids.len() > 8
            || ids
                .iter()
                .any(|x| x.as_str().map_or(true, |s| !id(s) || !seen.insert(s)))
        {
            return Err("Invalid selected options".into());
        }
        normalized.push(v);
    }
    if serde_json::to_vec(&normalized)
        .map_err(|e| e.to_string())?
        .len()
        > 300_000
    {
        return Err("Answers are too large".into());
    }
    crate::questions::dispatch(
        "questions.validate_answers",
        json!({"block":block,"answers":normalized,"final":final_answer}),
    )
}
/// True when a quiz session has a deadline and `now` (epoch seconds) is past it.
pub fn is_late(s: &Value, now: f64) -> bool {
    s["mode"] == "quiz" && now > 0.0 && s["deadline"].as_f64().is_some_and(|dl| now > dl)
}
/// In a quiz every question must ship its answer key (choice: `correct`; free text: `rubric`/`reference_answer`), so grading and
/// sharing to a class do not depend on the model remembering the key later.
fn require_keys(block: &Value) -> Result<(), String> {
    for (n, q) in block["questions"].as_array().into_iter().flatten().enumerate() {
        let g = &q["grading"];
        let ok = if q["type"] == "free_text" {
            g["rubric"].as_str().is_some_and(|r| !r.trim().is_empty())
        } else {
            g["correct_option_ids"].as_array().is_some_and(|a| !a.is_empty())
        };
        if !ok {
            return Err(format!(
                "Question {} has no answer key: in a quiz give `correct` (1-based option numbers) for every choice question and `rubric` (reference answer and key criteria, short) for every free_text question, plus a brief `explanation`. Verify the key, then call ask_questions again.",
                n + 1
            ));
        }
    }
    Ok(())
}
pub fn event(op: &str, d: &Value, s: &Value) -> Result<Option<Value>, String> {
    match op {
        "session.question_open" => {
            let call = &d["call"];
            let batch = text(call, "id");
            if !id(batch) {
                return Err("Invalid question ID".into());
            }
            let owner = s["messages"]
                .as_array()
                .ok_or("Invalid messages")?
                .iter()
                .find(|m| {
                    m["calls"]
                        .as_array()
                        .is_some_and(|cs| cs.iter().any(|c| c["id"] == batch))
                })
                .ok_or("Question must match assistant call")?;
            if owner["role"] != "assistant"
                || owner["calls"].as_array().map_or(true, |cs| {
                    cs.len() != 1
                        || cs[0]["name"] != "ask_questions"
                        || cs[0]["arguments"] != call["arguments"]
                })
                || ["length", "error", "aborted", "empty"].contains(&text(owner, "stop"))
            {
                return Err("Question must match a complete standalone assistant call".into());
            }
            let mut block = crate::context::dispatch(
                "context.normalize_questions",
                json!({"arguments":call["arguments"],"schema":{"type":"object","required":["title","questions"],"properties":{"title":{"type":"string"},"questions":{"type":"array","items":{"type":"object","required":["prompt","type"],"properties":{"prompt":{"type":"string"},"type":{"type":"string","enum":["free_text","single_choice","multiple_choice"]},"options":{"type":"array","items":{"type":"string"}},"correct":{"type":"array","items":{"type":"integer"}},"rubric":{"type":"string"}}}}}}}),
            )?;
            if s["mode"] == "quiz" {
                require_keys(&block)?;
            }
            validate_block(&block, &s["learning"])?;
            let initial=block["questions"].as_array().unwrap().iter().map(|q|json!({"question_id":q["id"],"status":"draft","selected_option_ids":[],"text":"","reasoning":""})).collect::<Vec<_>>();
            block["batch_id"] = json!(batch);
            block["step"] = json!(0);
            block["answers"] = json!(initial);
            Ok(Some(json!({"type":"question_opened","block":block})))
        }
        "session.question_draft" | "session.question_resolve" => {
            let b = &s["pending_question"];
            let id = text(d, "batch_id");
            if b.is_null() || text(b, "batch_id") != id {
                return Err("This question block is no longer open".into());
            }
            let cancel = d["cancel"] == true;
            let a = answers(
                b,
                &d["answers"],
                op == "session.question_resolve" && !cancel,
            )?;
            if op == "session.question_draft" {
                let step = d["step"].as_u64().ok_or("Invalid step")?;
                if step > b["questions"].as_array().unwrap().len() as u64 {
                    return Err("Invalid step".into());
                }
                if a == b["answers"] && d["step"] == b["step"] {
                    return Ok(None);
                }
                return Ok(Some(
                    json!({"type":"question_draft","batch_id":id,"answers":a,"step":step}),
                ));
            }
            let scores = if cancel {
                json!([])
            } else {
                crate::questions::dispatch(
                    "questions.formal_results",
                    json!({"block":b,"answers":a}),
                )?
            };
            let mut payload = json!({"batch_id":id,"status":if cancel{"cancelled"}else{"submitted"},"answers":a,"formal_results":scores});
            let late = !cancel && d["late"] == true;
            if late {
                payload["late"] = json!(true);
            }
            if cancel {
                payload["note"]=json!("The learner deliberately cancelled this block; it was not a technical failure. Do NOT resend or rephrase these questions. Briefly acknowledge and ask in one sentence what they would like instead (simpler, another topic, a break).");
            } else {
                payload["note"]=json!("These are the LEARNER's own answers to your test (not system-generated). Assess every question against the key you committed in the call; read the reasoning too.");
                if late {
                    payload["note"] = json!(format!("{} LATE: these answers arrived after the deadline ({}). Grade them on content, but state the lateness in the report{}.", payload["note"].as_str().unwrap_or(""), s["quiz_kind"].as_str().unwrap_or("check"), if s["quiz_kind"] == "mock_exam" { "; in a mock exam the time is fixed, so say they would not count in a real exam" } else { "" }));
                }
                payload["learner_answers"] = crate::questions::dispatch(
                    "questions.learner_answers",
                    json!({"block":b,"answers":a,"results":scores}),
                )?;
            }
            let message = json!({"id":Uuid::new_v4().simple().to_string(),"role":"tool","call_id":id,"name":"ask_questions","content":payload.to_string()});
            Ok(Some(
                json!({"type":"question_resolved","batch_id":id,"payload":payload,"message":message}),
            ))
        }
        _ => Err("Unknown question operation".into()),
    }
}
