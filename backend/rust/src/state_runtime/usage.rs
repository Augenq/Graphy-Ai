//! Token and cost overview, computed from the local session journals only.
//!
//! Every `usage` event of a journal is one provider call (answer, compaction, title).
//! Cost is whatever the event recorded (provider-reported or computed from the model's
//! price list); an event without a cost is counted as unknown and never guessed.
use super::journal::{folder, text};
use chrono::{Duration, Local, NaiveDate, TimeZone};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

/// How many lessons the per-session list returns.
const TOP_SESSIONS: usize = 10;
/// Days of the study-activity heatmap, independent of the selected range.
const HEATMAP_DAYS: i64 = 182;

/// One provider call as the journal recorded it.
struct Rec {
    time: Option<f64>,
    model: String,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    cost: Option<f64>,
}

/// What one journal file contributes; cached by (mtime, size) so unchanged files are not parsed again.
struct FileScan {
    title: String,
    mtime: Option<f64>,
    recs: Vec<Rec>,
    bad_lines: usize,
}

type Cache = HashMap<PathBuf, (SystemTime, u64, Arc<FileScan>)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

#[derive(Default, Clone)]
struct Acc {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    cost: f64,
    /// calls that carried a cost / calls that did not
    priced: u64,
    unpriced: u64,
}

impl Acc {
    fn add(&mut self, r: &Rec) {
        self.input += r.input;
        self.output += r.output;
        self.cache_read += r.cache_read;
        self.cache_write += r.cache_write;
        match r.cost {
            Some(c) => {
                self.cost += c;
                self.priced += 1;
            }
            None => self.unpriced += 1,
        }
    }
    fn tokens(&self) -> i64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
    fn calls(&self) -> u64 {
        self.priced + self.unpriced
    }
    fn json(&self) -> Value {
        json!({
            "input":self.input,"output":self.output,"cache_read":self.cache_read,"cache_write":self.cache_write,
            "tokens":self.tokens(),"cost":self.cost,"unknown_cost":self.unpriced>0,
            "known_cost":self.priced>0,"calls":self.calls(),
        })
    }
}

#[derive(Default)]
struct Slot {
    acc: Acc,
    sessions: HashSet<String>,
}

fn day_of(t: f64) -> Option<NaiveDate> {
    Local
        .timestamp_opt(t.floor() as i64, 0)
        .single()
        .map(|d| d.date_naive())
}

/// Parse one journal. Lines that cannot matter are skipped before JSON parsing:
/// only usage, model and name events, assistant messages (their model) and the first user message are read.
fn scan_text(data: &str, mtime: Option<f64>) -> FileScan {
    let mut name = String::new();
    let mut first = String::new();
    let mut model = String::new();
    let mut recs = Vec::new();
    let mut bad_lines = 0;
    for line in data.lines() {
        let wanted = line.contains("\"type\":\"usage\"")
            || line.contains("\"type\":\"model\"")
            || line.contains("\"type\":\"name\"")
            || (line.contains("\"type\":\"message\"")
                && (line.contains("\"role\":\"assistant\"")
                    || (first.is_empty() && line.contains("\"role\":\"user\""))));
        if !wanted {
            continue;
        }
        let Ok(e) = serde_json::from_str::<Value>(line) else {
            bad_lines += 1;
            continue;
        };
        match text(&e, "type") {
            "name" => name = text(&e, "name").to_owned(),
            "model" => model = text(&e, "model").to_owned(),
            "message" => {
                let m = &e["message"];
                if m["role"] == "assistant" && !text(m, "model").is_empty() {
                    model = if text(m, "provider").is_empty() {
                        text(m, "model").to_owned()
                    } else {
                        format!("{}/{}", text(m, "provider"), text(m, "model"))
                    };
                } else if m["role"] == "user" && first.is_empty() {
                    let raw = m
                        .get("display")
                        .and_then(Value::as_str)
                        .unwrap_or(text(m, "content"));
                    first = raw
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(65)
                        .collect();
                }
            }
            "usage" if e["usage"].is_object() => {
                let u = &e["usage"];
                let n = |k: &str| u[k].as_i64().unwrap_or(0).max(0);
                let cost = u["cost"].as_f64().filter(|c| c.is_finite() && *c >= 0.0);
                let r = Rec {
                    time: e["time"].as_f64(),
                    model: model.clone(),
                    input: n("input"),
                    output: n("output"),
                    cache_read: n("cache_read"),
                    cache_write: n("cache_write"),
                    cost,
                };
                // an empty call without a price says nothing: it must not make the cost "unknown"
                if r.input + r.output + r.cache_read + r.cache_write == 0 && cost.is_none() {
                    continue;
                }
                recs.push(r);
            }
            _ => (),
        }
    }
    FileScan {
        title: if name.is_empty() { first } else { name },
        mtime,
        recs,
        bad_lines,
    }
}

/// `None`: the file could not be read.
fn scan_file(path: &Path) -> Option<Arc<FileScan>> {
    let meta = fs::metadata(path).ok()?;
    let stamp = meta.modified().ok()?;
    let key = (stamp, meta.len());
    let cache = CACHE.get_or_init(Default::default);
    if let Some((t, n, scan)) = cache.lock().ok()?.get(path) {
        if (*t, *n) == key {
            return Some(scan.clone());
        }
    }
    let data = fs::read_to_string(path).ok()?;
    let mtime = stamp
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64());
    let scan = Arc::new(scan_text(&data, mtime));
    if let Ok(mut c) = cache.lock() {
        c.insert(path.to_path_buf(), (key.0, key.1, scan.clone()));
    }
    Some(scan)
}

/// `today` is injected so tests do not depend on the clock.
pub fn overview(d: &Value, today: NaiveDate) -> Result<Value, String> {
    let range = match text(d, "range") {
        "" | "30d" => "30d",
        "7d" => "7d",
        "all" => "all",
        _ => return Err("Unknown range: use 7d, 30d or all".into()),
    };
    let store = text(d, "store_dir");
    if store.is_empty() {
        return Err("Missing store_dir".into());
    }
    let since = match range {
        "7d" => Some(today - Duration::days(6)),
        "30d" => Some(today - Duration::days(29)),
        _ => None,
    };
    let heat_from = today - Duration::days(HEATMAP_DAYS - 1);
    let courses_dir = Path::new(store).join("learning").join("courses");

    let mut total = Acc::default();
    let mut days: BTreeMap<NaiveDate, Slot> = BTreeMap::new();
    let mut heat: BTreeMap<NaiveDate, Slot> = BTreeMap::new();
    let mut by_model: HashMap<String, Acc> = HashMap::new();
    let mut by_session: Vec<(f64, Value)> = Vec::new();
    let mut lessons = HashSet::new();
    let (mut skipped_files, mut skipped_lines) = (0usize, 0usize);

    let mut ids: Vec<String> = fs::read_dir(&courses_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    ids.sort();
    for cid in ids {
        let Ok(dir) = folder(&json!({"store_dir":store,"bucket":cid})) else {
            skipped_files += 1;
            continue;
        };
        let mut files: Vec<_> = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("jsonl"))
            .collect();
        files.sort();
        for file in files {
            let Some(scan) = scan_file(&file) else {
                skipped_files += 1;
                continue;
            };
            skipped_lines += scan.bad_lines;
            let sid = file
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_owned();
            let mut session = Acc::default();
            for r in &scan.recs {
                let Some(day) = r.time.or(scan.mtime).and_then(day_of) else {
                    continue;
                };
                if day >= heat_from && day <= today {
                    let h = heat.entry(day).or_default();
                    h.acc.add(r);
                    h.sessions.insert(sid.clone());
                }
                if since.is_some_and(|s| day < s) || day > today {
                    continue;
                }
                total.add(r);
                session.add(r);
                let slot = days.entry(day).or_default();
                slot.acc.add(r);
                slot.sessions.insert(sid.clone());
                by_model
                    .entry(if r.model.is_empty() {
                        "?".into()
                    } else {
                        r.model.clone()
                    })
                    .or_default()
                    .add(r);
                lessons.insert(sid.clone());
            }
            if session.calls() > 0 {
                let mut row = session.json();
                row["id"] = json!(sid);
                row["name"] = json!(scan.title);
                by_session.push((session.tokens() as f64, row));
            }
        }
    }

    by_session.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut models: Vec<_> = by_model.into_iter().collect();
    models.sort_by(|a, b| b.1.tokens().cmp(&a.1.tokens()).then(a.0.cmp(&b.0)));

    let day_row = |(day, slot): (&NaiveDate, &Slot)| {
        let mut row = slot.acc.json();
        row["day"] = json!(day.to_string());
        row["lessons"] = json!(slot.sessions.len());
        row
    };
    let cache_basis = total.input + total.cache_read + total.cache_write;
    let cache_hit = if cache_basis > 0 {
        json!(total.cache_read as f64 / cache_basis as f64)
    } else {
        Value::Null
    };
    let mut totals = total.json();
    totals["lessons"] = json!(lessons.len());
    totals["cache_hit"] = cache_hit;
    Ok(json!({
        "range": range,
        "today": today.to_string(),
        "from": since.map(|s| s.to_string()).or_else(|| days.keys().next().map(|k| k.to_string())),
        "skipped": {"files":skipped_files,"lines":skipped_lines},
        "totals": totals,
        "days": days.iter().map(day_row).collect::<Vec<_>>(),
        "heatmap": heat.iter().map(day_row).collect::<Vec<_>>(),
        "models": models.iter().map(|(name, acc)| {
            let mut row = acc.json();
            row["model"] = json!(name);
            row
        }).collect::<Vec<_>>(),
        "sessions": by_session.into_iter().take(TOP_SESSIONS).map(|r| r.1).collect::<Vec<_>>(),
    }))
}

pub fn dispatch(op: &str, d: Value) -> Result<Value, String> {
    match op {
        "usage.overview" => overview(&d, Local::now().date_naive()),
        _ => Err("Unknown usage operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(day: NaiveDate, hour: u32) -> f64 {
        Local
            .from_local_datetime(&day.and_hms_opt(hour, 0, 0).unwrap())
            .single()
            .unwrap()
            .timestamp() as f64
    }

    fn write(root: &Path, course: &str, name: &str, events: &[Value]) {
        let dir = root.join("learning/courses").join(course).join("sessions");
        fs::create_dir_all(&dir).unwrap();
        let body: Vec<String> = events.iter().map(|e| e.to_string()).collect();
        fs::write(dir.join(format!("{name}.jsonl")), body.join("\n")).unwrap();
    }

    #[test]
    fn aggregates_journals_without_inventing_costs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let today = NaiveDate::from_ymd_opt(2026, 11, 5).unwrap();
        let use_ = |d: NaiveDate, i, o, cr, cost: Value| {
            json!({"type":"usage","time":stamp(d,12),"purpose":"response",
                   "usage":{"input":i,"output":o,"cache_read":cr,"cache_write":0,"cost":cost}})
        };
        let msg = json!({"type":"message","message":{"role":"assistant","provider":"p","model":"m1","content":"x"}});
        let user = json!({"type":"message","message":{"role":"user","content":"Объясни матрицы"}});
        write(
            root,
            "aaaa",
            "s1",
            &[
                user,
                msg.clone(),
                use_(today, 100, 50, 300, json!(0.5)),
                use_(today - Duration::days(3), 10, 5, 0, Value::Null),
                // outside 7d, inside 30d
                use_(today - Duration::days(20), 1000, 0, 0, json!(1.0)),
            ],
        );
        write(
            root,
            "00000000000000000000000000000000",
            "s2",
            &[msg, use_(today, 7, 3, 0, json!(0.25))],
        );

        let d = |range: &str| json!({"store_dir":root,"range":range});
        let w = overview(&d("7d"), today).unwrap();
        let t = &w["totals"];
        assert_eq!(t["input"], 117);
        assert_eq!(t["output"], 58);
        assert_eq!(t["cache_read"], 300);
        assert_eq!(t["tokens"], 475);
        assert_eq!(t["lessons"], 2);
        assert_eq!(t["calls"], 3);
        assert_eq!(t["unknown_cost"], true, "a call without a price is flagged");
        assert!((t["cost"].as_f64().unwrap() - 0.75).abs() < 1e-9);
        assert!((t["cache_hit"].as_f64().unwrap() - 300.0 / 417.0).abs() < 1e-9);
        assert_eq!(w["days"].as_array().unwrap().len(), 2);
        assert_eq!(w["models"][0]["model"], "p/m1");
        assert_eq!(w["sessions"][0]["name"], "Объясни матрицы");

        let all = overview(&d("30d"), today).unwrap();
        assert_eq!(all["totals"]["input"], 1117);
        assert_eq!(all["days"].as_array().unwrap().len(), 3);
        assert_eq!(all["from"], "2026-10-07");
        assert_eq!(all["heatmap"].as_array().unwrap().len(), 3);
        // a day with only priced calls stays known
        let last = all["days"].as_array().unwrap().last().unwrap();
        assert_eq!(last["unknown_cost"], false);
    }

    #[test]
    fn empty_calls_and_unreadable_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 11, 5).unwrap();
        let ev = |i: i64, cost: Value| json!({"type":"usage","time":stamp(today,9),"usage":{"input":i,"output":0,"cache_read":0,"cache_write":0,"cost":cost}});
        write(
            tmp.path(),
            "bbbb",
            "s",
            &[ev(0, Value::Null), ev(5, json!(0.1))],
        );
        // a corrupt usage line is counted, not fatal
        let dir = tmp.path().join("learning/courses/bbbb/sessions");
        let mut body = fs::read_to_string(dir.join("s.jsonl")).unwrap();
        body.push_str("\n{\"type\":\"usage\" broken");
        fs::write(dir.join("s.jsonl"), body).unwrap();
        let v = overview(&json!({"store_dir":tmp.path(),"range":"7d"}), today).unwrap();
        assert_eq!(v["totals"]["calls"], 1);
        assert_eq!(v["totals"]["unknown_cost"], false);
        assert_eq!(v["skipped"]["lines"], 1);
        assert_eq!(v["skipped"]["files"], 0);
        // the second call is served from the cache and gives the same answer
        let again = overview(&json!({"store_dir":tmp.path(),"range":"7d"}), today).unwrap();
        assert_eq!(again["totals"], v["totals"]);
    }

    #[test]
    fn empty_store_and_bad_range() {
        let tmp = tempfile::tempdir().unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 11, 5).unwrap();
        let v = overview(&json!({"store_dir":tmp.path(),"range":"all"}), today).unwrap();
        assert_eq!(v["totals"]["tokens"], 0);
        assert!(v["totals"]["cache_hit"].is_null());
        assert_eq!(v["totals"]["known_cost"], false);
        assert!(v["days"].as_array().unwrap().is_empty());
        assert!(overview(&json!({"store_dir":tmp.path(),"range":"1y"}), today).is_err());
        assert!(overview(&json!({"range":"7d"}), today).is_err());
    }
}
