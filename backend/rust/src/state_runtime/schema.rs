//! Validation of the historical learning records accepted by Session._validate_event.
use super::journal::text;
use serde_json::{json, Value};
fn object(properties: Value, required: Value) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn text_schema() -> Value {
    json!({"type":"string","minLength":1,"maxLength":8000,"pattern":"\\S"})
}
fn id_schema() -> Value {
    json!({"type":"string","minLength":1,"maxLength":100,"pattern":"^[\\w-]+$"})
}
pub fn validate(event: &Value) -> Result<(), String> {
    let data = &event["data"];
    let kind = text(event, "type");
    let id = id_schema();
    let text = text_schema();
    let schema = match kind {
        "learning_goal" => object(json!({"goal":text}), json!(["goal"])),
        "learning_evidence_ignored" => object(
            json!({"refs":{"type":"array","maxItems":8,"items":{"type":"string"}}}),
            json!(["refs"]),
        ),
        "learning_skill" => object(
            json!({"name":{"type":"string","minLength":1,"maxLength":64,"pattern":"\\S"},"path":{"type":"string","minLength":1,"maxLength":4096,"pattern":"\\S"},"instructions":{"type":"string","maxLength":49152}}),
            json!(["name", "path"]),
        ),
        "learning_plan" => object(
            json!({"goal":{"type":"string","minLength":1,"maxLength":300,"pattern":"\\S"},"steps":{"type":"array","minItems":1,"maxItems":30,"items":object(json!({"id":id,"title":{"type":"string","minLength":1,"maxLength":240,"pattern":"\\S"}}),json!(["id","title"]))}}),
            json!(["steps"]),
        ),
        "learning_phase" => object(
            json!({"phase":{"type":"string","enum":["diagnosis","planning","teaching","practice","review"]},"current_step":{"type":"string","maxLength":100}}),
            json!(["phase"]),
        ),
        "learning_assessment" => object(
            json!({"id":id,"batch_id":{"type":"string","maxLength":100},"question_id":{"type":"string","maxLength":100},"question":text,"answer":{"type":["string","object"],"maxLength":4000},"topic_id":{"type":"string","maxLength":100},"outcome":{"type":"string","enum":["independent","with_hints","gap","uncertain","skipped"]},"feedback":text_schema(),"used_hints":{"type":"boolean"},"error_type":{"type":"string","maxLength":100},"hint_level":{"type":"integer","minimum":0,"maximum":4},"hint_log":{"type":"array","maxItems":8,"items":{"type":"object","properties":{"level":{"type":"integer","minimum":1,"maximum":4},"note":{"type":"string","maxLength":200}},"required":["level"],"additionalProperties":false}},"mode":{"type":"string","enum":["learn","quiz"]},"supersedes":id_schema()}),
            json!(["id", "outcome", "feedback", "used_hints"]),
        ),
        "learning_finished" => object(
            json!({"summary":text,"next_step":{"type":"string","maxLength":8000}}),
            json!(["summary", "next_step"]),
        ),
        _ => return Ok(()),
    };
    let selected = if [
        "learning_plan",
        "learning_phase",
        "learning_assessment",
        "learning_finished",
    ]
    .contains(&kind)
    {
        let mut filtered = serde_json::Map::new();
        if let (Some(input), Some(properties)) =
            (data.as_object(), schema["properties"].as_object())
        {
            for (k, v) in input {
                if properties.contains_key(k) {
                    filtered.insert(k.clone(), v.clone());
                }
            }
        }
        Value::Object(filtered)
    } else {
        data.clone()
    };
    jsonschema::validate(&schema, &selected).map_err(|e| {
        format!(
            "{}: {}",
            if e.instance_path.as_str().is_empty() {
                "input"
            } else {
                e.instance_path.as_str()
            },
            e
        )
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assessment_accepts_additive_quiz_mode_only() {
        let mut e = json!({"type":"learning_assessment","data":{"id":"A1","outcome":"independent","feedback":"ok","used_hints":false,"mode":"quiz"}});
        assert!(validate(&e).is_ok());
        e["data"]["mode"] = json!("exam");
        assert!(validate(&e).is_err());
        e["data"].as_object_mut().unwrap().remove("mode");
        assert!(validate(&e).is_ok());
    }
}
