//! Grading and learner-facing answer projections; host validates the JSON schemas.
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    match op {
        "questions.formal_results" => formal_results(&data["block"], &data["answers"]),
        "questions.public_block" => {
            let mut block = data["block"].clone();
            for q in block["questions"]
                .as_array_mut()
                .ok_or("Missing questions")?
            {
                if let Some(q) = q.as_object_mut() {
                    q.remove("grading");
                }
            }
            Ok(block)
        }
        "questions.learner_answers" => learner_answers(&data),
        "questions.validate_answers" => validate_answers(&data),
        _ => Err(format!("Unknown question operation: {op}")),
    }
}
fn array(value: &Value) -> Result<&Vec<Value>, String> {
    value.as_array().ok_or("Expected array".into())
}
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn strings(value: &Value) -> HashSet<&str> {
    value
        .as_array()
        .map(|v| v.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}
fn formal_results(block: &Value, answers: &Value) -> Result<Value, String> {
    let questions = array(&block["questions"])?;
    let answers = array(answers)?;
    if questions.len() != answers.len() {
        return Err("zip() arguments have different lengths".into());
    }
    Ok(Value::Array(
        questions
            .iter()
            .zip(answers)
            .map(|(q, a)| {
                let key = strings(&q["grading"]["correct_option_ids"]);
                let chosen = strings(&a["selected_option_ids"]);
                let correct = if !key.is_empty() && a["status"] == "answered" && !chosen.is_empty()
                {
                    Value::Bool(key == chosen)
                } else {
                    Value::Null
                };
                json!({"question_id":q["id"],"correct":correct})
            })
            .collect(),
    ))
}
fn learner_answers(data: &Value) -> Result<Value, String> {
    let questions = array(&data["block"]["questions"])?;
    let answers = array(&data["answers"])?;
    if questions.len() != answers.len() {
        return Err("zip() arguments have different lengths".into());
    }
    let results = array(&data["results"])?;
    Ok(Value::Array(questions.iter().zip(answers).enumerate().map(|(n,(q,a))| {
        let options = q["options"].as_array();
        let chosen = a["selected_option_ids"].as_array().map(|ids| ids.iter().map(|id| {
            options.and_then(|os| os.iter().find(|o| o["id"] == *id)).map(|o| text(&o["label"])).unwrap_or(text(id))
        }).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        let answer = match text(&a["status"]) {
            "skipped" => "(skipped)".to_string(),
            "dont_know" => "(the learner chose \"I don't know\": a declared gap, not a wrong answer)".to_string(),
            _ => if !text(&a["text"]).is_empty() { text(&a["text"]).to_string() }
                else if !chosen.is_empty() { chosen } else { "(empty)".to_string() },
        };
        let mut row = json!({"n":n+1,"question_id":q["id"],"question":text(&q["prompt"]).chars().take(200).collect::<String>(),"learner_answer":answer});
        if !text(&a["reasoning"]).is_empty() { row["learner_reasoning"] = a["reasoning"].clone(); }
        if let Some(verdict) = results.iter().rev().find(|r| r["question_id"] == q["id"]).and_then(|r| r["correct"].as_bool()) {
            row["answer_key_says"] = json!(if verdict {"correct"} else {"incorrect"});
        }
        row
    }).collect()))
}
fn validate_answers(data: &Value) -> Result<Value, String> {
    let questions = array(&data["block"]["questions"])?;
    let answers = array(&data["answers"])?;
    if questions.len() != answers.len() {
        return Err("Provide one answer per question".into());
    }
    let mut seen = HashSet::new();
    for a in answers {
        if !seen.insert(text(&a["question_id"])) {
            return Err("Duplicate answer".into());
        }
    }
    let mut output = Vec::new();
    for q in questions {
        let a = answers
            .iter()
            .find(|a| a["question_id"] == q["id"])
            .ok_or("Unknown or missing question ID")?;
        let selected = array(&a["selected_option_ids"])?;
        let chosen = strings(&a["selected_option_ids"]);
        let options = q["options"]
            .as_array()
            .map(|os| os.iter().map(|o| text(&o["id"])).collect::<HashSet<_>>())
            .unwrap_or_default();
        let answer_text = crate::py_trim(text(&a["text"]));
        if !chosen.is_subset(&options) {
            return Err("Unknown selected option".into());
        }
        if q["type"] == "free_text" && !selected.is_empty() {
            return Err("Text question cannot contain selected options".into());
        }
        if q["type"] == "single_choice" && selected.len() > 1 {
            return Err("Select only one option".into());
        }
        if q["type"] != "free_text" && !answer_text.is_empty() && q["allow_custom_answer"] == false
        {
            return Err("Custom answer is disabled".into());
        }
        if q["type"] != "free_text" && !selected.is_empty() && !answer_text.is_empty() {
            return Err("A custom answer replaces selection; use reasoning for comments".into());
        }
        if data["final"] == true && a["status"] == "draft" {
            return Err("Answer or explicitly skip every question".into());
        }
        if a["status"] == "answered" && selected.is_empty() && answer_text.is_empty() {
            return Err("An answer cannot be empty; explicitly skip instead".into());
        }
        if (a["status"] == "skipped" || a["status"] == "dont_know")
            && (!selected.is_empty() || !answer_text.is_empty())
        {
            return Err("A skipped or \"don't know\" question cannot also have an answer".into());
        }
        output.push(a.clone());
    }
    Ok(Value::Array(output))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_and_skipped_are_not_wrong() {
        let block = json!({"questions":[{"id":"q1","grading":{"correct_option_ids":["a"]}}]});
        for status in ["skipped", "dont_know", "draft"] {
            let answers = json!([{"status":status,"selected_option_ids":[]}]);
            assert!(formal_results(&block, &answers).unwrap()[0]["correct"].is_null());
        }
        assert_eq!(
            formal_results(
                &block,
                &json!([{"status":"answered","selected_option_ids":["a"]}])
            )
            .unwrap()[0]["correct"],
            true
        );
    }
    #[test]
    fn projection_removes_grading() {
        let output = dispatch(
            "questions.public_block",
            json!({"block":{"questions":[{"id":"q","grading":{"secret":42}}]}}),
        )
        .unwrap();
        assert!(output["questions"][0].get("grading").is_none());
    }
}
