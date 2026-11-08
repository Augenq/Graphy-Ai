use serde_json::{json, Value};
use std::path::Path;

use super::catalog;

const ORDER: &[&str] = &["off","minimal","low","medium","high","xhigh","max"];
const BALANCED_LONG_CONTEXT: usize = 100_000;

fn rank(level: &str) -> i32 {
    ORDER.iter().position(|v| *v == level).map(|i| i as i32).unwrap_or(0)
}

pub fn pick_thinking(levels: &[String], wanted: &str) -> String {
    if levels.is_empty() { return "off".into(); }
    if levels.iter().any(|l| l == wanted) { return wanted.into(); }
    let want = rank(wanted);
    let mut best = levels[0].clone();
    let mut best_d = i32::MAX;
    for l in levels {
        if wanted != "off" && l == "off" && levels.iter().any(|x| x != "off") { continue; }
        let d = (rank(l) - want).abs();
        // tie: prefer higher for "deep/medium intent", stable otherwise
        if d < best_d || (d == best_d && rank(l) > rank(&best)) { best_d = d; best = l.clone(); }
    }
    best
}

/// Providers spell versions differently (`claude-haiku-5.5` vs `claude-haiku-5-5`): compare them equal.
fn norm(s: &str) -> String { s.to_lowercase().replace('.', "-") }

fn matches_id(model: &Value, want: &str) -> bool {
    let full = format!("{}/{}", catalog::s(&model["provider"]), catalog::s(&model["id"])).to_lowercase();
    let id = catalog::s(&model["id"]).to_lowercase();
    let (full, id, w) = (norm(&full), norm(&id), norm(want));
    full == w || id == w || full.ends_with(&w) || id.ends_with(&w)
}

fn contains_id(model: &Value, want: &str) -> bool {
    let full = format!("{}/{}", catalog::s(&model["provider"]), catalog::s(&model["id"])).to_lowercase();
    let id = catalog::s(&model["id"]).to_lowercase();
    let (full, id, w) = (norm(&full), norm(&id), norm(want));
    full.contains(&w) || id.contains(&w)
}

fn choose<'a>(available: &'a [Value], prefer: &[&str]) -> Option<&'a Value> {
    let pool: Vec<&'a Value> = available.iter().filter(|m| m["tools"].as_bool().unwrap_or(true)).collect();
    let pool = if pool.is_empty() { available.iter().collect() } else { pool };
    for want in prefer {
        if let Some(m) = pool.iter().copied().find(|m| matches_id(m, want)) { return Some(m); }
        if let Some(m) = pool.iter().copied().find(|m| contains_id(m, want)) { return Some(m); }
    }
    None
}

fn levels_of(model: &Value) -> Vec<String> {
    model["thinking_levels"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(|s| s.to_string()).collect()).unwrap_or_else(|| vec!["off".into()])
}

pub fn preset_meta() -> Value {
    json!([
        {"id":"fast","label":"Быстрый","hint":"DeepSeek V4.1 Flash — быстрый ответ","icon":"deepseek"},
        {"id":"balanced","label":"Обычный","hint":"Haiku 5.5; при контексте >100k — GPT-6.1 Terra","icon":"anthropic"},
        {"id":"deep","label":"Глубокий","hint":"Sonnet 5.5; при недоступности — GPT-6.1 Sol","icon":"anthropic"}
    ])
}

fn prefs_for(q: &str, context_tokens: Option<usize>) -> (Vec<&'static str>, &'static str) {
    match q {
        "fast" => (vec!["deepseek/deepseek-v4.1-flash", "deepseek-v4.1-flash"], "medium"),
        "deep" => (vec!["anthropic/claude-sonnet-5-5", "claude-sonnet-5-5", "openai/gpt-6.1-sol", "gpt-6.1-sol"], "max"),
        _ => {
            if context_tokens.unwrap_or(0) > BALANCED_LONG_CONTEXT {
                (vec!["openai/gpt-6.1-terra", "gpt-6.1-terra"], "medium")
            } else {
                (vec!["anthropic/claude-haiku-5-5", "claude-haiku-5-5"], "medium")
            }
        }
    }
}

fn configured_default(root: &Path) -> Option<String> {
    let v = catalog::read(root, "settings.json").ok()?;
    v["default_model"].as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

pub fn resolve(root: &Path, quality: &str, _default_model: &str) -> Result<Value, String> {
    resolve_for_context(root, quality, None)
}

pub fn resolve_for_context(root: &Path, quality: &str, context_tokens: Option<usize>) -> Result<Value, String> {
    let mut available = catalog::available(root).unwrap_or_default();
    if available.is_empty() { available = catalog::catalog(root).unwrap_or_default(); }
    if available.is_empty() { return Err("No models available".into()); }
    let q = match quality { "fast"|"deep"|"balanced" => quality, _ => "balanced" };
    let (prefer, want_thinking) = prefs_for(q, context_tokens);
    let picked = match choose(&available, &prefer) {
        Some(m) => m.clone(),
        // the preferred model is not offered by this provider/catalogue: use the configured default instead of failing the whole chat
        None => match configured_default(root).and_then(|d| available.iter().find(|m| format!("{}/{}", catalog::s(&m["provider"]), catalog::s(&m["id"])).eq_ignore_ascii_case(&d)).cloned()) {
            Some(m) => m,
            None => return Err(format!("No allowed model found for quality '{q}' (expected: {})", prefer.join(", "))),
        },
    };
    let thinking = pick_thinking(&levels_of(&picked), want_thinking);
    Ok(json!({"model": format!("{}/{}", catalog::s(&picked["provider"]), catalog::s(&picked["id"])), "thinking": thinking, "quality": q}))
}

pub fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    let root = catalog::root(&data);
    match op {
        "quality.resolve" => resolve_for_context(
            &root,
            catalog::s(&data["quality"]),
            data["context_tokens"].as_u64().map(|n| n as usize),
        ),
        "quality.presets" => Ok(preset_meta()),
        _ => Err(format!("Unknown quality operation: {op}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn m(p: &str, id: &str) -> Value { json!({"provider": p, "id": id, "tools": true}) }
    #[test]
    fn dotted_and_dashed_versions_match() {
        let pool = vec![m("openrouter", "anthropic/claude-haiku-5.5:batch"), m("openrouter", "anthropic/claude-haiku-5.5")];
        let got = choose(&pool, &["anthropic/claude-haiku-5-5", "claude-haiku-5-5"]).unwrap();
        assert_eq!(got["id"], "anthropic/claude-haiku-5.5");
    }
    #[test]
    fn unrelated_models_do_not_match() {
        let pool = vec![m("openrouter", "anthropic/claude-haiku-4.5")];
        assert!(choose(&pool, &["anthropic/claude-haiku-5-5"]).is_none());
    }
}
