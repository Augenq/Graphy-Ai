//! Observation capture: replay a session's events (messages, style changes, assessments incl.
//! `learning_transaction`, `supersedes`) and pair each graded attempt with what the tutor did before it.
use crate::context::casefold;
use serde_json::{json, Value};
use std::collections::HashSet;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// One observation as the profile sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Obs {
    pub id: String,
    pub time: f64,
    pub form: String,
    pub style: String,
    pub outcome: String,
    pub assessment: String,
    pub supersedes: String,
    pub session: String,
    pub course: String,
    pub message: String,
    pub topic: String,
    pub hint_level: String,
    pub prev_outcome: String,
    /// quiz | learn when the assessment carries it
    pub mode: String,
    /// typo | false_rule | missing_base | misread | other when the tutor stated it
    pub error_type: String,
}

pub const FORMS: [&str; 6] = ["analogy", "worked_example", "formal", "visual", "socratic", "plain",
];

pub fn form_label(f: &str) -> &'static str {
    match f {
        "analogy" => "Объяснение через аналогию",
        "worked_example" => "Объяснение через пример",
        "formal" => "Формальное объяснение",
        "visual" => "Наглядная схема",
        "socratic" => "Наводящие вопросы",
        _ => "Обычное объяснение",
    }
}
pub fn style_label(st: &str) -> &'static str {
    match st {
        "socratic" => "Сократический стиль",
        "structured_reference" => "Структурный стиль",
        _ => "Другой стиль",
    }
}
pub fn outcome_phrase(o: &str) -> &'static str {
    match o {
        "independent" => "задача решена без подсказок",
        "with_hints" => "задача решена с подсказками",
        _ => "в решении осталась ошибка",
    }
}

/// Deterministic keyword rules, in priority order. `visual` comes from a widget call, not words.
pub fn classify(text: &str, visual: bool) -> &'static str {
    if visual {
        return "visual";
    }
    let t = casefold(text);
    let has = |words: &[&str]| words.iter().any(|w| t.contains(w));
    if has(&["представь", "аналоги", "как если бы", "похоже на", "это как ", "imagine", "analogy", "think of it as",
    ]) {
        "analogy"
    } else if has(&["пример", "разберём", "разберем", "решим", "шаг 1", "worked example", "for example", "for instance",
    ]) {
        "worked_example"
    } else if has(&["определение", "теорема", "лемма", "формально", "доказательств", "definition", "theorem", "formally",
    ]) {
        "formal"
    } else if t.trim_end().ends_with('?') && t.chars().count() < 400 {
        "socratic"
    } else {
        "plain"
    }
}

/// Result of replaying one session.
pub struct Replay {
    pub obs: Vec<Obs>,
}

fn assistant_text(m: &Value) -> (String, bool) {
    let visual = m["calls"].as_array().is_some_and(|c| c.iter().any(|x| s(x, "name") == "show_widget"));
    (s(m, "content").to_owned(), visual)
}

/// The tutor's move before the attempt: assistant messages since the learner's last message up to
/// and including the one that carries the task.
fn move_before(messages: &[&Value], source: &str) -> Option<(String, bool)> {
    let at = messages.iter().position(|m| s(m, "id") == source)?;
    let end = if messages[at]["role"] == "user" { at } else { at + 1 };
    let start = messages[..end].iter().rposition(|m| m["role"] == "user").map_or(0, |i| i + 1);
    let mut text = String::new();
    let mut visual = false;
    for m in messages[start..end].iter().copied().filter(|m| m["role"] == "assistant") {
        let (t, v) = assistant_text(m);
        text.push_str(&t);
        text.push('\n');
        visual |= v;
    }
    (!text.trim().is_empty() || visual).then_some((text, visual))
}

fn ops<'a>(e: &'a Value, out: &mut Vec<&'a Value>) {
    match s(e, "type") {
        "learning_assessment" | "learning_plan" => out.push(e),
        "learning_transaction" => e["operations"].as_array().into_iter().flatten().for_each(|o| ops(o, out)),
        _ => (),
    }
}

/// `events` in journal order; `session`/`course` are the refs stored with each observation.
pub fn replay(events: &[Value], session: &str, course: &str) -> Replay {
    let mut messages: Vec<&Value> = Vec::new();
    let mut style = "structured_reference".to_string();
    let mut found: Vec<Obs> = Vec::new();
    let mut prev_outcome = String::new();
    let mut seen_ids = HashSet::new();
    let mut steps: Vec<Value> = Vec::new();
    for e in events {
        match s(e, "type") {
            "message" => messages.push(&e["message"]),
            "explanation_style" => style = s(e, "explanation_style").to_owned(),
            "learning_assessment" | "learning_transaction" | "learning_plan" => {
                let mut list = Vec::new();
                ops(e, &mut list);
                for a in list {
                    let d = &a["data"];
                    if s(a, "type") == "learning_plan" {
                        steps = d["steps"].as_array().cloned().unwrap_or_default();
                        continue;
                    }
                    let id = s(d, "id");
                    if id.is_empty() || !seen_ids.insert(id.to_owned()) {
                        continue;
                    }
                    let outcome = s(d, "outcome");
                    let counted = ["independent", "with_hints", "gap"].contains(&outcome);
                    let source = if s(d, "task_source_message_id").is_empty() { s(d, "source_message_id") } else { s(d, "task_source_message_id") };
                    let prev = std::mem::replace(&mut prev_outcome, outcome.to_owned());
                    if !counted {
                        continue;
                    }
                    let Some((text, visual)) = move_before(&messages, source) else { continue;
                    };
                    found.push(Obs {
                        id: format!("obs-{id}"),
                        time: e["time"].as_f64().unwrap_or(0.0),
                        form: classify(&text, visual).to_owned(),
                        style: style.clone(),
                        outcome: outcome.to_owned(),
                        assessment: id.to_owned(),
                        supersedes: s(d, "supersedes").to_owned(),
                        session: session.to_owned(),
                        course: course.to_owned(),
                        message: s(d, "source_message_id").to_owned(),
                        topic: steps.iter().find(|x| s(x, "id") == s(d, "topic_id")).map_or_else(|| s(d, "topic_id").to_owned(), |x| s(x, "title").to_owned(),
                            ),
                        hint_level: match s(d, "assistance") {
                            "" => if d["used_hints"] == true { "hints" } else { "none" }.to_owned(),
                            x => x.to_owned(),
                        },
                        prev_outcome: prev,
                        mode: s(d, "mode").to_owned(),
                        error_type: s(d, "error_type").to_owned(),
                    });
                }
            }
            _ => (),
        }
    }
    // an attempt that was superseded later in the replay is not an observation
    let replaced: HashSet<String> = found.iter().map(|o| o.supersedes.clone()).filter(|x| !x.is_empty()).collect();
    found.retain(|o| !replaced.contains(&o.assessment));
    Replay { obs: found }
}

/// Plain-language text of one observation.
pub fn text_of(o: &Obs, topic: &str) -> String {
    let base = format!("{}: {}", form_label(&o.form), outcome_phrase(&o.outcome));
    if topic.is_empty() { base } else { format!("{base} (тема: {topic})") }
}

pub fn to_event(o: &Obs, topic: &str) -> Value {
    // the context the rule engine may later key on; only what the record actually carried
    let mut context = serde_json::Map::new();
    for (k, v) in [("mode", &o.mode), ("error_type", &o.error_type)] {
        if !v.is_empty() {
            context.insert(k.into(), json!(v));
        }
    }
    json!({"op":"add","context":context,"id":o.id,"time":o.time,"form":o.form,"style":o.style,"outcome":o.outcome,
        "hint_level":o.hint_level,"prev_outcome":o.prev_outcome,"topic":topic,"text":text_of(o,topic),
        "source":{"session":o.session,"course_id":o.course,"message":o.message,"assessment":o.assessment},
        "supersedes_obs": if o.supersedes.is_empty(){Value::Null}else{json!(format!("obs-{}",o.supersedes))}})
}
