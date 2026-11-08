//! Skills library: user skills in `$GRAPHY_DIR/skills/<id>/SKILL.md`, per-skill enable switch,
//! content hashes, drift detection and a bundled (offline) catalog of installable skills.
//! Every write goes through `lib_dir` + `valid_id`, so nothing is written outside the skills dir
//! and nothing the user edited is replaced without an explicit `force`.
use super::journal::text;
use super::skills::{metadata, MAX};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_SKILLS: usize = 200;
const MAX_FILES: usize = 64;
const MAX_TOTAL: u64 = 2 * 1024 * 1024;
const MAX_FILE: u64 = 1024 * 1024;
const STATE: &str = ".state.json";
const CATALOG_STATE: &str = ".catalog.json";

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// Ids that would collide with fixed routes (`GET /skills/library`, `/skills/catalog`, `POST /skills/import`).
const RESERVED: [&str; 3] = ["library", "catalog", "import"];
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !RESERVED.contains(&id)
        && !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|x| x.is_ascii_lowercase() || x.is_ascii_digit() || *x == b'-' || *x == b'_')
}
fn lib_dir(d: &Value) -> Result<PathBuf, String> {
    let root = text(d, "store_dir");
    if root.is_empty() {
        return Err("Missing store_dir".into());
    }
    Ok(Path::new(root).join("skills"))
}
fn skill_dir(d: &Value, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Use a lowercase skill name with letters, digits, - or _".into());
    }
    Ok(lib_dir(d)?.join(id))
}
fn is_real_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}
fn read_json(p: &Path) -> Value {
    fs::read(p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("Bad path")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut t = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    t.write_all(bytes)
        .and_then(|_| t.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    t.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn write_json(path: &Path, v: &Value) -> Result<(), String> {
    let mut b = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    b.push(b'\n');
    write_atomic(path, &b)
}

/// Names of skills the user switched off (they are neither offered nor loadable).
pub fn disabled(d: &Value) -> HashSet<String> {
    let Ok(dir) = lib_dir(d) else {
        return HashSet::new();
    };
    read_json(&dir.join(STATE))["disabled"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

fn tags_of(content: &str) -> Vec<String> {
    let mut lines = content.lines();
    if lines.next().unwrap_or("").trim() != "---" {
        return vec![];
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some(v) = line.strip_prefix("tags:") {
            return v
                .trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .map(|t| t.trim().trim_matches(['"', '\'']).to_lowercase())
                .filter(|t| !t.is_empty() && t.chars().count() <= 24)
                .take(8)
                .collect();
        }
    }
    vec![]
}

/// Validate a full SKILL.md. Returns (name, description).
pub fn validate_content(
    content: &str,
    expect_id: Option<&str>,
) -> Result<(String, String), String> {
    if content.len() as u64 > MAX {
        return Err("SKILL.md exceeds 48 KiB".into());
    }
    if content.contains('\0') {
        return Err("SKILL.md must be text".into());
    }
    let mut lines = content.lines();
    if lines.next().unwrap_or("").trim() != "---" {
        return Err("SKILL.md must start with a --- frontmatter block".into());
    }
    let mut closed = false;
    let mut after = Vec::new();
    for line in lines {
        if closed {
            after.push(line);
        } else if line.trim() == "---" {
            closed = true;
        }
    }
    if !closed {
        return Err("Frontmatter is not closed with ---".into());
    }
    let meta = metadata(content);
    let name = meta.get("name").cloned().unwrap_or_default();
    if !valid_id(&name) {
        return Err("Frontmatter name must be lowercase letters, digits, - or _ (max 64)".into());
    }
    if let Some(id) = expect_id {
        if id != name {
            return Err(format!(
                "Frontmatter name '{name}' must match the skill id '{id}'"
            ));
        }
    }
    let description = meta.get("description").cloned().unwrap_or_default();
    if description.trim().is_empty() {
        return Err("Frontmatter description is required".into());
    }
    if description.chars().count() > 500 {
        return Err("Description is longer than 500 characters".into());
    }
    if after.iter().all(|l| l.trim().is_empty()) {
        return Err("Skill instructions (body) are empty".into());
    }
    Ok((name, description))
}

fn build_content(name: &str, description: &str, tags: &[String], body: &str) -> String {
    let desc = description.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = format!(
        "---\nname: {name}\ndescription: {}\n",
        serde_json::to_string(&desc).unwrap_or_default()
    );
    if !tags.is_empty() {
        out.push_str(&format!("tags: {}\n", tags.join(", ")));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim_matches('\n'));
    out.push('\n');
    out
}
fn str_list(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str())
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty() && !t.contains([',', '\n']))
        .take(8)
        .collect()
}

struct Row {
    id: String,
    path: PathBuf,
    content: Option<String>,
    size: u64,
    mtime: f64,
    warnings: Vec<String>,
}
fn scan_library(d: &Value) -> Result<Vec<Row>, String> {
    let dir = lib_dir(d)?;
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&dir) else {
        return Ok(out);
    };
    let mut paths = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect::<Vec<_>>();
    paths.sort();
    for p in paths {
        let id = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if id.starts_with('.') || !is_real_dir(&p) {
            continue;
        }
        let file = p.join("SKILL.md");
        let Ok(m) = fs::metadata(&file) else {
            continue;
        };
        let mut warnings = Vec::new();
        let content = if m.len() > MAX {
            warnings.push("SKILL.md exceeds 48 KiB".to_string());
            None
        } else {
            match fs::read_to_string(&file) {
                Ok(c) => Some(c),
                Err(e) => {
                    warnings.push(e.to_string());
                    None
                }
            }
        };
        let mtime = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |t| t.as_secs_f64());
        out.push(Row {
            id,
            path: file,
            content,
            size: m.len(),
            mtime,
            warnings,
        });
    }
    Ok(out)
}

fn catalog_state(d: &Value) -> Value {
    lib_dir(d).map_or(json!({}), |p| read_json(&p.join(CATALOG_STATE)))
}
fn version_newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| {
        v.split(['.', '-'])
            .map(|x| x.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (mut x, mut y) = (parse(a), parse(b));
    let n = x.len().max(y.len());
    x.resize(n, 0);
    y.resize(n, 0);
    x > y
}

fn catalog_entries(d: &Value) -> Result<(Vec<Value>, PathBuf), String> {
    let res = d
        .get("resource_dir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("GRAPHY_RESOURCE_DIR").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../graphy"))
        .join("resources");
    let file = res.join("skill-catalog.json");
    let v: Value = match fs::read(&file) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("Invalid skill catalog: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({"skills":[]}),
        Err(e) => return Err(format!("Cannot read skill catalog: {e}")),
    };
    Ok((v["skills"].as_array().cloned().unwrap_or_default(), res))
}
/// The SKILL.md text of a catalog entry (embedded `body` or a relative `file` inside resources).
fn catalog_body(entry: &Value, res: &Path) -> Result<String, String> {
    if let Some(b) = entry["body"].as_str() {
        return Ok(b.to_string());
    }
    let rel = entry["file"]
        .as_str()
        .ok_or("Catalog entry has no body or file")?;
    let rp = Path::new(rel);
    if rp.is_absolute() || rp.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("Catalog file must be a relative path inside resources".into());
    }
    let full = res.join(rp);
    let real = full
        .canonicalize()
        .map_err(|e| format!("Cannot read catalog file: {e}"))?;
    let base = res.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&base) {
        return Err("Catalog file escapes the resources directory".into());
    }
    if fs::metadata(&real).map_err(|e| e.to_string())?.len() > MAX {
        return Err("SKILL.md exceeds 48 KiB".into());
    }
    fs::read_to_string(real).map_err(|e| e.to_string())
}

fn library(d: &Value) -> Result<Value, String> {
    let off = disabled(d);
    let cat = catalog_state(d);
    let (entries, _) = catalog_entries(d).unwrap_or_default();
    let lib = lib_dir(d)?;
    let mut rows = Vec::new();
    let mut names = HashSet::new();
    let mut warnings = Vec::new();
    for r in scan_library(d)? {
        let mut w = r.warnings.clone();
        let hash = r
            .content
            .as_ref()
            .map(|c| sha256_hex(c.as_bytes()))
            .unwrap_or_default();
        let meta = r.content.as_deref().map(metadata).unwrap_or_default();
        let name = meta.get("name").cloned().unwrap_or_else(|| r.id.clone());
        if r.content.is_some() {
            if let Err(e) = validate_content(r.content.as_deref().unwrap_or(""), None) {
                w.push(e);
            } else if name != r.id {
                w.push(format!(
                    "Frontmatter name '{name}' differs from folder '{}'",
                    r.id
                ));
            }
        }
        let installed = cat["installed"].get(&r.id).filter(|v| v.is_object());
        let entry = entries.iter().find(|e| e["id"] == r.id.as_str());
        let mut row = json!({
            "id": r.id, "name": name,
            "description": meta.get("description").map(|x| x.chars().take(500).collect::<String>()).unwrap_or_default(),
            "tags": r.content.as_deref().map(tags_of).unwrap_or_default(),
            "source": if installed.is_some() { "catalog" } else { "user" },
            "path": r.path.to_string_lossy(), "enabled": !off.contains(&name),
            "hash": hash, "modified": false, "size": r.size, "updated": r.mtime,
            "editable": true, "warnings": w,
        });
        if let Some(i) = installed {
            row["modified"] =
                json!(i["sha256"].as_str().unwrap_or("") != row["hash"].as_str().unwrap_or(""));
            let iv = i["version"].as_str().unwrap_or("");
            row["catalog"] = json!({
                "id": r.id, "installed_version": iv,
                "latest_version": entry.map_or("", |e| e["version"].as_str().unwrap_or("")),
                "update_available": entry.is_some_and(|e| version_newer(e["version"].as_str().unwrap_or(""), iv)),
            });
            if let Some(e) = entry {
                if row["tags"].as_array().is_some_and(|t| t.is_empty()) {
                    row["tags"] = e["tags"].clone();
                }
            }
        }
        names.insert(r.id.clone());
        names.insert(name);
        rows.push(row);
    }
    // Skills found in the other discovery folders: shown read-only, can still be switched off.
    let mut ext = json!({"store_dir": d["store_dir"], "cwd": d["cwd"], "include_disabled": true});
    for key in ["home", "resource_dir"] {
        if let Some(h) = d.get(key) {
            ext[key] = h.clone();
        }
    }
    if let Ok(listed) = super::skills::list(&ext) {
        for w in listed["warnings"].as_array().into_iter().flatten() {
            warnings.push(w.clone());
        }
        for s in listed["skills"].as_array().into_iter().flatten() {
            let name = text(s, "name");
            let path = Path::new(text(s, "path"));
            if names.contains(name)
                || path.starts_with(lib.canonicalize().unwrap_or_else(|_| lib.clone()))
            {
                continue;
            }
            let bytes = fs::read(path).unwrap_or_default();
            rows.push(json!({
                "id": name, "name": name, "description": s["description"],
                "tags": tags_of(&String::from_utf8_lossy(&bytes)),
                "source": "external", "path": s["path"], "enabled": !off.contains(name),
                "hash": sha256_hex(&bytes), "modified": false, "size": bytes.len(),
                "updated": fs::metadata(path).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |t| t.as_secs_f64()),
                "editable": false, "warnings": [],
            }));
        }
    }
    for r in &rows {
        for w in r["warnings"].as_array().into_iter().flatten() {
            warnings.push(json!(format!(
                "{}: {}",
                r["id"].as_str().unwrap_or(""),
                w.as_str().unwrap_or("")
            )));
        }
    }
    Ok(json!({"skills": rows, "warnings": warnings}))
}

fn find(d: &Value, id: &str) -> Result<Value, String> {
    library(d)?["skills"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["id"] == id).cloned())
        .ok_or_else(|| "not_found: Unknown skill".to_string())
}
fn read(d: &Value) -> Result<Value, String> {
    let mut row = find(d, text(d, "id"))?;
    let path = PathBuf::from(row["path"].as_str().unwrap_or(""));
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX {
        return Err("SKILL.md exceeds 48 KiB".into());
    }
    row["content"] = json!(String::from_utf8_lossy(&bytes));
    Ok(row)
}

/// Atomically publish a directory prepared in a staging folder as `skills/<id>`.
fn place(d: &Value, id: &str, stage: &Path) -> Result<(), String> {
    let target = skill_dir(d, id)?;
    if fs::symlink_metadata(&target).is_ok() {
        let _ = fs::remove_dir_all(stage);
        return Err(format!("conflict: Skill '{id}' already exists"));
    }
    fs::rename(stage, &target).map_err(|e| {
        let _ = fs::remove_dir_all(stage);
        e.to_string()
    })
}
fn stage_dir(d: &Value) -> Result<PathBuf, String> {
    let lib = lib_dir(d)?;
    let n = scan_library(d)?.len();
    if n >= MAX_SKILLS {
        return Err(format!("Skills library is limited to {MAX_SKILLS} skills"));
    }
    let s = lib.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&s).map_err(|e| e.to_string())?;
    Ok(s)
}
fn create_from_content(d: &Value, content: &str, extra: Option<&Path>) -> Result<Value, String> {
    let (name, _) = validate_content(content, None)?;
    if fs::symlink_metadata(skill_dir(d, &name)?).is_ok() {
        return Err(format!("conflict: Skill '{name}' already exists"));
    }
    let stage = stage_dir(d)?;
    let res = (|| {
        if let Some(src) = extra {
            let mut budget = (MAX_FILES, MAX_TOTAL);
            copy_tree(src, &stage, 0, &mut budget)?;
        }
        write_atomic(&stage.join("SKILL.md"), content.as_bytes())
    })();
    if let Err(e) = res {
        let _ = fs::remove_dir_all(&stage);
        return Err(e);
    }
    place(d, &name, &stage)?;
    find(d, &name)
}
fn copy_tree(
    src: &Path,
    dst: &Path,
    depth: usize,
    budget: &mut (usize, u64),
) -> Result<(), String> {
    if depth > 3 {
        return Ok(());
    }
    let mut entries = fs::read_dir(src)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .collect::<Vec<_>>();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "SKILL.md" && depth == 0 {
            continue;
        }
        let ft = e.file_type().map_err(|x| x.to_string())?;
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            fs::create_dir_all(dst.join(&name)).map_err(|x| x.to_string())?;
            copy_tree(&e.path(), &dst.join(&name), depth + 1, budget)?;
        } else if ft.is_file() {
            let len = e.metadata().map_err(|x| x.to_string())?.len();
            if len > MAX_FILE {
                return Err(format!("{name} is larger than 1 MiB"));
            }
            if budget.0 == 0 || budget.1 < len {
                return Err("Skill folder is too large (max 64 files, 2 MiB)".into());
            }
            budget.0 -= 1;
            budget.1 -= len;
            fs::copy(e.path(), dst.join(&name)).map_err(|x| x.to_string())?;
        }
    }
    Ok(())
}

fn create(d: &Value) -> Result<Value, String> {
    let name = text(d, "name").trim();
    if !valid_id(name) {
        return Err("Use a lowercase skill name with letters, digits, - or _".into());
    }
    let content = build_content(
        name,
        text(d, "description"),
        &str_list(&d["tags"]),
        text(d, "body"),
    );
    create_from_content(d, &content, None)
}
fn import(d: &Value) -> Result<Value, String> {
    let path = text(d, "path").trim();
    if !path.is_empty() {
        let p = Path::new(path)
            .canonicalize()
            .map_err(|e| format!("Cannot open {path}: {e}"))?;
        let (file, folder) = if p.is_dir() {
            (p.join("SKILL.md"), Some(p.clone()))
        } else {
            (p.clone(), None)
        };
        let m = fs::metadata(&file).map_err(|_| "SKILL.md not found at this path".to_string())?;
        if !m.is_file() || m.len() > MAX {
            return Err("SKILL.md must be a file up to 48 KiB".into());
        }
        let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        return create_from_content(d, &content, folder.as_deref());
    }
    let mut content = text(d, "content").replace("\r\n", "\n");
    if content.trim().is_empty() {
        return Err("Provide a path or the SKILL.md text".into());
    }
    if !content.trim_start().starts_with("---") {
        let name = text(d, "name").trim();
        if !valid_id(name) {
            return Err("SKILL.md has no frontmatter; give a valid name and description".into());
        }
        content = build_content(name, text(d, "description"), &[], &content);
    }
    create_from_content(d, content.trim_start(), None)
}
fn update(d: &Value) -> Result<Value, String> {
    let id = text(d, "id");
    let dir = skill_dir(d, id)?;
    if !is_real_dir(&dir) {
        return Err("not_found: Unknown user skill".into());
    }
    let content = text(d, "content").replace("\r\n", "\n");
    validate_content(&content, Some(id))?;
    let file = dir.join("SKILL.md");
    let cur = fs::read(&file).map_err(|e| e.to_string())?;
    if let Some(h) = d.get("expected_hash").and_then(Value::as_str) {
        if h != sha256_hex(&cur) {
            return Err("conflict: The skill changed on disk since you opened it".into());
        }
    }
    write_atomic(&file, content.as_bytes())?;
    find(d, id)
}
fn forget(d: &Value, id: &str, name: &str) -> Result<(), String> {
    let lib = lib_dir(d)?;
    let mut st = read_json(&lib.join(STATE));
    // a same-named external skill still exists: it keeps its switch state
    let external = d.get("home").map_or_else(
        || json!({"store_dir": d["store_dir"], "cwd": d["cwd"], "include_disabled": true}),
        |h| json!({"store_dir": d["store_dir"], "cwd": d["cwd"], "home": h, "include_disabled": true}),
    );
    let still = super::skills::list(&external).is_ok_and(|l| {
        l["skills"]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| text(x, "name") == name))
    });
    if !still {
        if let Some(a) = st["disabled"].as_array_mut() {
            a.retain(|x| x != name);
        }
        write_json(&lib.join(STATE), &st)?;
    }
    let mut cs = catalog_state(d);
    if let Some(o) = cs["installed"].as_object_mut() {
        o.remove(id);
    }
    write_json(&lib.join(CATALOG_STATE), &cs)
}
fn delete(d: &Value) -> Result<Value, String> {
    let id = text(d, "id");
    let dir = skill_dir(d, id)?;
    if !is_real_dir(&dir) {
        return Err("not_found: Unknown user skill".into());
    }
    let name = metadata(&fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default())
        .get("name")
        .cloned()
        .unwrap_or_else(|| id.to_string());
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    forget(d, id, &name)?;
    Ok(json!({"deleted": true, "id": id}))
}
fn set_enabled(d: &Value) -> Result<Value, String> {
    let row = find(d, text(d, "id"))?;
    let name = row["name"].as_str().unwrap_or("").to_string();
    let on = d
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or("enabled must be a boolean")?;
    let lib = lib_dir(d)?;
    let mut set = disabled(d)
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    if on {
        set.remove(&name);
    } else {
        set.insert(name);
    }
    let mut st = read_json(&lib.join(STATE));
    st["disabled"] = json!(set);
    write_json(&lib.join(STATE), &st)?;
    find(d, text(d, "id"))
}
fn duplicate(d: &Value) -> Result<Value, String> {
    let src = read(d)?;
    let id = text(&src, "id").to_string();
    let content = text(&src, "content");
    let meta = metadata(content);
    let desc = meta.get("description").cloned().unwrap_or_default();
    let body = {
        let mut it = content.lines();
        it.next();
        let mut closed = false;
        let mut body = Vec::new();
        for l in it {
            if closed {
                body.push(l);
            } else if l.trim() == "---" {
                closed = true;
            }
        }
        body.join("\n")
    };
    let mut n = 1;
    let new = loop {
        let cand = if n == 1 {
            format!("{id}-copy")
        } else {
            format!("{id}-copy-{n}")
        };
        let cand = cand.chars().take(64).collect::<String>();
        if fs::symlink_metadata(skill_dir(d, &cand)?).is_err() {
            break cand;
        }
        n += 1;
        if n > 99 {
            return Err("Too many copies".into());
        }
    };
    let out = build_content(&new, &desc, &tags_of(content), &body);
    let folder = Path::new(text(&src, "path"))
        .parent()
        .map(Path::to_path_buf);
    create_from_content(d, &out, folder.as_deref())
}

fn catalog(d: &Value) -> Result<Value, String> {
    let (entries, res) = catalog_entries(d)?;
    let st = catalog_state(d);
    let lib = library(d)?;
    let mut out = Vec::new();
    let mut warnings = Vec::new();
    for e in &entries {
        let id = e["id"].as_str().unwrap_or("");
        if !valid_id(id) || e["sha256"].as_str().is_none() {
            warnings.push(json!(format!("Catalog entry '{id}' is malformed")));
            continue;
        }
        let local = lib["skills"]
            .as_array()
            .and_then(|a| a.iter().find(|x| x["id"] == id));
        let inst = st["installed"].get(id).filter(|v| v.is_object());
        let iv = inst.map_or("", |i| i["version"].as_str().unwrap_or(""));
        let version = e["version"].as_str().unwrap_or("");
        out.push(json!({
            "id": id, "title": e["title"].as_str().unwrap_or(id),
            "description": e["description"], "version": version,
            "tags": e["tags"].as_array().cloned().unwrap_or_default(),
            "sha256": e["sha256"], "example": e["example"].as_bool().unwrap_or(false),
            "installed": inst.is_some() && local.is_some(),
            "installed_version": if inst.is_some() && local.is_some() { iv } else { "" },
            "update_available": inst.is_some() && local.is_some() && version_newer(version, iv),
            "modified": local.is_some_and(|l| l["modified"] == true && inst.is_some()),
            "conflict": inst.is_none() && local.is_some(),
        }));
    }
    let _ = res;
    Ok(json!({"skills": out, "warnings": warnings}))
}
fn catalog_install(d: &Value) -> Result<Value, String> {
    let id = text(d, "id");
    let (entries, res) = catalog_entries(d)?;
    let entry = entries
        .iter()
        .find(|e| e["id"] == id)
        .ok_or("not_found: Unknown catalog skill")?;
    let body = catalog_body(entry, &res)?;
    if sha256_hex(body.as_bytes()) != entry["sha256"].as_str().unwrap_or("").to_lowercase() {
        return Err("Catalog entry failed its sha256 check; it was not installed".into());
    }
    validate_content(&body, Some(id))?;
    let dir = skill_dir(d, id)?;
    let st = catalog_state(d);
    let lib = lib_dir(d)?;
    let version = entry["version"].as_str().unwrap_or("0");
    if fs::symlink_metadata(&dir).is_ok() {
        if !is_real_dir(&dir)
            || fs::symlink_metadata(dir.join("SKILL.md")).is_ok_and(|m| !m.is_file())
        {
            return Err(format!("conflict: '{id}' is not a regular skill folder"));
        }
        let inst = st["installed"].get(id).filter(|v| v.is_object());
        let Some(inst) = inst else {
            return Err(format!(
                "conflict: A skill named '{id}' already exists and is not from the catalog"
            ));
        };
        let cur = fs::read(dir.join("SKILL.md")).unwrap_or_default();
        let modified = sha256_hex(&cur) != inst["sha256"].as_str().unwrap_or("");
        if modified && d.get("force").and_then(Value::as_bool) != Some(true) {
            return Err("conflict: skill_modified: You edited this skill; installing would replace your changes".into());
        }
        if modified {
            let nanos = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |t| t.as_nanos());
            let mut n = 0u32;
            loop {
                let name = if n == 0 {
                    format!("SKILL.user-{nanos}.md")
                } else {
                    format!("SKILL.user-{nanos}-{n}.md")
                };
                match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(dir.join(name))
                {
                    Ok(mut f) => {
                        f.write_all(&cur).map_err(|e| e.to_string())?;
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && n < 100 => n += 1,
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        write_atomic(&dir.join("SKILL.md"), body.as_bytes())?;
    } else {
        let stage = stage_dir(d)?;
        if let Err(e) = write_atomic(&stage.join("SKILL.md"), body.as_bytes()) {
            let _ = fs::remove_dir_all(&stage);
            return Err(e);
        }
        place(d, id, &stage)?;
    }
    let mut cs = st;
    cs["installed"][id] = json!({"version": version, "sha256": sha256_hex(body.as_bytes()),
        "installed_at": std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |t| t.as_secs())});
    write_json(&lib.join(CATALOG_STATE), &cs)?;
    find(d, id)
}

pub fn dispatch(op: &str, d: Value) -> Result<Value, String> {
    // one writer at a time: .state.json / .catalog.json are read-modify-write
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match op {
        "skills.library" => library(&d),
        "skills.read" => read(&d),
        "skills.create" => create(&d),
        "skills.import" => import(&d),
        "skills.update" => update(&d),
        "skills.delete" => delete(&d),
        "skills.enable" => set_enabled(&d),
        "skills.duplicate" => duplicate(&d),
        "skills.catalog" => catalog(&d),
        "skills.catalog_install" => catalog_install(&d),
        _ => Err(format!("Unknown state operation: {op}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env() -> (tempfile::TempDir, Value) {
        let t = tempfile::tempdir().unwrap();
        let res = t.path().join("res");
        fs::create_dir_all(res.join("resources")).unwrap();
        let d = json!({"store_dir": t.path().join("store"), "cwd": t.path().join("cwd"),
            "home": t.path().join("home"), "resource_dir": res});
        fs::create_dir_all(t.path().join("store")).unwrap();
        (t, d)
    }
    fn with(d: &Value, kv: Value) -> Value {
        let mut o = d.clone();
        for (k, v) in kv.as_object().unwrap() {
            o[k] = v.clone();
        }
        o
    }
    fn make(d: &Value, name: &str) -> Value {
        dispatch(
            "skills.create",
            with(
                d,
                json!({"name":name,"description":"Does a thing","body":"Do it."}),
            ),
        )
        .unwrap()
    }

    #[test]
    fn ids_and_traversal_are_rejected() {
        let (t, d) = env();
        for bad in ["../x", "a/b", "A", "", "x y", ".hidden", "-x"] {
            let r = dispatch(
                "skills.create",
                with(&d, json!({"name":bad,"description":"d","body":"b"})),
            );
            assert!(r.is_err(), "{bad}");
        }
        assert!(dispatch("skills.delete", with(&d, json!({"id":"../store"}))).is_err());
        assert!(dispatch(
            "skills.update",
            with(&d, json!({"id":"../x","content":"x"}))
        )
        .is_err());
        assert!(!t.path().join("x").exists());
    }
    #[test]
    fn frontmatter_validation() {
        assert!(validate_content("no frontmatter", None).is_err());
        assert!(validate_content("---\nname: a\ndescription: d\n", None).is_err());
        assert!(validate_content("---\nname: A b\ndescription: d\n---\nbody", None).is_err());
        assert!(validate_content("---\nname: a\n---\nbody", None).is_err());
        assert!(validate_content("---\nname: a\ndescription: d\n---\n\n", None).is_err());
        assert!(validate_content("---\nname: a\ndescription: d\n---\nbody", Some("b")).is_err());
        assert!(validate_content(
            &format!(
                "---\nname: a\ndescription: d\n---\n{}",
                "x".repeat(49 * 1024)
            ),
            None
        )
        .is_err());
        assert_eq!(
            validate_content("---\nname: a\ndescription: d\n---\nbody", Some("a")).unwrap(),
            ("a".to_string(), "d".to_string())
        );
    }
    #[test]
    fn create_list_edit_delete_round_trip() {
        let (_t, d) = env();
        let row = make(&d, "my-tutor");
        assert_eq!(row["source"], "user");
        assert_eq!(row["enabled"], true);
        assert!(make_err(&d, "my-tutor").contains("already exists"));
        let listed = crate::state_runtime::skills::dispatch("skills.list", d.clone()).unwrap();
        assert_eq!(listed["skills"][0]["name"], "my-tutor");
        let read = dispatch("skills.read", with(&d, json!({"id":"my-tutor"}))).unwrap();
        let new = read["content"]
            .as_str()
            .unwrap()
            .replace("Do it.", "Do it better.");
        let stale = dispatch(
            "skills.update",
            with(
                &d,
                json!({"id":"my-tutor","content":new,"expected_hash":"deadbeef"}),
            ),
        );
        assert!(stale.unwrap_err().starts_with("conflict:"));
        let up = dispatch(
            "skills.update",
            with(
                &d,
                json!({"id":"my-tutor","content":new,"expected_hash":read["hash"]}),
            ),
        )
        .unwrap();
        assert_ne!(up["hash"], read["hash"]);
        let del = dispatch("skills.delete", with(&d, json!({"id":"my-tutor"}))).unwrap();
        assert_eq!(del["deleted"], true);
        assert_eq!(
            dispatch("skills.library", d.clone()).unwrap()["skills"],
            json!([])
        );
    }
    fn make_err(d: &Value, name: &str) -> String {
        dispatch(
            "skills.create",
            with(d, json!({"name":name,"description":"x","body":"y"})),
        )
        .unwrap_err()
    }
    #[test]
    fn disabled_skill_is_hidden_and_not_loadable() {
        let (_t, d) = env();
        make(&d, "alpha");
        make(&d, "beta");
        let r = dispatch(
            "skills.enable",
            with(&d, json!({"id":"alpha","enabled":false})),
        )
        .unwrap();
        assert_eq!(r["enabled"], false);
        let listed = crate::state_runtime::skills::dispatch("skills.list", d.clone()).unwrap();
        assert_eq!(listed["skills"].as_array().unwrap().len(), 1);
        let err = crate::state_runtime::skills::dispatch(
            "skills.load",
            with(&d, json!({"name":"alpha"})),
        )
        .unwrap_err();
        assert!(err.contains("disabled"));
        assert!(crate::state_runtime::skills::dispatch(
            "skills.load",
            with(&d, json!({"name":"beta"}))
        )
        .is_ok());
        let lib = dispatch("skills.library", d.clone()).unwrap();
        assert_eq!(lib["skills"].as_array().unwrap().len(), 2);
        dispatch(
            "skills.enable",
            with(&d, json!({"id":"alpha","enabled":true})),
        )
        .unwrap();
        assert_eq!(
            crate::state_runtime::skills::dispatch("skills.list", d).unwrap()["skills"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn duplicate_and_import() {
        let (t, d) = env();
        make(&d, "one");
        let c = dispatch("skills.duplicate", with(&d, json!({"id":"one"}))).unwrap();
        assert_eq!(c["id"], "one-copy");
        let c2 = dispatch("skills.duplicate", with(&d, json!({"id":"one"}))).unwrap();
        assert_eq!(c2["id"], "one-copy-2");
        // import from a folder with a supporting file and a symlink that must be skipped
        let src = t.path().join("src/pack");
        fs::create_dir_all(src.join("refs")).unwrap();
        fs::write(
            src.join("SKILL.md"),
            "---\nname: packed\ndescription: Packed skill\n---\nUse refs/a.md\n",
        )
        .unwrap();
        fs::write(src.join("refs/a.md"), "A").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", src.join("evil")).unwrap();
        let r = dispatch("skills.import", with(&d, json!({"path":src}))).unwrap();
        assert_eq!(r["id"], "packed");
        let base = t.path().join("store/skills/packed");
        assert!(base.join("refs/a.md").exists());
        assert!(!base.join("evil").exists());
        assert!(dispatch("skills.import", with(&d, json!({"path":src})))
            .unwrap_err()
            .contains("already exists"));
        // pasted text, with and without frontmatter
        let p = dispatch(
            "skills.import",
            with(
                &d,
                json!({"content":"---\nname: pasted\ndescription: P\n---\nHi"}),
            ),
        )
        .unwrap();
        assert_eq!(p["id"], "pasted");
        let q = dispatch(
            "skills.import",
            with(
                &d,
                json!({"content":"Just text","name":"plain","description":"Plain"}),
            ),
        )
        .unwrap();
        assert_eq!(q["id"], "plain");
        assert!(dispatch("skills.import", with(&d, json!({"content":"Just text"}))).is_err());
    }
    fn catalog_file(d: &Value, entries: Value) {
        let p = Path::new(d["resource_dir"].as_str().unwrap()).join("resources/skill-catalog.json");
        fs::write(
            p,
            serde_json::to_vec(&json!({"schema":1,"skills":entries})).unwrap(),
        )
        .unwrap();
    }
    fn entry(version: &str, body: &str) -> Value {
        json!({"id":"cat-skill","title":"Cat","description":"d","version":version,"tags":["x"],
            "sha256":sha256_hex(body.as_bytes()),"body":body})
    }
    const B1: &str = "---\nname: cat-skill\ndescription: From catalog\n---\nv1 body\n";
    const B2: &str = "---\nname: cat-skill\ndescription: From catalog\n---\nv2 body\n";
    #[test]
    fn catalog_install_verify_drift_and_update() {
        let (_t, d) = env();
        catalog_file(&d, json!([entry("1.0.0", B1)]));
        let c = dispatch("skills.catalog", d.clone()).unwrap();
        assert_eq!(c["skills"][0]["installed"], false);
        let r = dispatch(
            "skills.catalog_install",
            with(&d, json!({"id":"cat-skill"})),
        )
        .unwrap();
        assert_eq!(r["source"], "catalog");
        assert_eq!(r["modified"], false);
        // user edits it: drift flag appears
        let edited = B1.replace("v1 body", "my edit");
        let up = dispatch(
            "skills.update",
            with(&d, json!({"id":"cat-skill","content":edited})),
        )
        .unwrap();
        assert_eq!(up["modified"], true);
        // a new catalog version is available but must not clobber the edit
        catalog_file(&d, json!([entry("1.1.0", B2)]));
        let c = dispatch("skills.catalog", d.clone()).unwrap();
        assert_eq!(c["skills"][0]["update_available"], true);
        assert_eq!(c["skills"][0]["modified"], true);
        let e = dispatch(
            "skills.catalog_install",
            with(&d, json!({"id":"cat-skill"})),
        )
        .unwrap_err();
        assert!(e.contains("skill_modified"));
        let path = _t.path().join("store/skills/cat-skill/SKILL.md");
        assert!(fs::read_to_string(&path).unwrap().contains("my edit"));
        // explicit force keeps a backup of the user's version
        let r = dispatch(
            "skills.catalog_install",
            with(&d, json!({"id":"cat-skill","force":true})),
        )
        .unwrap();
        assert_eq!(r["modified"], false);
        assert_eq!(r["catalog"]["update_available"], false);
        let backups = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("SKILL.user-")
            })
            .count();
        assert_eq!(backups, 1);
    }
    #[test]
    fn catalog_rejects_bad_hash_and_foreign_conflict() {
        let (t, d) = env();
        let mut e = entry("1.0.0", B1);
        e["sha256"] = json!(sha256_hex(b"other"));
        catalog_file(&d, json!([e]));
        let err = dispatch(
            "skills.catalog_install",
            with(&d, json!({"id":"cat-skill"})),
        )
        .unwrap_err();
        assert!(err.contains("sha256"));
        assert!(!t.path().join("store/skills/cat-skill").exists());
        catalog_file(&d, json!([entry("1.0.0", B1)]));
        make(&d, "cat-skill");
        let err = dispatch(
            "skills.catalog_install",
            with(&d, json!({"id":"cat-skill","force":true})),
        )
        .unwrap_err();
        assert!(err.starts_with("conflict:"));
        assert!(
            dispatch("skills.catalog_install", with(&d, json!({"id":"nope"})))
                .unwrap_err()
                .starts_with("not_found:")
        );
    }
    #[test]
    fn catalog_file_cannot_escape_resources() {
        let (t, d) = env();
        fs::write(t.path().join("secret.md"), B1).unwrap();
        let mut e = entry("1.0.0", B1);
        e.as_object_mut().unwrap().remove("body");
        e["file"] = json!("../secret.md");
        catalog_file(&d, json!([e]));
        assert!(dispatch(
            "skills.catalog_install",
            with(&d, json!({"id":"cat-skill"}))
        )
        .unwrap_err()
        .contains("relative path"));
        let mut e = entry("1.0.0", B1);
        e.as_object_mut().unwrap().remove("body");
        e["file"] = json!("skills/cat-skill/SKILL.md");
        fs::create_dir_all(t.path().join("res/resources/skills/cat-skill")).unwrap();
        fs::write(t.path().join("res/resources/skills/cat-skill/SKILL.md"), B1).unwrap();
        catalog_file(&d, json!([e]));
        assert!(dispatch(
            "skills.catalog_install",
            with(&d, json!({"id":"cat-skill"}))
        )
        .is_ok());
    }
    #[test]
    fn bundled_catalog_is_valid() {
        let d = json!({"store_dir": tempfile::tempdir().unwrap().path()});
        let (entries, res) = catalog_entries(&d).unwrap();
        for e in entries {
            let body = catalog_body(&e, &res).unwrap();
            assert_eq!(
                sha256_hex(body.as_bytes()),
                e["sha256"].as_str().unwrap(),
                "{}",
                e["id"]
            );
            validate_content(&body, e["id"].as_str()).unwrap();
        }
    }
    #[test]
    fn version_order() {
        assert!(version_newer("1.10.0", "1.9.9"));
        assert!(!version_newer("1.0", "1.0.0"));
        assert!(!version_newer("", ""));
    }

    #[test]
    fn reserved_ids_are_refused() {
        let (_t, d) = env();
        for id in ["library", "catalog", "import"] {
            let r = dispatch(
                "skills.create",
                with(&d, json!({"name":id,"description":"d","body":"b"})),
            );
            assert!(r.is_err(), "{id}");
            let c = format!("---\nname: {id}\ndescription: d\n---\nb");
            assert!(
                dispatch("skills.import", with(&d, json!({"content":c}))).is_err(),
                "{id}"
            );
        }
        assert!(!valid_id("library") && valid_id("library-2"));
    }
    #[cfg(unix)]
    #[test]
    fn catalog_update_never_writes_through_a_symlink() {
        let (t, d) = env();
        catalog_file(&d, json!([entry("1.0.0", B1)]));
        let outside = t.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("SKILL.md"), "keep").unwrap();
        fs::create_dir_all(t.path().join("store/skills")).unwrap();
        std::os::unix::fs::symlink(&outside, t.path().join("store/skills/cat-skill")).unwrap();
        let e = dispatch(
            "skills.catalog_install",
            with(&d, json!({"id":"cat-skill","force":true})),
        )
        .unwrap_err();
        assert!(e.starts_with("conflict:"));
        assert_eq!(
            fs::read_to_string(outside.join("SKILL.md")).unwrap(),
            "keep"
        );
    }
    #[test]
    fn backups_never_overwrite_each_other() {
        let (t, d) = env();
        catalog_file(&d, json!([entry("1.0.0", B1)]));
        dispatch(
            "skills.catalog_install",
            with(&d, json!({"id":"cat-skill"})),
        )
        .unwrap();
        let file = t.path().join("store/skills/cat-skill/SKILL.md");
        for i in 0..3 {
            fs::write(&file, B1.replace("v1 body", &format!("edit {i}"))).unwrap();
            dispatch(
                "skills.catalog_install",
                with(&d, json!({"id":"cat-skill","force":true})),
            )
            .unwrap();
        }
        let n = fs::read_dir(file.parent().unwrap())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("SKILL.user-")
            })
            .count();
        assert_eq!(n, 3);
    }
    #[test]
    fn deleting_a_user_skill_keeps_a_same_named_external_one_disabled() {
        let (t, d) = env();
        let ext = t.path().join("cwd/.agents/skills/dup");
        fs::create_dir_all(&ext).unwrap();
        fs::write(
            ext.join("SKILL.md"),
            "---\nname: dup\ndescription: ext\n---\nbody",
        )
        .unwrap();
        make(&d, "dup");
        dispatch(
            "skills.enable",
            with(&d, json!({"id":"dup","enabled":false})),
        )
        .unwrap();
        dispatch("skills.delete", with(&d, json!({"id":"dup"}))).unwrap();
        assert!(disabled(&d).contains("dup"));
    }
}
