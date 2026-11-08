//! Files under `<store_dir>/learning/memory/`: `observations.jsonl` (append-only event log),
//! `settings.json`, `strategy.json` (current) and `strategy-vN.json` (every version, kept for rollback).
use super::notes;
use super::observe::{self, form_label, Obs, FORMS};
use super::rules;
use crate::state_runtime::journal::{mkdir, private_open, text};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

static LOCK: Mutex<()> = Mutex::new(());

pub struct Store {
    root: PathBuf,
}

/// One observation after folding its events.
pub struct Row {
    pub add: Value,
    pub text: String,
    pub tag: String,
    /// active | edited | deleted | superseded
    pub status: String,
    /// the learner changed the text itself (a tag-only edit keeps counting)
    pub text_edited: bool,
}
impl Row {
    fn form(&self) -> &str {
        if FORMS.contains(&self.tag.as_str()) { &self.tag } else { text(&self.add, "form") }
    }
    /// Untouched observations and tag-only corrections feed the profile; free-text edits do not.
    fn counts(&self) -> bool {
        self.status == "active" || (self.status == "edited" && !self.text_edited)
    }
    fn obs(&self) -> Obs {
        let a = &self.add;
        Obs {
            id: text(a, "id").to_owned(),
            time: a["time"].as_f64().unwrap_or(0.0),
            form: self.form().to_owned(),
            style: text(a, "style").to_owned(),
            outcome: text(a, "outcome").to_owned(),
            assessment: String::new(),
            supersedes: String::new(),
            session: String::new(),
            course: String::new(),
            message: String::new(),
            topic: text(a, "topic").to_owned(),
            hint_level: text(a, "hint_level").to_owned(),
            prev_outcome: text(a, "prev_outcome").to_owned(),
            mode: text(&a["context"], "mode").to_owned(),
            error_type: text(&a["context"], "error_type").to_owned(),
        }
    }
}

fn default_strategy() -> Value {
    json!({"version":0,"profile":{"preferred_style":null,"preferred_form":null,"hint_start":null,"step_size":null,"evidence":{}},"reason":"","created":0,"kind":"initial"})
}

impl Store {
    pub fn new(root: &str) -> Self {
        Self { root: Path::new(root).join("learning").join("memory"),
        }
    }
    fn file(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn write(&self, name: &str, value: &Value) -> Result<(), String> {
        mkdir(&self.root)?;
        let tmp = self.file(&format!("{name}.tmp"));
        let mut f = private_open().write(true).create(true).truncate(true).open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(serde_json::to_string_pretty(value).map_err(|e| e.to_string())?.as_bytes(),
        ).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.file(name)).map_err(|e| e.to_string())
    }
    fn read(&self, name: &str) -> Option<Value> {
        serde_json::from_slice(&fs::read(self.file(name)).ok()?).ok()
    }
    fn append(&self, events: &[Value]) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        mkdir(&self.root)?;
        let mut f = private_open().append(true).create(true).open(self.file("observations.jsonl")).map_err(|e| e.to_string())?;
        let mut data = String::new();
        for e in events {
            data.push_str(&e.to_string());
            data.push('\n');
        }
        f.write_all(data.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn settings(&self) -> bool {
        let v = self.read("settings.json").unwrap_or_else(|| json!({}));
        v["adaptive"] != false
    }
    pub fn current(&self) -> Value {
        self.read("strategy.json").unwrap_or_else(default_strategy)
    }
    pub fn rows(&self) -> Vec<Row> {
        let data = fs::read_to_string(self.file("observations.jsonl")).unwrap_or_default();
        let mut rows: Vec<Row> = Vec::new();
        for line in data.lines() {
            let Ok(e) = serde_json::from_str::<Value>(line) else { continue;
            };
            let id = text(&e, "id");
            if text(&e, "op") == "add" {
                if !rows.iter().any(|r| text(&r.add, "id") == id) {
                    rows.push(Row { text: text(&e, "text").to_owned(), add: e, tag: String::new(), status: "active".into(), text_edited: false,
                    });
                }
                continue;
            }
            let Some(r) = rows.iter_mut().find(|r| text(&r.add, "id") == id) else { continue;
            };
            match text(&e, "op") {
                "edit" => {
                    if let Some(t) = e["text"].as_str() {
                        if t != r.text {
                            r.text_edited = true;
                        }
                        r.text = t.to_owned();
                    }
                    if let Some(t) = e["tag"].as_str() {
                        r.tag = t.to_owned();
                    }
                    if r.status == "active" {
                        r.status = "edited".into();
                    }
                }
                "delete" => r.status = "deleted".into(),
                "supersede" => r.status = "superseded".into(),
                _ => (),
            }
        }
        rows
    }

    fn commit(&self, profile: Value, reason: String, kind: &str, now: f64,
    ) -> Result<Value, String> {
        let version = self.current()["version"].as_u64().unwrap_or(0) + 1;
        let snap = json!({"version":version,"profile":profile,"reason":reason,"created":now,"kind":kind});
        self.write(&format!("strategy-v{version}.json"), &snap)?;
        self.write("strategy.json", &snap)?;
        Ok(snap)
    }

    /// Re-derive the profile; a change becomes a new version. When adaptation is off, nothing moves.
    fn refresh(&self, rows: &[Row], now: f64) -> Result<Option<Value>, String> {
        let adaptive = self.settings();
        if !adaptive {
            return Ok(None);
        }
        let all: Vec<Obs> = rows.iter().filter(|r| r.counts()).map(Row::obs).collect();
        let refs: Vec<&Obs> = all.iter().collect();
        let cur = self.current();
        let profile = rules::derive(&refs, &cur["profile"], now);
        if rules::same(&profile, &cur["profile"]) {
            return Ok(None);
        }
        let mut why = rules::reason(&cur["profile"], &profile);
        if why.is_empty() {
            why = "Стратегия пересчитана".into();
        }
        self.commit(profile, why, "auto", now).map(Some)
    }

    fn add_new(&self, found: Vec<Obs>, rows: &[Row]) -> Result<usize, String> {
        let mut events = Vec::new();
        for o in &found {
            if rows.iter().any(|r| text(&r.add, "id") == o.id) {
                continue;
            }
            if !o.supersedes.is_empty() {
                let old = format!("obs-{}", o.supersedes);
                if rows.iter().any(|r| text(&r.add, "id") == old && r.status != "superseded") {
                    events.push(json!({"op":"supersede","id":old}));
                }
            }
            events.push(observe::to_event(o, &o.topic));
        }
        let added = events.iter().filter(|e| e["op"] == "add").count();
        self.append(&events)?;
        Ok(added)
    }

    pub fn observe_session(&self, session: &Value, now: f64) -> Result<Value, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if !self.settings() {
            return Ok(json!({"added":0}));
        }
        let events = session["events"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let id = Path::new(text(session, "path")).file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let found = observe::replay(events, id, text(session, "course_id")).obs;
        let rows = self.rows();
        let added = self.add_new(found, &rows)?;
        if added > 0 {
            self.refresh(&self.rows(), now)?;
        }
        Ok(json!({"added":added}))
    }

    pub fn rescan(&self, now: f64) -> Result<Value, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if !self.settings() {
            return Ok(json!({"added":0,"sessions":0}));
        }
        let courses = self.root.parent().map(|p| p.join("courses")).unwrap_or_default();
        let mut files = Vec::new();
        for c in fs::read_dir(&courses).into_iter().flatten().flatten() {
            for f in fs::read_dir(c.path().join("sessions")).into_iter().flatten().flatten() {
                if f.path().extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    files.push((c.file_name().to_string_lossy().into_owned(), f.path()));
                }
            }
        }
        files.sort();
        let mut added = 0;
        for (course, path) in &files {
            let data = fs::read_to_string(path).unwrap_or_default();
            let events: Vec<Value> = data.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let found = observe::replay(&events, stem, course).obs;
            added += self.add_new(found, &self.rows())?;
        }
        if added > 0 {
            self.refresh(&self.rows(), now)?;
        }
        Ok(json!({"added":added,"sessions":files.len()}))
    }

    pub fn notes(&self, _now: f64) -> Option<String> {
        if !self.settings() {
            return None;
        }
        notes::block(&rules::choose(&self.current()["profile"], &json!({})))
    }

    fn live(&self, rows: &[Row], id: &str) -> Result<(), String> {
        match rows.iter().find(|r| text(&r.add, "id") == id) {
            Some(r) if r.status != "deleted" && r.status != "superseded" => Ok(()),
            _ => Err("Observation not found".into()),
        }
    }

    pub fn edit(&self, id: &str, new_text: Option<&Value>, tag: Option<&Value>, now: f64,
    ) -> Result<Value, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.live(&self.rows(), id)?;
        let mut e = json!({"op":"edit","id":id,"time":now});
        if let Some(t) = new_text {
            let t = t.as_str().ok_or("text must be a string")?.trim();
            if t.is_empty() || t.chars().count() > 300 {
                return Err("Observation text must be 1-300 characters".into());
            }
            e["text"] = json!(t);
        }
        if let Some(t) = tag {
            let t = t.as_str().ok_or("tag must be a string")?;
            if !t.is_empty() && !FORMS.contains(&t) {
                return Err("Unknown tag".into());
            }
            e["tag"] = json!(t);
        }
        self.append(&[e])?;
        let version = self.refresh(&self.rows(), now)?;
        Ok(json!({"ok":true,"version":version}))
    }

    pub fn delete(&self, id: &str, now: f64) -> Result<Value, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.live(&self.rows(), id)?;
        self.append(&[json!({"op":"delete","id":id,"time":now})])?;
        let version = self.refresh(&self.rows(), now)?;
        Ok(json!({"deleted":true,"version":version}))
    }

    pub fn rollback(&self, version: u64, now: f64) -> Result<Value, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let snap = self.read(&format!("strategy-v{version}.json")).ok_or("Unknown strategy version")?;
        let snap = self.commit(snap["profile"].clone(), format!("Откат к версии {version}"), "rollback", now,
        )?;
        Ok(snap)
    }

    pub fn set_settings(&self, d: &Value, _now: f64) -> Result<Value, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut adaptive = self.settings();
        if let Some(b) = d.get("adaptive") {
            adaptive = b.as_bool().ok_or("adaptive must be a boolean")?;
        }
        self.write("settings.json", &json!({"adaptive":adaptive}))?;
        Ok(json!({"adaptive":adaptive}))
    }

    pub fn overview(&self, _now: f64) -> Result<Value, String> {
        let adaptive = self.settings();
        let mut versions: Vec<Value> = fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|f| {
                let n = f.file_name().to_string_lossy().into_owned();
                n.starts_with("strategy-v") && n.ends_with(".json")
            })
            .filter_map(|f| serde_json::from_slice::<Value>(&fs::read(f.path()).ok()?).ok())
            .collect();
        versions.sort_by_key(|v| std::cmp::Reverse(v["version"].as_u64().unwrap_or(0)));
        let observations: Vec<Value> = self
            .rows()
            .iter()
            .filter(|r| r.status != "deleted" && r.status != "superseded")
            .map(|r| {
                json!({"id":r.add["id"],"text":r.text,"tag":r.tag,"status":r.status,"form":r.form(),"form_label":form_label(r.form()),
                "topic":r.add["topic"],"outcome":r.add["outcome"],"style":r.add["style"],"time":r.add["time"],
                "included":r.counts(),"source":r.add["source"],"context":r.add["context"]})
            })
            .collect();
        Ok(json!({"settings":{"adaptive":adaptive},"strategy":self.current(),"versions":versions,"observations":observations,
            "rules":{"min_samples":rules::MIN_N,"half_life_days":rules::HALF_LIFE_DAYS}}),
        )
    }
}
