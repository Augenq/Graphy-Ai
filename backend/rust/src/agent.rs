//! Agent decisions over explicit JSON snapshots. Python owns I/O and cancellation;
//! this module owns turn policy, retry policy and the operation progress guards.
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

const MIN_FORM_QUESTIONS: usize = 3;
const QUIZ_WORD: &str = r"(?:вопрос|тест|провер|опрос|форм(?:а|ы|у|е|ой|ам|ами)?\b)";
static NO_QUESTIONS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
    r"(?i)(без\s+(?:\w+\s+){{0,2}}|не\s+(надо|нужн\w*|задавай\w*|спрашивай\w*|хочу)\s+(\w+\s+)?){}|\bno questions\b|\bstop asking\b", QUIZ_WORD)).unwrap()
});
static REQUEST_QUIZ: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)(?:дай|давай|сделай|хочу|открой|проведи|предложи|можно).{0,35}(?:тест|опрос|форм(?:а|ы|у|е|ой|ам|ами)?\b)|(?:quiz|test) me").unwrap()
});
static CLAIMED_FORM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)(?:вопросы|тест|форма).{0,30}(?:отправлен|отправлены|открыт)|жду ответов|questions.{0,20}sent").unwrap()
});
static ANNOUNCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)(?:\bсделаю\b|\bсоздам\b|\bподготовлю\b|\bнапишу\b|\bсоставлю\b|\bприступаю\b|\bприступлю\b|\bсейчас\b|\bначинаю\b|\bпосмотрю\b|\bнайду\b|\bi will\b|\bi'll\b|\bi am going to\b|\bi'm going to\b|\blet me\b|\blet's\b|\bnow i\b)").unwrap()
});
pub const NUDGE_TEXT: &str =
    "Continue: perform the announced action now with tools, don't announce.";
/// True when the final, tool-less message of a turn only announces future work
/// (short, no question, no substance). Pure heuristic; the loop applies it at most once per turn.
pub fn is_announcement(text: &str) -> bool {
    let t = text.trim();
    let n = t.chars().count();
    if n == 0 || n > 200 || t.contains('?') || t.contains('\u{ff1f}') {
        return false;
    }
    if t.contains("```") || t.contains('$') || t.contains("http") || t.lines().filter(|l| !l.trim().is_empty()).count() > 4 {
        return false;
    }
    ANNOUNCE.is_match(t)
}
pub const EMPTY_NUDGE_TEXT: &str = "Your last reply was empty. Write the final answer for the learner now: say what you managed to do, what failed and why (in plain words), and give the best partial result or the next step. Do not call tools unless essential.";
/// What to do with a finished model reply: "ok" (has text or tool calls), "nudge" (empty, nudge not yet used)
/// or "fallback" (still empty after the nudge). Whitespace-only text counts as empty.
pub fn empty_turn_action(content: &str, has_calls: bool, nudged: bool) -> &'static str {
    if has_calls || !content.trim().is_empty() {
        "ok"
    } else if nudged {
        "fallback"
    } else {
        "nudge"
    }
}
/// Fixed Russian message shown when a turn ends empty twice; quotes a short reason from the last failed tool result.
pub fn empty_fallback_text(messages: &Value) -> String {
    let reason = messages
        .as_array()
        .and_then(|m| m.iter().rev().find(|m| m["role"] == "tool" && truthy(&m["error"])))
        .map(|m| {
            let raw = string(&m["content"]).split_whitespace().collect::<Vec<_>>().join(" ");
            let short: String = raw.chars().take(160).collect();
            let name = string(&m["name"]);
            if name.is_empty() { short } else { format!("{name}: {short}") }
        })
        .filter(|r| !r.trim().is_empty());
    match reason {
        Some(r) => format!("Не удалось получить ответ: последняя ошибка инструмента — {r}. Попробуйте ещё раз или уточните запрос."),
        None => "Не удалось получить ответ: модель вернула пустой ответ. Попробуйте ещё раз или уточните запрос.".to_owned(),
    }
}
const QUESTION_FAILURE: &str =
    "Тест не открыт после нескольких попыток. История сохранена; можно продолжить объяснение.";
const TOOL_FAILURE: &str =
    "Повторяющаяся ошибка инструмента. Действие остановлено; история сохранена.";

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn flag(value: &Value) -> bool {
    value.as_bool().unwrap_or(false)
}
fn count(value: &Value) -> usize {
    value.as_array().map_or(0, Vec::len)
}
fn number(value: &Value, default: i64) -> i64 {
    value.as_i64().unwrap_or(default)
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
        Value::Number(v) => v.as_f64().unwrap_or(0.0) != 0.0,
    }
}

pub fn no_questions(text: &str) -> bool {
    NO_QUESTIONS.is_match(text)
}

fn learner_declined(messages: &Value) -> bool {
    for message in messages.as_array().into_iter().flatten().rev() {
        if message["role"] == "user" {
            let text = string(&message["content"]);
            if no_questions(text) {
                return true;
            }
            if REQUEST_QUIZ.is_match(text) {
                return false;
            }
        }
        if message["role"] == "tool" && message["name"] == "ask_questions" {
            if let Ok(Value::Object(payload)) =
                serde_json::from_str::<Value>(string(&message["content"]))
            {
                if let Some(status) = payload.get("status") {
                    return status == "cancelled";
                }
            }
        }
    }
    false
}

fn question_policy(data: &Value) -> String {
    if learner_declined(&data["messages"]) {
        return "The learner declined questions (cancelled the form or asked for none). Ask nothing now: teach, explain or move on as they asked".into();
    }
    let minimum = number(&data["min_questions"], MIN_FORM_QUESTIONS as i64).max(0) as usize;
    let questions = count(&data["call"]["arguments"]["questions"]);
    if questions < minimum {
        return format!("The form is only for tests of at least {minimum} questions, and this has {questions}. Ask your 1-2 questions as plain text in your message (numbered if two) and wait for the learner's reply in the chat");
    }
    if data["phase"] == "diagnosis" && truthy(&data["resolved_questions"]) {
        return "Diagnosis is already done. Ask nothing more: teach now with an explanation and an example (save a plan first only if this is a large route)".into();
    }
    String::new()
}

fn truncation_hint(data: &Value) -> String {
    let questions: Vec<&Value> = data["calls"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|c| c["arguments"]["questions"].as_array().into_iter().flatten())
        .filter(|q| q.is_object())
        .collect();
    let cut = questions
        .iter()
        .any(|q| string(&q["prompt"]).matches("```").count() & 1 != 0);
    let no_options = questions.iter().any(|q| {
        matches!(string(&q["type"]), "single_choice" | "multiple_choice") && !truthy(&q["options"])
    });
    let by_count = data["by_count"].as_bool().unwrap_or(true);
    let minimum = number(&data["min_questions"], MIN_FORM_QUESTIONS as i64).max(0) as usize;
    if !cut && !no_options && !(by_count && questions.len() < minimum) {
        return String::new();
    }
    format!(" LIKELY CAUSE: your arguments arrived CUT SHORT (questions or options are missing{}). A double quote inside a text value, e.g. in a code sample such as words = \"hi\", must be written as \\\" - an unescaped quote ends the string and drops everything after it. Use single quotes in code samples and send ALL questions again.", if cut { ", a code block in a prompt is not closed" } else { "" })
}

fn tool_preflight(data: &Value) -> Value {
    let call = &data["call"];
    // serde_json's ordered map serialization makes equivalent argument object
    // orders share a fingerprint; call IDs deliberately do not affect progress.
    fn canonicalize(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.sort_keys();
                for value in map.values_mut() {
                    canonicalize(value);
                }
            }
            Value::Array(items) => {
                for value in items {
                    canonicalize(value);
                }
            }
            _ => {}
        }
    }
    let mut fingerprint = json!([call["name"], call["arguments"], data["learning"]]);
    canonicalize(&mut fingerprint);
    let fingerprint = fingerprint.to_string();
    let mut repeats = data["call_repeats"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let occurrences = repeats
        .get(&fingerprint)
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    repeats.insert(fingerprint, json!(occurrences));
    let blocked = string(&data["blocked"]);
    let error = if !blocked.is_empty() && flag(&data["public"]) {
        Some(format!("Not executed: earlier operation failed: {blocked}. Repair it before dependent lesson changes."))
    } else if truthy(&call["argument_error"]) {
        Some(string(&call["argument_error"]).into())
    } else if occurrences > 2 {
        Some("Repeated identical operation without progress; stop this action and explain the issue.".into())
    } else if flag(&data["truncated"]) {
        Some("Not executed: response reached output limit; reissue complete arguments.".into())
    } else {
        None
    };
    json!({"call_repeats": repeats, "result": error.map(|content| json!({"content": content, "error": true}))})
}

fn batch_outcome(data: &Value) -> Value {
    let question = flag(&data["question"]);
    let failed = if question {
        flag(&data["error"])
    } else {
        data["results"].as_array().is_some_and(|results| {
            !results.is_empty() && results.iter().all(|r| truthy(&r["error"]))
        })
    };
    let failures = if failed {
        number(&data["failed_operations"], 0) + 1
    } else {
        0
    };
    let rejections = number(&data["policy_rejections"], 0) + i64::from(question && failed);
    let limit = if question {
        number(&data["policy_retries"], 2).max(2)
    } else {
        2
    };
    json!({"failed_operations": failures, "policy_rejections": rejections,
        "stop": if failures > limit { if question { QUESTION_FAILURE } else { TOOL_FAILURE } } else { "" }})
}

fn response_action(data: &Value) -> Value {
    let response = &data["response"];
    let stop = string(&response["stop"]);
    let empty = !matches!(stop, "error" | "aborted")
        && empty_turn_action(string(&response["content"]), truthy(&response["calls"]), flag(&data["nudged"])) != "ok";
    let (action, error) = if empty && !flag(&data["steering"]) {
        (if flag(&data["nudged"]) { "empty_fallback" } else { "empty_nudge" }, "")
    } else if stop == "error" {
        (
            "provider_error",
            "Provider stopped the response (refusal, safety filter or upstream error).",
        )
    } else if stop == "aborted" {
        ("aborted", "")
    } else if truthy(&response["calls"]) {
        ("tools", "")
    } else if truthy(&data["question_error"]) && CLAIMED_FORM.is_match(string(&response["content"]))
    {
        (
            "error",
            "Вопросы не открыты: форма была отклонена. Можно продолжить объяснение без теста.",
        )
    } else if flag(&data["steering"]) {
        ("continue", "")
    } else if !flag(&data["nudged"]) && !flag(&data["produced"]) && is_announcement(string(&response["content"])) {
        ("nudge", "")
    } else if flag(&data["followups"]) {
        ("followup", "")
    } else {
        ("stop", "")
    };
    json!({"action": action, "error": error})
}

pub fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    Ok(match op.strip_prefix("agent.").unwrap_or(op) {
        "matches" => {
            let pattern = match string(&data["pattern"]) {
                "NO_QUESTIONS" => &*NO_QUESTIONS,
                "REQUEST_QUIZ" => &*REQUEST_QUIZ,
                other => return Err(format!("Unknown agent pattern: {other}")),
            };
            json!(pattern.is_match(string(&data["text"])))
        }
        "learner_declined_questions" => json!(learner_declined(&data["messages"])),
        "question_policy" => json!(question_policy(&data)),
        "truncation_hint" => json!(truncation_hint(&data)),
        "tool_preflight" => tool_preflight(&data),
        "question_preflight" => {
            let calls = data["response"]["calls"].as_array();
            let error = if calls.map_or(0, Vec::len) != 1 || data["response"]["stop"] == "length" {
                "Call ask_questions alone with complete arguments"
            } else {
                string(&calls.unwrap()[0]["argument_error"])
            };
            json!(error)
        }
        "batch_outcome" => batch_outcome(&data),
        "response_action" => response_action(&data),
        "request_outcome" => {
            let response = &data["response"];
            let empty = response["stop"] == "stop"
                && !truthy(&response["calls"])
                && crate::py_trim(string(&response["content"])).is_empty();
            json!({"empty": empty, "retry": empty && number(&data["attempt"], 0) < number(&data["retries"], 3)})
        }
        "retry" => {
            let attempt = number(&data["attempt"], 0);
            let retry = !flag(&data["displayed"])
                && !flag(&data["streamed"])
                && flag(&data["retryable"])
                && attempt < number(&data["retries"], 3);
            let delay = data["retry_after"]
                .as_f64()
                .unwrap_or_else(|| 2f64.powf(attempt as f64))
                .clamp(0.0, 60.0);
            json!({"retry": retry, "delay": delay})
        }
        "context_policy" => {
            let model = &data["model"];
            let limit = number(
                model
                    .get("context")
                    .or_else(|| model.get("contextWindow"))
                    .unwrap_or(&Value::Null),
                128000,
            );
            let reserve = (limit / 4).clamp(1024, 16384);
            json!({"limit": limit, "keep": (limit / 4).min(8000),
                "compact": data["auto_compact"].as_bool().unwrap_or(true) && number(&data["tokens"], 0) > limit - reserve})
        }
        "overflow" => json!(
            !flag(&data["compacted"]) && (data["status"] == 413 || flag(&data["context_overflow"]))
        ),
        other => return Err(format!("Unknown agent operation: {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn op(name: &str, data: Value) -> Value {
        dispatch(name, data).unwrap()
    }

    #[test]
    fn empty_turns_nudge_once_then_fall_back() {
        assert_eq!(empty_turn_action("", false, false), "nudge");
        assert_eq!(empty_turn_action("  \n\t ", false, false), "nudge");
        assert_eq!(empty_turn_action("Готово", false, false), "ok");
        assert_eq!(empty_turn_action("", true, false), "ok");
        assert_eq!(empty_turn_action("", false, true), "fallback");
        let msgs = json!([{"role":"tool","name":"web_read","content":"Web request failed: timed out\n(try another source)","error":true},{"role":"assistant","content":""}]);
        let t = empty_fallback_text(&msgs);
        assert!(t.starts_with("Не удалось получить ответ") && t.contains("web_read: Web request failed: timed out (try another source)") && t.contains("Попробуйте ещё раз"), "{t}");
        assert!(empty_fallback_text(&json!([])).contains("пустой ответ"));
        let r = |nudged| response_action(&json!({"response":{"stop":"empty","content":"","calls":[]},"nudged":nudged}))["action"].clone();
        assert_eq!(r(false), "empty_nudge");
        assert_eq!(r(true), "empty_fallback");
    }
    #[test]
    fn announcements_are_detected_and_normal_replies_are_not() {
        assert!(is_announcement("Сделаю презентацию на 5 слайдов. Предположу, что класс 6."));
        assert!(is_announcement("Сейчас приступаю к работе."));
        assert!(is_announcement("I will build the deck now."));
        assert!(is_announcement("Let me check that."));
        assert!(!is_announcement("Готово."));
        assert!(!is_announcement("Площадь круга равна пи на r в квадрате."));
        assert!(!is_announcement("Сделаю презентацию. Какой класс?"));
        assert!(!is_announcement(""));
        assert!(!is_announcement(&format!("Сейчас {}", "я объясняю ".repeat(30))));
        assert!(!is_announcement("Ответ: $x=3$, сейчас проверим."));
        let action = |nudged: bool, produced: bool| {
            response_action(&json!({"response":{"stop":"stop","content":"Сделаю файл."},"nudged":nudged,"produced":produced}))["action"].clone()
        };
        assert_eq!(action(false, false), "nudge");
        assert_eq!(action(true, false), "stop");
        assert_eq!(action(false, true), "stop");
    }

    #[test]
    fn learner_intent_ignores_formulas_and_obeys_latest_test_request() {
        assert_eq!(
            op(
                "matches",
                json!({"pattern":"NO_QUESTIONS", "text":"Объясни без сложных формул"})
            ),
            false
        );
        assert_eq!(
            op(
                "learner_declined_questions",
                json!({"messages":[{"role":"user","content":"без вопросов"},{"role":"user","content":"объясни формулу"}]})
            ),
            true
        );
        assert_eq!(
            op(
                "learner_declined_questions",
                json!({"messages":[{"role":"user","content":"без вопросов"},{"role":"user","content":"давай тест по формулам"}]})
            ),
            false
        );
        assert_eq!(
            op(
                "learner_declined_questions",
                json!({"messages":[{"role":"tool","name":"ask_questions","content":"{\"status\":\"cancelled\"}"}]})
            ),
            true
        );
    }

    #[test]
    fn repetition_tracks_progress_and_prioritizes_dependency_failures() {
        let mut input = json!({"call":{"id":"a","name":"record_assessment","arguments":{"items":[]}}, "learning":[1,"practice","step",0,false]});
        for n in 0..3 {
            let result = op("tool_preflight", input.clone());
            assert_eq!(result["result"].is_null(), n < 2);
            input["call_repeats"] = result["call_repeats"].clone();
        }
        input["learning"][3] = json!(1);
        assert!(op("tool_preflight", input.clone())["result"].is_null());
        input["blocked"] = json!("set_learning_plan");
        input["public"] = json!(true);
        assert!(string(&op("tool_preflight", input)["result"]["content"])
            .contains("earlier operation failed"));
    }

    #[test]
    fn failures_stop_only_after_three_batches_and_success_resets() {
        assert_eq!(
            op(
                "batch_outcome",
                json!({"failed_operations":2,"results":[{"error":true}]})
            )["stop"],
            TOOL_FAILURE
        );
        assert_eq!(
            op(
                "batch_outcome",
                json!({"failed_operations":2,"results":[{"error":true},{}]})
            )["failed_operations"],
            0
        );
        assert_eq!(
            op(
                "batch_outcome",
                json!({"question":true,"error":true,"failed_operations":2,"policy_retries":0})
            )["stop"],
            QUESTION_FAILURE
        );
    }

    #[test]
    fn retries_are_bounded_and_never_replay_streamed_responses() {
        assert_eq!(
            op("retry", json!({"attempt":2,"retries":3,"retryable":true}))["delay"],
            4.0
        );
        assert_eq!(
            op("retry", json!({"retryable":true,"retry_after":3600}))["delay"],
            60.0
        );
        assert_eq!(
            op("retry", json!({"retryable":true,"displayed":true}))["retry"],
            false
        );
        assert_eq!(
            op("retry", json!({"retryable":true,"attempt":3,"retries":3}))["retry"],
            false
        );
    }

    #[test]
    fn response_actions_preserve_tool_and_queue_order() {
        assert_eq!(
            op(
                "response_action",
                json!({"response":{"calls":[{}]},"steering":true})
            )["action"],
            "tools"
        );
        assert_eq!(
            op(
                "response_action",
                json!({"response":{},"steering":true,"followups":true})
            )["action"],
            "continue"
        );
        assert_eq!(
            op(
                "response_action",
                json!({"response":{"content":"Жду ответов"},"question_error":"refused"})
            )["action"],
            "error"
        );
        assert_eq!(
            op("overflow", json!({"status":413,"compacted":true})),
            false
        );
    }
}
