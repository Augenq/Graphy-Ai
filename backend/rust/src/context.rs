//! Pure transcript decisions and tolerant tool argument normalization.
//! Python owns session I/O, prompt resources, and committing compacted history.
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        fence: Regex::new(r"(?s)```.*?(?:```|\z)").unwrap(),
        words: Regex::new(r"[\p{L}\p{N}_-]+").unwrap(),
        task: Regex::new(r"(?i)найд(?:ите|и)|вычисл(?:ите|и)|реши(?:те)?|посчита(?:йте|й)|упрост(?:ите|и)|докаж(?:ите|и)|определ(?:ите|и)|ответь(?:те)?|проверь(?:те)?|попробуй(?:те)?").unwrap(),
        plan: Regex::new(r"(?i)(?:сохрани|состав|постро|сдела|нужен|напиши|создай|подготов)[\p{L}\p{N}_]*.{0,35}(?:план|программ[\p{L}\p{N}_]+\s+обучения|маршрут)|(?:save|make|create|build|write|need).{0,25}(?:plan|roadmap|curriculum|study route)").unwrap(),
        no_plan: Regex::new(r"(?i)без\s+(?:нового\s+)?(?:плана|урока)|не\s+(?:надо|нужен)\s+план|no plan").unwrap(),
        decline: Regex::new(r"(?i)без\s+(?:[\p{L}\p{N}_]+\s+){0,2}(?:вопрос|провер)|не\s+(?:задавай|спрашивай|проверяй).{0,20}(?:вопрос|меня)|no questions").unwrap(),
        practice: Regex::new(r"(?i)проверь\s+меня|(?:дай|задай|предложи|хочу).{0,20}(?:задачу|вопрос|практику|тест)|хочу\s+потренироваться|quiz me|test me").unwrap(),
        help: Regex::new(r"(?i)подсказ|помоги|объясни|hint|help|explain").unwrap(),
        answer: Regex::new(r"(?i)\d|=|мой ответ|получил|получится").unwrap(),
    })
}

struct Patterns {
    fence: Regex,
    words: Regex,
    task: Regex,
    plan: Regex,
    no_plan: Regex,
    decline: Regex,
    practice: Regex,
    help: Regex,
    answer: Regex,
}

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn content(message: &Value) -> &str {
    string(&message["content"])
}
fn role(message: &Value) -> &str {
    string(&message["role"])
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn py_space(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '\u{1c}'..='\u{1f}')
}
fn trim(text: &str) -> &str {
    text.trim_matches(py_space)
}
fn py_lines(text: &str) -> Vec<&str> {
    text.split([
        '\n', '\r', '\u{b}', '\u{c}', '\u{1c}', '\u{1d}', '\u{1e}', '\u{85}', '\u{2028}',
        '\u{2029}',
    ])
    .map(trim)
    .filter(|line| !line.is_empty())
    .collect()
}
fn first(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}
fn last(text: &str, count: usize) -> String {
    text.chars()
        .skip(text.chars().count().saturating_sub(count))
        .collect()
}
fn word(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}
fn bounded(text: &str, start: usize, end: usize) -> bool {
    !text[..start].chars().next_back().is_some_and(word)
        && !text[end..].chars().next().is_some_and(word)
}

const ACK_WORDS: &[&str] = &[
    "ага",
    "угу",
    "да",
    "ок",
    "окей",
    "ok",
    "okay",
    "yes",
    "yep",
    "понял",
    "поняла",
    "понятно",
    "ясно",
    "хорошо",
    "ладно",
    "давай",
    "дальше",
    "продолжай",
    "продолжаем",
    "норм",
    "нормально",
    "конечно",
    "все",
    "всё",
    "верно",
    "так",
    "точно",
    "вроде",
    "наверное",
    "да-да",
    "ну",
    "и",
    "я",
];

fn acknowledgement(text: &str) -> bool {
    let folded = casefold(text);
    let words: Vec<_> = patterns().words.find_iter(&folded).collect();
    !words.is_empty() && words.len() <= 4 && words.iter().all(|m| ACK_WORDS.contains(&m.as_str()))
}

fn task_line(text: &str) -> bool {
    let heading = text.trim_start_matches(|ch| !word(ch));
    for prefix in ["задача", "вопрос"] {
        let lowered = heading.to_lowercase();
        if lowered.starts_with(prefix) && !lowered[prefix.len()..].chars().next().is_some_and(word)
        {
            return true;
        }
    }
    // Test boundaries against Python's Unicode word characters (letters/numbers/_),
    // rather than regex's broader Unicode set, which also includes combining marks.
    patterns()
        .task
        .find_iter(text)
        .any(|m| bounded(text, m.start(), m.end()))
}

fn asked_in(text: &str) -> String {
    let without_code = patterns().fence.replace_all(text, "\n");
    let all_lines = py_lines(&without_code);
    let lines = &all_lines[all_lines.len().saturating_sub(3)..];
    for (index, line) in lines.iter().enumerate().rev() {
        if line.contains('?') || task_line(line) {
            let task = if line.ends_with(':') && index + 1 < lines.len() {
                lines[index + 1]
            } else {
                line
            };
            return first(task, 300);
        }
    }
    String::new()
}

fn python_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        _ => value.to_string(),
    }
}

fn chat_exchange(messages: &[Value]) -> Value {
    for (index, learner) in messages.iter().enumerate().rev() {
        if role(learner) != "user" {
            continue;
        }
        let answer = first(
            &learner.get("content").map(python_str).unwrap_or_default(),
            4000,
        );
        let id = learner.get("id").cloned().unwrap_or(json!(""));
        for message in messages[..index].iter().rev() {
            if role(message) == "assistant" && !trim(content(message)).is_empty() {
                let all_lines = py_lines(content(message));
                let mut lines = &all_lines[all_lines.len().saturating_sub(6)..];
                while lines.join(" / ").chars().count() > 300 && lines.len() > 1 {
                    lines = &lines[1..];
                }
                return json!([
                    asked_in(content(message)),
                    answer,
                    id,
                    true,
                    last(&lines.join(" / "), 300)
                ]);
            }
            if role(message) == "user" {
                break;
            }
        }
        return json!(["", answer, id, false, ""]);
    }
    json!(["", "", "", false, ""])
}

fn pending_check(data: &Value) -> Value {
    let messages = array(&data["messages"]);
    let Some(latest) = messages.last() else {
        return json!("");
    };
    let text = content(latest);
    if data["learning"] != true
        || role(latest) != "user"
        || text.trim_start_matches(py_space).starts_with('/')
        || acknowledgement(text)
    {
        return json!("");
    }
    let exchange = chat_exchange(messages);
    if !string(&exchange[0]).is_empty() {
        return exchange[0].clone();
    }
    if exchange[3] == true && !text.contains('?') && text.chars().count() <= 300 {
        exchange[4].clone()
    } else {
        json!("")
    }
}

fn assessment_due(data: &Value) -> bool {
    let message = &data["message"];
    let refs = array(&data["refs"]);
    let evidence = array(&data["evidence"]);
    if role(message) == "tool" && message["name"] == "ask_questions" {
        return evidence
            .iter()
            .any(|source| refs.contains(&source["evidence_ref"]) && source["candidate"] != true);
    }
    if role(message) == "tool"
        && message["name"] == "record_assessment"
        && truthy(&message["error"])
    {
        return !refs.is_empty();
    }
    let text = content(message);
    if role(message) != "user" || text.trim_start_matches(py_space).starts_with('/') {
        return false;
    }
    if patterns().help.is_match(text) && !patterns().answer.is_match(text) {
        return false;
    }
    evidence
        .iter()
        .find(|source| {
            refs.contains(&source["evidence_ref"]) && source["source_message_id"] == message["id"]
        })
        .is_some_and(|source| !asked_in(string(&source["question"])).is_empty())
}

fn plan_due(data: &Value) -> bool {
    if data["enabled"] != true || data["has_steps"] == true {
        return false;
    }
    let messages = array(&data["messages"]);
    let users: Vec<_> = messages.iter().filter(|m| role(m) == "user").collect();
    if users.is_empty() || patterns().no_plan.is_match(content(users[users.len() - 1])) {
        return false;
    }
    let asked = messages
        .iter()
        .position(|m| role(m) == "user" && patterns().plan.is_match(content(m)));
    asked.is_some_and(|index| {
        messages[index + 1..]
            .iter()
            .any(|m| role(m) == "assistant" && !trim(content(m)).is_empty())
    })
}

fn checks_declined(messages: &[Value]) -> bool {
    for message in messages.iter().rev().filter(|m| role(m) == "user") {
        if patterns().decline.is_match(content(message)) {
            return true;
        }
        if patterns().practice.is_match(content(message)) {
            return false;
        }
    }
    false
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
    }
}

/// Character length of Python json.dumps(..., ensure_ascii=False), including its
/// default comma/colon spaces. Images and opaque provider replay are excluded upstream.
fn json_characters(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::String(s) => {
            2 + s
                .chars()
                .map(|ch| match ch {
                    '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
                    '\0'..='\u{1f}' => 6,
                    _ => 1,
                })
                .sum::<usize>()
        }
        Value::Array(values) => {
            2 + values.iter().map(json_characters).sum::<usize>()
                + 2 * values.len().saturating_sub(1)
        }
        Value::Object(values) => {
            2 + values
                .iter()
                .map(|(key, value)| json_characters(&json!(key)) + 2 + json_characters(value))
                .sum::<usize>()
                + 2 * values.len().saturating_sub(1)
        }
        Value::Number(number) => {
            let text = number.to_string();
            if text.contains(['e', 'E', '.']) {
                let value = number.as_f64().unwrap();
                let repr = format!("{value:?}");
                if let Some((mantissa, exponent)) = repr.split_once('e') {
                    let exponent: i32 = exponent.parse().unwrap();
                    mantissa.len() + 2 + format!("{:02}", exponent.unsigned_abs()).len()
                } else {
                    repr.len()
                }
            } else {
                text.len()
            }
        }
    }
}

fn message_estimate(message: &Value) -> usize {
    let filtered: Map<_, _> = message
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| key.as_str() != "images" && key.as_str() != "native")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    json_characters(&Value::Object(filtered)) / 4 + 1600 * array(&message["images"]).len()
}

fn split_history(messages: &[Value], keep: i64) -> usize {
    let mut pending = HashSet::new();
    let mut boundaries = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        if index > 0 && pending.is_empty() && matches!(role(message), "user" | "assistant") {
            boundaries.push(index);
        }
        for call in array(&message["calls"]) {
            pending.insert(call["id"].to_string());
        }
        if role(message) == "tool" {
            pending.remove(&message["call_id"].to_string());
        }
    }
    let mut tokens = 0;
    let mut target = 0;
    for (index, message) in messages.iter().enumerate().rev() {
        tokens += message_estimate(message) as i64;
        if tokens >= keep {
            target = index;
            break;
        }
    }
    boundaries
        .into_iter()
        .filter(|index| *index <= target)
        .max()
        .unwrap_or(0)
}

fn compact_prepare(data: &Value) -> Value {
    let messages = array(&data["messages"]);
    let mut split = split_history(messages, data["keep"].as_i64().unwrap_or(8000));
    if data["learning"] == true {
        if let Some(latest) = messages.iter().rposition(|m| {
            array(&m["calls"])
                .iter()
                .any(|call| call["name"] == "ask_questions")
        }) {
            split = split.min(latest);
        }
        let sources = array(&data["unassessed"]);
        for (index, message) in messages.iter().enumerate() {
            if truthy(&message["id"])
                && sources.iter().any(|source| {
                    source["source_message_id"] == message["id"]
                        && (source["candidate"] != true
                            || !asked_in(string(&source["question"])).is_empty())
                })
            {
                let mut candidate = index.saturating_sub(1);
                while candidate > 0 && role(&messages[candidate]) == "tool" {
                    candidate -= 1;
                }
                split = split.min(candidate);
            }
        }
    }
    let transcript: Vec<_> = messages[..split]
        .iter()
        .map(|message| {
            let mut row = Map::new();
            for key in ["role", "content", "calls", "name"] {
                if let Some(value) = message.get(key) {
                    row.insert(key.into(), value.clone());
                }
            }
            if role(message) == "tool" {
                row.insert("content".into(), json!(first(content(message), 2000)));
            }
            Value::Object(row)
        })
        .collect();
    json!({"split": split, "transcript": transcript})
}

fn heal_member(value: &str, members: &[Value]) -> Value {
    let mut decoded = value.to_owned();
    for _ in 0..3 {
        let Ok(Value::String(text)) = serde_json::from_str(&decoded) else {
            break;
        };
        if members.contains(&json!(text)) {
            return json!(text);
        }
        decoded = text;
    }
    let stripped = value.trim_matches([' ', '\t', '\r', '\n', ':', '.', '"', '\'', '`', '\\']);
    if members.contains(&json!(stripped)) {
        return json!(stripped);
    }
    let folded = casefold(stripped);
    let matches: Vec<_> = members
        .iter()
        .filter(|m| m.as_str().is_some_and(|text| casefold(text) == folded))
        .collect();
    if matches.len() == 1 {
        matches[0].clone()
    } else {
        json!(value)
    }
}

fn normalize_optional(schema: &Value, mut value: Value) -> Value {
    let kind = string(&schema["type"]);
    if let Some(text) = value.as_str() {
        let members = array(&schema["enum"]);
        if !members.is_empty() && !members.contains(&value) {
            value = heal_member(text, members);
        }
    }
    if matches!(kind, "array" | "object") {
        if let Some(text) = value.as_str() {
            if let Ok(decoded) = serde_json::from_str::<Value>(text) {
                if (kind == "array" && decoded.is_array())
                    || (kind == "object" && decoded.is_object())
                {
                    value = decoded;
                }
            }
        }
    }
    if let Some(text) = value.as_str() {
        if matches!(kind, "integer" | "number") {
            // Python float() permits Unicode decimal digits and underscores.
            let text = decimal_digits(text.trim());
            if valid_numeric_underscores(&text) {
                if let Ok(number) = text.replace('_', "").parse::<f64>() {
                    if number.is_finite() && (kind == "number" || number.fract() == 0.0) {
                        return if kind == "integer" {
                            if number == 0.0 {
                                json!(0)
                            } else {
                                serde_json::from_str(&format!("{number:.0}")).unwrap_or(value)
                            }
                        } else {
                            json!(number)
                        };
                    }
                }
            }
        }
        if kind == "boolean" {
            match casefold(trim(text)).as_str() {
                "true" => return json!(true),
                "false" => return json!(false),
                _ => {}
            }
        }
    }
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_optional(&schema["items"], item))
                .collect(),
        ),
        Value::Object(items) => {
            let properties = &schema["properties"];
            let required = array(&schema["required"]);
            Value::Object(
                items
                    .into_iter()
                    .filter_map(|(key, item)| {
                        if properties.get(&key).is_some()
                            && !required.contains(&json!(key))
                            && item.is_null()
                        {
                            return None;
                        }
                        let normalized = normalize_optional(&properties[&key], item);
                        Some((key, normalized))
                    })
                    .collect(),
            )
        }
        _ => value,
    }
}

fn valid_numeric_underscores(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.iter().enumerate().all(|(index, ch)| {
        *ch != b'_'
            || (index > 0
                && index + 1 < bytes.len()
                && bytes[index - 1].is_ascii_digit()
                && bytes[index + 1].is_ascii_digit())
    })
}

fn decimal_digits(text: &str) -> String {
    text.chars()
        .map(|ch| {
            let code = ch as u32;
            // Nd blocks, including mathematical styled digits, follow decimal order.
            for start in DECIMAL_STARTS {
                if code >= *start && code < *start + 10 {
                    return char::from_u32(48 + code - *start).unwrap();
                }
            }
            ch
        })
        .collect()
}

pub fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    Ok(match op {
        "context.candidate_attempt" => json!(candidate_attempt(&data["source"])),
        "context.is_acknowledgement" => json!(acknowledgement(string(&data["text"]))),
        "context.asked_in" => json!(asked_in(string(&data["text"]))),
        "context.chat_exchange" => chat_exchange(array(&data["messages"])),
        "context.pending_check" => pending_check(&data),
        "context.assessment_due" => json!(assessment_due(&data)),
        "context.plan_due" => json!(plan_due(&data)),
        "context.checks_declined" => json!(checks_declined(array(&data["messages"]))),
        "context.estimate" => json!(array(&data["messages"])
            .iter()
            .map(message_estimate)
            .sum::<usize>()),
        "context.split_history" => json!(split_history(
            array(&data["messages"]),
            data["keep"].as_i64().unwrap_or(8000)
        )),
        "context.compact_prepare" => compact_prepare(&data),
        "context.heal_member" => heal_member(string(&data["value"]), array(&data["members"])),
        "context.normalize_questions" => {
            normalize_questions(&data["schema"], data["arguments"].clone())?
        }
        "context.normalize_optional" => normalize_optional(&data["schema"], data["value"].clone()),
        _ => return Err(format!("Unknown context operation: {op}")),
    })
}

// Unicode full casefold expansions that differ from lowercase (Python Unicode data).
pub(crate) fn casefold(text: &str) -> String {
    let mut result = String::new();
    for ch in text.chars() {
        match ch {
            '\u{b5}' => result.push('μ'),
            '\u{df}' => result.push_str("ss"),
            '\u{149}' => result.push_str("ʼn"),
            '\u{17f}' => result.push('s'),
            '\u{1f0}' => result.push_str("ǰ"),
            '\u{345}' => result.push('ι'),
            '\u{390}' => result.push_str("ΐ"),
            '\u{3b0}' => result.push_str("ΰ"),
            '\u{3c2}' => result.push('σ'),
            '\u{3d0}' => result.push('β'),
            '\u{3d1}' => result.push('θ'),
            '\u{3d5}' => result.push('φ'),
            '\u{3d6}' => result.push('π'),
            '\u{3f0}' => result.push('κ'),
            '\u{3f1}' => result.push('ρ'),
            '\u{3f5}' => result.push('ε'),
            '\u{587}' => result.push_str("եւ"),
            '\u{13a0}' => result.push('Ꭰ'),
            '\u{13a1}' => result.push('Ꭱ'),
            '\u{13a2}' => result.push('Ꭲ'),
            '\u{13a3}' => result.push('Ꭳ'),
            '\u{13a4}' => result.push('Ꭴ'),
            '\u{13a5}' => result.push('Ꭵ'),
            '\u{13a6}' => result.push('Ꭶ'),
            '\u{13a7}' => result.push('Ꭷ'),
            '\u{13a8}' => result.push('Ꭸ'),
            '\u{13a9}' => result.push('Ꭹ'),
            '\u{13aa}' => result.push('Ꭺ'),
            '\u{13ab}' => result.push('Ꭻ'),
            '\u{13ac}' => result.push('Ꭼ'),
            '\u{13ad}' => result.push('Ꭽ'),
            '\u{13ae}' => result.push('Ꭾ'),
            '\u{13af}' => result.push('Ꭿ'),
            '\u{13b0}' => result.push('Ꮀ'),
            '\u{13b1}' => result.push('Ꮁ'),
            '\u{13b2}' => result.push('Ꮂ'),
            '\u{13b3}' => result.push('Ꮃ'),
            '\u{13b4}' => result.push('Ꮄ'),
            '\u{13b5}' => result.push('Ꮅ'),
            '\u{13b6}' => result.push('Ꮆ'),
            '\u{13b7}' => result.push('Ꮇ'),
            '\u{13b8}' => result.push('Ꮈ'),
            '\u{13b9}' => result.push('Ꮉ'),
            '\u{13ba}' => result.push('Ꮊ'),
            '\u{13bb}' => result.push('Ꮋ'),
            '\u{13bc}' => result.push('Ꮌ'),
            '\u{13bd}' => result.push('Ꮍ'),
            '\u{13be}' => result.push('Ꮎ'),
            '\u{13bf}' => result.push('Ꮏ'),
            '\u{13c0}' => result.push('Ꮐ'),
            '\u{13c1}' => result.push('Ꮑ'),
            '\u{13c2}' => result.push('Ꮒ'),
            '\u{13c3}' => result.push('Ꮓ'),
            '\u{13c4}' => result.push('Ꮔ'),
            '\u{13c5}' => result.push('Ꮕ'),
            '\u{13c6}' => result.push('Ꮖ'),
            '\u{13c7}' => result.push('Ꮗ'),
            '\u{13c8}' => result.push('Ꮘ'),
            '\u{13c9}' => result.push('Ꮙ'),
            '\u{13ca}' => result.push('Ꮚ'),
            '\u{13cb}' => result.push('Ꮛ'),
            '\u{13cc}' => result.push('Ꮜ'),
            '\u{13cd}' => result.push('Ꮝ'),
            '\u{13ce}' => result.push('Ꮞ'),
            '\u{13cf}' => result.push('Ꮟ'),
            '\u{13d0}' => result.push('Ꮠ'),
            '\u{13d1}' => result.push('Ꮡ'),
            '\u{13d2}' => result.push('Ꮢ'),
            '\u{13d3}' => result.push('Ꮣ'),
            '\u{13d4}' => result.push('Ꮤ'),
            '\u{13d5}' => result.push('Ꮥ'),
            '\u{13d6}' => result.push('Ꮦ'),
            '\u{13d7}' => result.push('Ꮧ'),
            '\u{13d8}' => result.push('Ꮨ'),
            '\u{13d9}' => result.push('Ꮩ'),
            '\u{13da}' => result.push('Ꮪ'),
            '\u{13db}' => result.push('Ꮫ'),
            '\u{13dc}' => result.push('Ꮬ'),
            '\u{13dd}' => result.push('Ꮭ'),
            '\u{13de}' => result.push('Ꮮ'),
            '\u{13df}' => result.push('Ꮯ'),
            '\u{13e0}' => result.push('Ꮰ'),
            '\u{13e1}' => result.push('Ꮱ'),
            '\u{13e2}' => result.push('Ꮲ'),
            '\u{13e3}' => result.push('Ꮳ'),
            '\u{13e4}' => result.push('Ꮴ'),
            '\u{13e5}' => result.push('Ꮵ'),
            '\u{13e6}' => result.push('Ꮶ'),
            '\u{13e7}' => result.push('Ꮷ'),
            '\u{13e8}' => result.push('Ꮸ'),
            '\u{13e9}' => result.push('Ꮹ'),
            '\u{13ea}' => result.push('Ꮺ'),
            '\u{13eb}' => result.push('Ꮻ'),
            '\u{13ec}' => result.push('Ꮼ'),
            '\u{13ed}' => result.push('Ꮽ'),
            '\u{13ee}' => result.push('Ꮾ'),
            '\u{13ef}' => result.push('Ꮿ'),
            '\u{13f0}' => result.push('Ᏸ'),
            '\u{13f1}' => result.push('Ᏹ'),
            '\u{13f2}' => result.push('Ᏺ'),
            '\u{13f3}' => result.push('Ᏻ'),
            '\u{13f4}' => result.push('Ᏼ'),
            '\u{13f5}' => result.push('Ᏽ'),
            '\u{13f8}' => result.push('Ᏸ'),
            '\u{13f9}' => result.push('Ᏹ'),
            '\u{13fa}' => result.push('Ᏺ'),
            '\u{13fb}' => result.push('Ᏻ'),
            '\u{13fc}' => result.push('Ᏼ'),
            '\u{13fd}' => result.push('Ᏽ'),
            '\u{1c80}' => result.push('в'),
            '\u{1c81}' => result.push('д'),
            '\u{1c82}' => result.push('о'),
            '\u{1c83}' => result.push('с'),
            '\u{1c84}' => result.push('т'),
            '\u{1c85}' => result.push('т'),
            '\u{1c86}' => result.push('ъ'),
            '\u{1c87}' => result.push('ѣ'),
            '\u{1c88}' => result.push('ꙋ'),
            '\u{1e96}' => result.push_str("ẖ"),
            '\u{1e97}' => result.push_str("ẗ"),
            '\u{1e98}' => result.push_str("ẘ"),
            '\u{1e99}' => result.push_str("ẙ"),
            '\u{1e9a}' => result.push_str("aʾ"),
            '\u{1e9b}' => result.push('ṡ'),
            '\u{1e9e}' => result.push_str("ss"),
            '\u{1f50}' => result.push_str("ὐ"),
            '\u{1f52}' => result.push_str("ὒ"),
            '\u{1f54}' => result.push_str("ὔ"),
            '\u{1f56}' => result.push_str("ὖ"),
            '\u{1f80}' => result.push_str("ἀι"),
            '\u{1f81}' => result.push_str("ἁι"),
            '\u{1f82}' => result.push_str("ἂι"),
            '\u{1f83}' => result.push_str("ἃι"),
            '\u{1f84}' => result.push_str("ἄι"),
            '\u{1f85}' => result.push_str("ἅι"),
            '\u{1f86}' => result.push_str("ἆι"),
            '\u{1f87}' => result.push_str("ἇι"),
            '\u{1f88}' => result.push_str("ἀι"),
            '\u{1f89}' => result.push_str("ἁι"),
            '\u{1f8a}' => result.push_str("ἂι"),
            '\u{1f8b}' => result.push_str("ἃι"),
            '\u{1f8c}' => result.push_str("ἄι"),
            '\u{1f8d}' => result.push_str("ἅι"),
            '\u{1f8e}' => result.push_str("ἆι"),
            '\u{1f8f}' => result.push_str("ἇι"),
            '\u{1f90}' => result.push_str("ἠι"),
            '\u{1f91}' => result.push_str("ἡι"),
            '\u{1f92}' => result.push_str("ἢι"),
            '\u{1f93}' => result.push_str("ἣι"),
            '\u{1f94}' => result.push_str("ἤι"),
            '\u{1f95}' => result.push_str("ἥι"),
            '\u{1f96}' => result.push_str("ἦι"),
            '\u{1f97}' => result.push_str("ἧι"),
            '\u{1f98}' => result.push_str("ἠι"),
            '\u{1f99}' => result.push_str("ἡι"),
            '\u{1f9a}' => result.push_str("ἢι"),
            '\u{1f9b}' => result.push_str("ἣι"),
            '\u{1f9c}' => result.push_str("ἤι"),
            '\u{1f9d}' => result.push_str("ἥι"),
            '\u{1f9e}' => result.push_str("ἦι"),
            '\u{1f9f}' => result.push_str("ἧι"),
            '\u{1fa0}' => result.push_str("ὠι"),
            '\u{1fa1}' => result.push_str("ὡι"),
            '\u{1fa2}' => result.push_str("ὢι"),
            '\u{1fa3}' => result.push_str("ὣι"),
            '\u{1fa4}' => result.push_str("ὤι"),
            '\u{1fa5}' => result.push_str("ὥι"),
            '\u{1fa6}' => result.push_str("ὦι"),
            '\u{1fa7}' => result.push_str("ὧι"),
            '\u{1fa8}' => result.push_str("ὠι"),
            '\u{1fa9}' => result.push_str("ὡι"),
            '\u{1faa}' => result.push_str("ὢι"),
            '\u{1fab}' => result.push_str("ὣι"),
            '\u{1fac}' => result.push_str("ὤι"),
            '\u{1fad}' => result.push_str("ὥι"),
            '\u{1fae}' => result.push_str("ὦι"),
            '\u{1faf}' => result.push_str("ὧι"),
            '\u{1fb2}' => result.push_str("ὰι"),
            '\u{1fb3}' => result.push_str("αι"),
            '\u{1fb4}' => result.push_str("άι"),
            '\u{1fb6}' => result.push_str("ᾶ"),
            '\u{1fb7}' => result.push_str("ᾶι"),
            '\u{1fbc}' => result.push_str("αι"),
            '\u{1fbe}' => result.push('ι'),
            '\u{1fc2}' => result.push_str("ὴι"),
            '\u{1fc3}' => result.push_str("ηι"),
            '\u{1fc4}' => result.push_str("ήι"),
            '\u{1fc6}' => result.push_str("ῆ"),
            '\u{1fc7}' => result.push_str("ῆι"),
            '\u{1fcc}' => result.push_str("ηι"),
            '\u{1fd2}' => result.push_str("ῒ"),
            '\u{1fd3}' => result.push_str("ΐ"),
            '\u{1fd6}' => result.push_str("ῖ"),
            '\u{1fd7}' => result.push_str("ῗ"),
            '\u{1fe2}' => result.push_str("ῢ"),
            '\u{1fe3}' => result.push_str("ΰ"),
            '\u{1fe4}' => result.push_str("ῤ"),
            '\u{1fe6}' => result.push_str("ῦ"),
            '\u{1fe7}' => result.push_str("ῧ"),
            '\u{1ff2}' => result.push_str("ὼι"),
            '\u{1ff3}' => result.push_str("ωι"),
            '\u{1ff4}' => result.push_str("ώι"),
            '\u{1ff6}' => result.push_str("ῶ"),
            '\u{1ff7}' => result.push_str("ῶι"),
            '\u{1ffc}' => result.push_str("ωι"),
            '\u{ab70}' => result.push('Ꭰ'),
            '\u{ab71}' => result.push('Ꭱ'),
            '\u{ab72}' => result.push('Ꭲ'),
            '\u{ab73}' => result.push('Ꭳ'),
            '\u{ab74}' => result.push('Ꭴ'),
            '\u{ab75}' => result.push('Ꭵ'),
            '\u{ab76}' => result.push('Ꭶ'),
            '\u{ab77}' => result.push('Ꭷ'),
            '\u{ab78}' => result.push('Ꭸ'),
            '\u{ab79}' => result.push('Ꭹ'),
            '\u{ab7a}' => result.push('Ꭺ'),
            '\u{ab7b}' => result.push('Ꭻ'),
            '\u{ab7c}' => result.push('Ꭼ'),
            '\u{ab7d}' => result.push('Ꭽ'),
            '\u{ab7e}' => result.push('Ꭾ'),
            '\u{ab7f}' => result.push('Ꭿ'),
            '\u{ab80}' => result.push('Ꮀ'),
            '\u{ab81}' => result.push('Ꮁ'),
            '\u{ab82}' => result.push('Ꮂ'),
            '\u{ab83}' => result.push('Ꮃ'),
            '\u{ab84}' => result.push('Ꮄ'),
            '\u{ab85}' => result.push('Ꮅ'),
            '\u{ab86}' => result.push('Ꮆ'),
            '\u{ab87}' => result.push('Ꮇ'),
            '\u{ab88}' => result.push('Ꮈ'),
            '\u{ab89}' => result.push('Ꮉ'),
            '\u{ab8a}' => result.push('Ꮊ'),
            '\u{ab8b}' => result.push('Ꮋ'),
            '\u{ab8c}' => result.push('Ꮌ'),
            '\u{ab8d}' => result.push('Ꮍ'),
            '\u{ab8e}' => result.push('Ꮎ'),
            '\u{ab8f}' => result.push('Ꮏ'),
            '\u{ab90}' => result.push('Ꮐ'),
            '\u{ab91}' => result.push('Ꮑ'),
            '\u{ab92}' => result.push('Ꮒ'),
            '\u{ab93}' => result.push('Ꮓ'),
            '\u{ab94}' => result.push('Ꮔ'),
            '\u{ab95}' => result.push('Ꮕ'),
            '\u{ab96}' => result.push('Ꮖ'),
            '\u{ab97}' => result.push('Ꮗ'),
            '\u{ab98}' => result.push('Ꮘ'),
            '\u{ab99}' => result.push('Ꮙ'),
            '\u{ab9a}' => result.push('Ꮚ'),
            '\u{ab9b}' => result.push('Ꮛ'),
            '\u{ab9c}' => result.push('Ꮜ'),
            '\u{ab9d}' => result.push('Ꮝ'),
            '\u{ab9e}' => result.push('Ꮞ'),
            '\u{ab9f}' => result.push('Ꮟ'),
            '\u{aba0}' => result.push('Ꮠ'),
            '\u{aba1}' => result.push('Ꮡ'),
            '\u{aba2}' => result.push('Ꮢ'),
            '\u{aba3}' => result.push('Ꮣ'),
            '\u{aba4}' => result.push('Ꮤ'),
            '\u{aba5}' => result.push('Ꮥ'),
            '\u{aba6}' => result.push('Ꮦ'),
            '\u{aba7}' => result.push('Ꮧ'),
            '\u{aba8}' => result.push('Ꮨ'),
            '\u{aba9}' => result.push('Ꮩ'),
            '\u{abaa}' => result.push('Ꮪ'),
            '\u{abab}' => result.push('Ꮫ'),
            '\u{abac}' => result.push('Ꮬ'),
            '\u{abad}' => result.push('Ꮭ'),
            '\u{abae}' => result.push('Ꮮ'),
            '\u{abaf}' => result.push('Ꮯ'),
            '\u{abb0}' => result.push('Ꮰ'),
            '\u{abb1}' => result.push('Ꮱ'),
            '\u{abb2}' => result.push('Ꮲ'),
            '\u{abb3}' => result.push('Ꮳ'),
            '\u{abb4}' => result.push('Ꮴ'),
            '\u{abb5}' => result.push('Ꮵ'),
            '\u{abb6}' => result.push('Ꮶ'),
            '\u{abb7}' => result.push('Ꮷ'),
            '\u{abb8}' => result.push('Ꮸ'),
            '\u{abb9}' => result.push('Ꮹ'),
            '\u{abba}' => result.push('Ꮺ'),
            '\u{abbb}' => result.push('Ꮻ'),
            '\u{abbc}' => result.push('Ꮼ'),
            '\u{abbd}' => result.push('Ꮽ'),
            '\u{abbe}' => result.push('Ꮾ'),
            '\u{abbf}' => result.push('Ꮿ'),
            '\u{fb00}' => result.push_str("ff"),
            '\u{fb01}' => result.push_str("fi"),
            '\u{fb02}' => result.push_str("fl"),
            '\u{fb03}' => result.push_str("ffi"),
            '\u{fb04}' => result.push_str("ffl"),
            '\u{fb05}' => result.push_str("st"),
            '\u{fb06}' => result.push_str("st"),
            '\u{fb13}' => result.push_str("մն"),
            '\u{fb14}' => result.push_str("մե"),
            '\u{fb15}' => result.push_str("մի"),
            '\u{fb16}' => result.push_str("վն"),
            '\u{fb17}' => result.push_str("մխ"),
            _ => result.extend(ch.to_lowercase()),
        }
    }
    result
}

const DECIMAL_STARTS: &[u32] = &[
    0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66,
    0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90,
    0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10,
    0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0,
    0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50,
    0x11da0, 0x11f50, 0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8,
    0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
];

struct EvidencePatterns {
    url: Regex,
    cue: Regex,
    non_attempt: Regex,
    command: Regex,
    knows: Regex,
    level: Regex,
}
fn evidence_patterns() -> &'static EvidencePatterns {
    static PATTERNS: OnceLock<EvidencePatterns> = OnceLock::new();
    PATTERNS.get_or_init(|| EvidencePatterns {
        url: Regex::new(r"https?://\S+").unwrap(),
        cue: Regex::new(r"(?i)\d\s*[+*/=^−-]|(?:мой\s+)?ответ\s*[:—-]|получ(?:ил|илось|ится)|исправляю|я думаю|считаю").unwrap(),
        non_attempt: Regex::new(r"(?i)не\s+решал[аи]?\s+задач|не\s+новая\s+попытка|не\s+ответ\s+на").unwrap(),
        command: Regex::new(r"(?i)^(?:найди|прочитай|загрузи|объясни|расскажи|сохрани|заверши|дай|перейди|что помнишь|на сегодня|сегодня всё|find\b|read\b|explain\b|finish\b)").unwrap(),
        knows: Regex::new(r"(?i)^(?:я\s+)?(?:знаю|умею|учусь)").unwrap(),
        level: Regex::new(r"(?i)знаешь|умеешь|изучал|уровень").unwrap(),
    })
}
const UNDERSTOOD: &[&str] = &[
    "понял",
    "поняла",
    "поняли",
    "понятно",
    "ясно",
    "ок",
    "окей",
    "ok",
    "okay",
    "understood",
    "got",
    "it",
    "всё",
    "все",
    "хорошо",
    "ладно",
    "отлично",
    "супер",
    "спасибо",
    "дальше",
    "продолжай",
    "продолжаем",
    "давай",
    "ага",
    "угу",
    "тогда",
    "и",
    "да-да",
    "thanks",
    "clear",
];

fn candidate_attempt(source: &Value) -> bool {
    if !truthy(&source["candidate"]) {
        return true;
    }
    let text = trim(string(&source["answer"]["text"]));
    let clean = evidence_patterns().url.replace_all(text, "");
    let cue = evidence_patterns().cue.is_match(&clean);
    if !cue {
        if crate::agent::no_questions(&clean)
            || evidence_patterns().non_attempt.is_match(&clean)
            || evidence_patterns().command.is_match(&clean)
        {
            return false;
        }
        if evidence_patterns().knows.is_match(&clean)
            && evidence_patterns()
                .level
                .is_match(string(&source["question"]))
        {
            return false;
        }
        let folded = casefold(&clean);
        let words: Vec<_> = patterns().words.find_iter(&folded).collect();
        if !words.is_empty()
            && words.len() <= 5
            && words.iter().all(|m| UNDERSTOOD.contains(&m.as_str()))
        {
            return false;
        }
    }
    cue || !asked_in(string(&source["question"])).is_empty()
}

fn option_id(index: usize) -> String {
    if index < 8 {
        ((b'a' + index as u8) as char).to_string()
    } else {
        format!("o{}", index + 1)
    }
}

/// Normalize the public question-writing form into stable internal question/option IDs.
fn normalize_questions(schema: &Value, arguments: Value) -> Result<Value, String> {
    if !arguments.is_object() || !arguments["questions"].is_array() {
        return Ok(arguments);
    }
    let mut block = normalize_optional(schema, arguments);
    let object = block
        .as_object_mut()
        .ok_or("Question block must be an object")?;
    object.entry("title").or_insert(json!("Тест"));
    object.entry("purpose").or_insert(json!("check"));
    let questions = object
        .get_mut("questions")
        .and_then(Value::as_array_mut)
        .ok_or("questions must be an array")?;
    for (index, question) in questions.iter_mut().enumerate() {
        let Some(q) = question.as_object_mut() else {
            continue;
        };
        q.entry("id").or_insert(json!(format!("q{}", index + 1)));
        let mut rubric = q.remove("rubric").unwrap_or(Value::Null);
        let reference = q.remove("reference_answer").unwrap_or(Value::Null);
        if truthy(&reference) {
            rubric = if truthy(&rubric) {
                json!(format!("Reference answer: {}\nCriteria: {}", python_str(&reference), python_str(&rubric)))
            } else {
                json!(format!("Reference answer: {}", python_str(&reference)))
            };
        }
        if truthy(&rubric) {
            let grading = q
                .entry("grading")
                .or_insert(json!({}))
                .as_object_mut()
                .ok_or("grading must be an object")?;
            grading.insert("rubric".into(), rubric);
        }
        let explanation = q.remove("explanation").unwrap_or(Value::Null);
        if truthy(&explanation) {
            let grading = q
                .entry("grading")
                .or_insert(json!({}))
                .as_object_mut()
                .ok_or("grading must be an object")?;
            grading.insert("explanation".into(), explanation);
        }
        if let Some(ids) = q.remove("correct_option_ids") {
            q.entry("correct").or_insert(ids);
        }
        if let Some(Value::Array(options)) = q.get_mut("options") {
            for (option_index, option) in options.iter_mut().enumerate() {
                if !option.is_object() {
                    *option = json!({"id": option_id(option_index), "label": python_str(option)});
                }
                option
                    .as_object_mut()
                    .unwrap()
                    .entry("id")
                    .or_insert(json!(option_id(option_index)));
            }
        }
        let correct = q.remove("correct").unwrap_or(Value::Null);
        let no_correct = correct.is_null()
            || correct.as_array().is_some_and(Vec::is_empty)
            || correct.as_str() == Some("");
        if !no_correct {
            let wanted = match correct {
                Value::Array(items) => items,
                scalar => vec![scalar],
            };
            let options = q.get("options").cloned().unwrap_or(json!([]));
            let options = options.as_array().ok_or("options must be an array")?;
            let mut ids = Vec::new();
            for value in wanted {
                let id = if value.is_number() && !value.to_string().contains(['.', 'e', 'E']) {
                    let position = value
                        .as_u64()
                        .filter(|position| *position > 0 && *position <= options.len() as u64)
                        .ok_or(
                            "correct must contain 1-based option numbers within the options range",
                        )?;
                    options[position as usize - 1]["id"].clone()
                } else {
                    let text = casefold(trim(&python_str(&value)));
                    let matched = options.iter().find(|option| {
                        text == casefold(&python_str(&option["id"]))
                            || text == casefold(trim(&python_str(&option["label"])))
                    });
                    if let Some(matched) = matched {
                        matched["id"].clone()
                    } else {
                        let decimal = decimal_digits(&text);
                        let position = if !decimal.is_empty()
                            && decimal.chars().all(|ch| ch.is_ascii_digit())
                        {
                            decimal.parse::<usize>().ok()
                        } else {
                            None
                        };
                        if let Some(position) =
                            position.filter(|position| *position > 0 && *position <= options.len())
                        {
                            options[position - 1]["id"].clone()
                        } else {
                            json!(python_str(&value))
                        }
                    }
                };
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
            let grading = q
                .entry("grading")
                .or_insert(json!({}))
                .as_object_mut()
                .ok_or("grading must be an object")?;
            grading.insert("correct_option_ids".into(), json!(ids));
        }
        if !q.contains_key("type") {
            let n_correct = q
                .get("grading")
                .map(|grading| array(&grading["correct_option_ids"]).len())
                .unwrap_or(0);
            let kind = if q.get("options").is_some_and(truthy) {
                if n_correct > 1 {
                    "multiple_choice"
                } else {
                    "single_choice"
                }
            } else {
                "free_text"
            };
            q.insert("type".into(), json!(kind));
        }
    }
    Ok(block)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn questions_normalize_option_positions_without_mutating_saved_ids() {
        let block = json!({"questions": [{"prompt": "Choose", "options": ["2", "3", "4"], "correct": [1, 3, 3]}, {"prompt": "Explain", "rubric": "Reasoning"}]});
        let normalized = normalize_questions(&json!({}), block.clone()).unwrap();
        assert_eq!(
            normalized["questions"][0]["grading"]["correct_option_ids"],
            json!(["a", "c"])
        );
        assert_eq!(normalized["questions"][0]["type"], "multiple_choice");
        assert_eq!(normalized["questions"][1]["grading"]["rubric"], "Reasoning");
        let keyed = normalize_questions(&json!({}), json!({"questions": [
            {"prompt": "P", "options": ["x", "y"], "correct_option_ids": ["b"], "explanation": "y is right"},
            {"prompt": "Q", "reference_answer": "42", "rubric": "units"}]})).unwrap();
        assert_eq!(keyed["questions"][0]["grading"]["correct_option_ids"], json!(["b"]));
        assert_eq!(keyed["questions"][0]["grading"]["explanation"], "y is right");
        assert_eq!(keyed["questions"][1]["grading"]["rubric"], "Reference answer: 42\nCriteria: units");
        assert_eq!(
            normalize_questions(&json!({}), normalized.clone()).unwrap(),
            normalized
        );
        assert!(normalize_questions(
            &json!({}),
            json!({"questions": [{"options": ["a", "b"], "correct": [3]}]})
        )
        .unwrap_err()
        .contains("1-based option numbers"));
        assert_eq!(block["questions"][0]["correct"], json!([1, 3, 3]));
    }

    #[test]
    fn task_detection_skips_code_and_preserves_long_inflections() {
        for verb in [
            "Найдите",
            "Вычислите",
            "Упростите",
            "Докажите",
            "Определите",
        ] {
            let task = format!("{verb} значение выражения.");
            assert_eq!(
                asked_in(&format!("Теория.\n{task}\n```python\nprint('?')\n```")),
                task
            );
        }
        assert_eq!(
            asked_in("Что вернёт f(3)?\n```python\ndef f(x):\n return x + 1"),
            "Что вернёт f(3)?"
        );
        assert_eq!(asked_in("Пример\n```\nwhat?\n```"), "");
        assert_eq!(asked_in("Проверь себя:\n2 + 2"), "2 + 2");
        assert_eq!(asked_in("неопределите значение"), "");
    }

    #[test]
    fn full_casefold_and_unicode_decimal_numbers_match_python() {
        assert_eq!(heal_member("STRASSE", &[json!("straße")]), "straße");
        assert_eq!(heal_member("Σ", &[json!("ς")]), "ς");
        assert_eq!(heal_member("s.", &[json!("S"), json!("ſ")]), "s.");
        assert_eq!(
            normalize_optional(&json!({"type": "integer"}), json!("١_٢٠")),
            120
        );
        assert_eq!(
            normalize_optional(&json!({"type": "integer"}), json!("-0.0")),
            0
        );
        for invalid in ["2.5", "1e400", "1__2", "\u{1c}2\u{1f}"] {
            assert_eq!(
                normalize_optional(&json!({"type": "integer"}), json!(invalid)),
                invalid
            );
        }
        let large = normalize_optional(&json!({"type": "integer"}), json!("1e100"));
        assert!(!large.to_string().contains('e'));
        assert_eq!(large.to_string().len(), 101);
    }

    #[test]
    fn optional_normalization_is_recursive_but_keeps_required_nulls_and_unknown_keys() {
        let schema = json!({"type": "object", "required": ["required"], "properties": {
            "required": {"type": "string"}, "optional": {"type": "boolean"},
            "rows": {"type": "array", "items": {"type": "integer"}}
        }});
        assert_eq!(
            normalize_optional(
                &schema,
                json!({"required": null, "optional": null, "unknown": null, "rows": "[\"2\", \"2.5\"]"})
            ),
            json!({"required": null, "unknown": null, "rows": [2, "2.5"]})
        );
        assert_eq!(
            normalize_optional(&json!({"type": "array"}), json!("[unterminated")),
            "[unterminated"
        );
    }

    #[test]
    fn token_estimation_counts_characters_and_excludes_replay_and_image_data() {
        let message = json!({"role": "user", "content": "Привет 🧮", "native": "opaque", "images": [{"data": "base64"}]});
        assert_eq!(
            message_estimate(&message),
            1600 + r#"{"role": "user", "content": "Привет 🧮"}"#.chars().count() / 4
        );
        assert_eq!(
            json_characters(&json!([1e-7, true, "\u{1}"])),
            "[1e-07, true, \"\\u0001\"]".len()
        );
    }

    #[test]
    fn split_keeps_a_multi_call_transaction_atomic() {
        let messages = json!([
            {"role": "user", "content": "old"},
            {"role": "assistant", "calls": [{"id": "a"}, {"id": "b"}]},
            {"role": "tool", "call_id": "b", "content": "done b"},
            {"role": "assistant", "content": "waiting"},
            {"role": "tool", "call_id": "a", "content": "done a"},
            {"role": "user", "content": "new"}
        ]);
        let messages = array(&messages);
        let keep = messages[3..].iter().map(message_estimate).sum::<usize>() as i64;
        assert_eq!(split_history(messages, keep), 1);
        assert_eq!(split_history(messages, 1), 5);
        assert_eq!(split_history(messages, 100000), 0);
    }

    #[test]
    fn chat_reply_requires_an_assistant_since_the_previous_user() {
        let messages = json!([
            {"role": "assistant", "content": "Сколько будет 2+2?"},
            {"role": "user", "content": "4", "id": "one"},
            {"role": "user", "content": "и ещё", "id": "two"}
        ]);
        assert_eq!(
            chat_exchange(array(&messages)),
            json!(["", "и ещё", "two", false, ""])
        );
        assert!(acknowledgement("Да, всё ясно"));
        assert!(!acknowledgement("Да, мой ответ: 4"));
    }

    #[test]
    fn candidate_attempt_excludes_opinions_and_commands_but_preserves_yes_no_answers() {
        for (text, expected) in [
            ("понял, спасибо", false),
            ("без вопросов", false),
            ("мой ответ: 4", true),
            ("да", true),
        ] {
            assert_eq!(
                candidate_attempt(
                    &json!({"candidate": true, "answer": {"text": text}, "question": "Найди значение 2+2"})
                ),
                expected
            );
        }
        assert!(candidate_attempt(&json!({"candidate": false})));
    }

    #[test]
    fn compaction_preserves_unassessed_task_and_latest_question_batch() {
        let messages = json!([
            {"role": "user", "content": "old"},
            {"role": "assistant", "content": "old"},
            {"role": "assistant", "content": "Найди значение 2+2"},
            {"role": "user", "id": "answer", "content": "4"},
            {"role": "assistant", "content": "next"}
        ]);
        let prepared = compact_prepare(
            &json!({"messages": messages, "keep": 1, "learning": true, "unassessed": [{"source_message_id": "answer", "candidate": true, "question": "Найди значение 2+2"}]}),
        );
        assert_eq!(prepared["split"], 2);
        assert_eq!(array(&prepared["transcript"]).len(), 2);
    }
}
