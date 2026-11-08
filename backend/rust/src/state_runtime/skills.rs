use super::journal::text;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};
pub(super) const MAX: u64 = 48 * 1024;
pub(super) fn metadata(content: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut lines = content.lines();
    if lines.next().unwrap_or("").trim() != "---" {
        return out;
    }
    let mut key = String::new();
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if line.starts_with(char::is_whitespace) && !key.is_empty() {
            let old = out.get(&key).cloned().unwrap_or_default();
            out.insert(
                key.clone(),
                format!("{} {}", old, line.trim()).trim().to_string(),
            );
            continue;
        }
        key.clear();
        if let Some((k, v)) = line.split_once(':') {
            if k == "name" || k == "description" {
                key = k.to_string();
                let value = v.trim();
                let value = if ["|", ">", "|-", ">-"].contains(&value) {
                    String::new()
                } else if value.starts_with('"') {
                    serde_json::from_str::<String>(value).unwrap_or_else(|_| value.to_string())
                } else if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
                    value[1..value.len() - 1].replace("''", "'")
                } else {
                    value.to_string()
                };
                out.insert(key.clone(), value);
            }
        }
    }
    out
}
pub(super) fn roots(d: &Value) -> Result<Vec<PathBuf>, String> {
    let cwd = text(d, "cwd");
    let root = text(d, "store_dir");
    if cwd.is_empty() || root.is_empty() {
        return Err("Missing cwd or store_dir".into());
    }
    let home = d
        .get("home")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| std::env::var("HOME").ok())
        .ok_or("Missing home directory")?;
    Ok(vec![
        Path::new(cwd).join(".graphy/skills"),
        Path::new(cwd).join(".agents/skills"),
        Path::new(root).join("skills"),
        Path::new(&home).join(".agents/skills"),
        bundled_dir(d),
    ])
}
/// Skills shipped with the app (`resources/skills/<name>/SKILL.md` and their supporting files). Last in
/// `roots`, so a user or project skill with the same name replaces the bundled one.
pub(super) fn bundled_dir(d: &Value) -> PathBuf {
    d.get("resource_dir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("GRAPHY_RESOURCE_DIR").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../graphy"))
        .join("resources/skills")
}
pub(super) fn list(d: &Value) -> Result<Value, String> {
    let mut rows = BTreeMap::<String, Value>::new();
    let mut warnings = Vec::new();
    let include_disabled = d.get("include_disabled").and_then(Value::as_bool) == Some(true);
    let disabled = if include_disabled {
        Default::default()
    } else {
        super::skill_library::disabled(d)
    };
    let folders = roots(d)?;
    let folders = if d["project_only"] == true {
        &folders[..1]
    } else {
        &folders[..]
    };
    for folder in folders {
        if !folder.exists() {
            continue;
        }
        let mut paths = fs::read_dir(&folder)
            .map_err(|e| e.to_string())?
            .map(|x| x.map(|e| e.path()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        paths.sort();
        for p in paths {
            if p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with('.'))
            {
                continue;
            }
            let path = p.join("SKILL.md");
            if !path.exists() {
                continue;
            }
            let entry = (|| -> Result<Value, String> {
                let m = fs::metadata(&path).map_err(|e| e.to_string())?;
                if m.len() > MAX {
                    return Err("SKILL.md exceeds 48 KiB".into());
                }
                let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let meta = metadata(&content);
                let default = p.file_name().unwrap_or_default().to_string_lossy();
                let name = meta.get("name").map(String::as_str).unwrap_or(&default);
                if name.is_empty()
                    || name.len() > 64
                    || !name.as_bytes()[0].is_ascii_lowercase()
                        && !name.as_bytes()[0].is_ascii_digit()
                    || !name.bytes().all(|x| {
                        x.is_ascii_lowercase() || x.is_ascii_digit() || x == b'-' || x == b'_'
                    })
                {
                    return Err("Use a lowercase skill name with letters, digits, - or _".into());
                }
                let description = meta
                    .get("description")
                    .filter(|x| !x.is_empty())
                    .cloned()
                    .unwrap_or_else(|| {
                        content
                            .lines()
                            .find(|x| {
                                !x.trim().is_empty() && !x.starts_with('#') && !x.starts_with("---")
                            })
                            .unwrap_or(name)
                            .trim()
                            .to_string()
                    });
                if disabled.contains(name) {
                    return Ok(Value::Null);
                }
                Ok(
                    json!({"name":name,"description":description.chars().take(500).collect::<String>(),"path":path.canonicalize().map_err(|e|e.to_string())?.to_string_lossy()}),
                )
            })();
            match entry {
                Ok(Value::Null) => {}
                Ok(row) => {
                    rows.entry(text(&row, "name").to_owned()).or_insert(row);
                }
                Err(e) => warnings.push(format!("{}: {e}", path.display())),
            }
        }
    }
    Ok(json!({"skills":rows.into_values().collect::<Vec<_>>(),"warnings":warnings}))
}
pub fn dispatch(op: &str, d: Value) -> Result<Value, String> {
    let listed = list(&d)?;
    if op == "skills.list" {
        return Ok(listed);
    }
    let name = text(&d, "name");
    let row = listed["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| text(x, "name") == name)
        .ok_or_else(|| {
            if super::skill_library::disabled(&d).contains(name) {
                "Skill is disabled in the skills library".to_string()
            } else {
                "Unknown skill. Use /skills to list available skills".to_string()
            }
        })?;
    let path = Path::new(text(row, "path"));
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > MAX as usize {
        return Err("SKILL.md exceeds 48 KiB".into());
    }
    let instructions = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    let mut result = row.clone();
    result["instructions"] = json!(instructions);
    result["base_directory"] = json!(path.parent().unwrap().to_string_lossy());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_document_style_skill_is_listed_with_its_files() {
        let t = tempfile::tempdir().unwrap();
        let d = json!({"store_dir": t.path().join("store"), "cwd": t.path().join("cwd"), "home": t.path().join("home")});
        let listed = list(&d).unwrap();
        let row = listed["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["name"] == "graphy-document-style")
            .expect("bundled graphy-document-style skill is not listed");
        assert!(listed["warnings"].as_array().unwrap().is_empty(), "{listed}");
        let dir = bundled_dir(&d).join("graphy-document-style");
        assert_eq!(Path::new(row["path"].as_str().unwrap()), dir.join("SKILL.md").canonicalize().unwrap());
        for f in [
            "SKILL.md", "document.css", "skeleton.html", "build.mjs", "katex.min.cjs",
            "fonts/CMUSerif-Roman.woff2", "fonts/CMUSerif-Italic.woff2", "fonts/CMUSerif-Bold.woff2",
            "fonts/CMUSerif-BoldItalic.woff2", "fonts/CMUTypewriter-Regular.woff2", "fonts/LatinModernMath.woff2",
        ] {
            assert!(dir.join(f).is_file(), "missing {f}");
        }
        let loaded = dispatch("skills.load", with_name(&d, "graphy-document-style")).unwrap();
        assert!(loaded["instructions"].as_str().unwrap().contains("build.mjs"));
        assert!(loaded["base_directory"].as_str().unwrap().ends_with("graphy-document-style"));
    }
    fn with_name(d: &Value, name: &str) -> Value {
        let mut o = d.clone();
        o["name"] = json!(name);
        o
    }
}
