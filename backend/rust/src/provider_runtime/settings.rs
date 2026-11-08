use super::{
    auth,
    catalog::{self, merge, s},
};
use serde_json::{json, Value};
use std::path::Path;
const TOOLS: &[&str] = &["read", "bash", "web_search", "web_read", "load_skill"];
fn get(root: &Path) -> Result<Value, String> {
    let prefs = catalog::read(root, "settings.json")?;
    let cred = catalog::credential(root, "web-search")?;
    let mut out = json!({"anti_slop_enabled":prefs.get("anti_slop_enabled").cloned().unwrap_or(json!(true)),"skills_enabled":prefs.get("skills_enabled").cloned().unwrap_or(json!(true)),"auto_compact":prefs.get("auto_compact").cloned().unwrap_or(json!(true)),"block_images":prefs.get("block_images").cloned().unwrap_or(json!(false)),"default_model":prefs.get("default_model").cloned().unwrap_or(json!("")),"default_thinking":prefs.get("default_thinking").cloned().unwrap_or(json!("off")),"web_provider":prefs.get("web_provider").cloned().unwrap_or(json!("searxng")),"web_key_set":!s(&cred["key"]).is_empty()||std::env::var("BRAVE_SEARCH_API_KEY").map(|s|!s.is_empty()).unwrap_or(false),"sandbox":std::env::var("GRAPHY_SANDBOX").unwrap_or_default()=="docker","available_tools":TOOLS});
    for (k, choices) in [
        ("explanation_depth", &["adaptive", "brief", "detailed"][..]),
        (
            "explanation_presentation",
            &["adaptive", "prose", "structured"][..],
        ),
    ] {
        let value = s(&prefs[k]);
        out[k] = json!(if choices.contains(&value) {
            value
        } else {
            "adaptive"
        });
    }
    out["default_style"] = json!(match s(&prefs["default_style"]) {
        "socratic" => "socratic",
        _ => "structured_reference",
    });
    let tools = prefs["learning_tools"]
        .as_array()
        .filter(|a| !a.is_empty())
        .cloned()
        .unwrap_or_else(|| TOOLS.iter().map(|x| json!(x)).collect());
    out["tools"] = json!(tools
        .into_iter()
        .filter(|x| TOOLS.contains(&s(x)))
        .collect::<Vec<_>>());
    Ok(out)
}
fn validate_url(input: &str) -> Result<String, String> {
    let u = url::Url::parse(input.trim())
        .map_err(|_| "Use an HTTP(S) URL without embedded credentials")?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err("Use an HTTP(S) URL without embedded credentials".into());
    }
    Ok(input.trim().trim_end_matches('/').to_owned())
}
pub async fn dispatch(op: &str, data: Value) -> Result<Value, String> {
    let root = catalog::root(&data);
    match op {
        "settings.get" => get(&root),
        "settings.update" => {
            let patch = data.get("patch").unwrap_or(&data);
            let object = patch.as_object().ok_or("Expected an object")?;
            let _guard = auth::lock(&root, "settings.lock").await?;
            let mut prefs = catalog::read(&root, "settings.json")?;
            let mut updates = json!({});
            for (k, v) in object {
                match k.as_str() {
                    "skills_enabled" | "auto_compact" | "block_images" | "anti_slop_enabled" => {
                        if !v.is_boolean() {
                            return Err(format!("{k} must be true or false"));
                        }
                    }
                    "explanation_depth" => {
                        if !["adaptive", "brief", "detailed"].contains(&s(v)) {
                            return Err(
                                "explanation_depth must be one of adaptive, brief, detailed".into(),
                            );
                        }
                    }
                    "explanation_presentation" => {
                        if !["adaptive", "prose", "structured"].contains(&s(v)) {
                            return Err("explanation_presentation must be one of adaptive, prose, structured".into());
                        }
                    }
                    "default_style" => {
                        if !["socratic", "structured_reference"].contains(&s(v)) {
                            return Err(
                                "default_style must be socratic or structured_reference".into());
                        }
                    }
                    "default_thinking" => {
                        if !["off", "minimal", "low", "medium", "high", "xhigh", "max"]
                            .contains(&s(v))
                        {
                            return Err("default_thinking must be one of off, minimal, low, medium, high, xhigh, max".into());
                        }
                    }
                    "default_model" => {
                        if !v.is_string() || (!s(v).is_empty() && !s(v).contains('/')) {
                            return Err("default_model must be provider/model-id or empty".into());
                        }
                    }
                    "web_provider" => {
                        if !["searxng", "duckduckgo", "brave"].contains(&s(v)) {
                            return Err("web_provider must be searxng, duckduckgo, brave".into());
                        }
                    }
                    "tools" => {
                        let arr = v
                            .as_array()
                            .ok_or("tools must be a list of known tool names")?;
                        if arr.iter().any(|x| !TOOLS.contains(&s(x))) {
                            return Err("tools must be a list of known tool names".into());
                        }
                        let mut seen = std::collections::HashSet::new();
                        updates["learning_tools"] = json!(arr
                            .iter()
                            .filter(|x| seen.insert(s(x).to_owned()))
                            .collect::<Vec<_>>());
                        continue;
                    }
                    _ => return Err(format!("Unknown settings: {k}")),
                }
                updates[k] = v.clone();
            }
            merge(&mut prefs, &updates);
            catalog::write(&root, "settings.json", &prefs)?;
            drop(_guard);
            get(&root)
        }
        "settings.web_key" => {
            let key = s(&data["key"]).trim();
            if key.is_empty() {
                return Err("key must be a nonempty string".into());
            }
            auth::set_credential(&root, "web-search", Some(json!({"key":key}))).await?;
            get(&root)
        }
        "providers.connect" => {
            let name = data["name"]
                .as_str()
                .or_else(|| data["provider"].as_str())
                .unwrap_or("");
            if name == "openai-codex" {
                return Err("Use the OAuth login for openai-codex".into());
            }
            let guard = auth::lock(&root, "settings.lock").await?;
            let mut prefs = catalog::read(&root, "settings.json")?;
            let existing = prefs["providers"][name].clone();
            let known = catalog::PRESETS.iter().any(|x| x.0 == name);
            let mut pending = if existing.is_object() {
                existing.clone()
            } else {
                json!({})
            };
            if catalog::local(name) {
                let default = catalog::settings(&root, name)?;
                pending["base_url"] = json!(validate_url(
                    data["base_url"]
                        .as_str()
                        .filter(|x| !x.is_empty())
                        .unwrap_or(s(&default["base_url"]))
                )?);
            } else if !known {
                if !regex::Regex::new(r"^[\w-]+$").unwrap().is_match(name) {
                    return Err(
                        "Use letters, numbers, hyphens or underscores in the provider name".into(),
                    );
                }
                let api = data["api"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing["api"].as_str())
                    .unwrap_or("");
                let endpoint = data["base_url"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing["base_url"].as_str())
                    .unwrap_or("");
                if !["chat", "responses", "anthropic", "google"].contains(&api)
                    || endpoint.is_empty()
                {
                    return Err("A new provider needs api (chat, responses, anthropic, google) and base_url".into());
                }
                pending["api"] = json!(api);
                pending["base_url"] = json!(validate_url(endpoint)?);
            } else if let Some(endpoint) = data["base_url"].as_str().filter(|s| !s.is_empty()) {
                pending["base_url"] = json!(validate_url(endpoint)?);
            }
            if let Some(key) = data["key"].as_str() {
                auth::update_credential(&root, name, json!({"key":key})).await?;
            }
            if !pending.as_object().is_some_and(|o| o.is_empty()) {
                if !prefs["providers"].is_object() {
                    prefs["providers"] = json!({});
                }
                prefs["providers"][name] = pending;
            }
            catalog::write(&root, "settings.json", &prefs)?;
            drop(guard);
            let refresh = catalog::dispatch(
                "models.refresh",
                json!({"store_dir":root.to_string_lossy(),"provider":name}),
            )
            .await;
            let discovery = match refresh {
                Ok(_) => json!({"ok":true,"error":""}),
                Err(e) => json!({"ok":false,"error":e}),
            };
            let rows = catalog::dispatch(
                "providers.list",
                json!({"store_dir":root.to_string_lossy()}),
            )
            .await?;
            let provider = rows
                .as_array()
                .and_then(|a| a.iter().find(|v| s(&v["name"]) == name))
                .cloned()
                .unwrap_or(Value::Null);
            Ok(
                json!({"provider":provider,"discovery":discovery,"models":catalog::available(&root)?.iter().map(catalog::row).collect::<Vec<_>>() }),
            )
        }
        "providers.disconnect" => {
            let name = data["name"]
                .as_str()
                .or_else(|| data["provider"].as_str())
                .unwrap_or("");
            let rows = catalog::dispatch(
                "providers.list",
                json!({"store_dir":root.to_string_lossy()}),
            )
            .await?;
            if !rows
                .as_array()
                .is_some_and(|a| a.iter().any(|v| s(&v["name"]) == name))
            {
                return Err("Unknown provider".into());
            }
            auth::set_credential(&root, name, None).await?;
            let rows = catalog::dispatch(
                "providers.list",
                json!({"store_dir":root.to_string_lossy()}),
            )
            .await?;
            Ok(rows
                .as_array()
                .and_then(|a| a.iter().find(|v| s(&v["name"]) == name))
                .cloned()
                .unwrap_or(Value::Null))
        }
        _ => Err(format!("Unknown settings operation: {op}")),
    }
}
