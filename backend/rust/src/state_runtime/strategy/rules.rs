//! The rule engine: counts and smoothed success rates, a minimum sample before anything moves,
//! exponential decay with age, hysteresis so a field does not flip-flop.
use super::observe::{form_label, style_label, Obs};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Observations a group needs before it may influence the profile.
pub const MIN_N: usize = 4;
/// Decayed weight a group needs (old evidence fades and eventually stops counting).
pub const MIN_WEIGHT: f64 = 2.0;
pub const HALF_LIFE_DAYS: f64 = 45.0;
/// A new favourite must beat the runner-up (and the current choice) by this much.
pub const MARGIN: f64 = 0.15;
pub const GOOD: f64 = 0.6;
pub const HIGH: f64 = 0.75;
pub const LOW: f64 = 0.35;

pub const FIELDS: [&str; 4] = ["preferred_style", "preferred_form", "hint_start", "step_size",
];

pub fn weight(age_days: f64) -> f64 {
    0.5f64.powf(age_days.max(0.0) / HALF_LIFE_DAYS)
}

#[derive(Default, Clone, Copy)]
struct Tally {
    n: usize,
    independent: usize,
    w: f64,
    ws: f64,
}
impl Tally {
    fn add(&mut self, o: &Obs, now: f64) {
        let w = weight((now - o.time) / 86400.0);
        self.n += 1;
        self.w += w;
        if o.outcome == "independent" {
            self.independent += 1;
            self.ws += w;
        }
    }
    fn eligible(&self) -> bool {
        self.n >= MIN_N && self.w >= MIN_WEIGHT
    }
    /// Laplace-smoothed, decayed share of attempts solved without help.
    fn rate(&self) -> f64 {
        (self.ws + 1.0) / (self.w + 2.0)
    }
}

fn tallies<'a>(obs: &[&'a Obs], now: f64, key: impl Fn(&'a Obs) -> &'a str,
) -> BTreeMap<&'a str, Tally> {
    let mut map: BTreeMap<&str, Tally> = BTreeMap::new();
    for o in obs {
        let k = key(o);
        if !k.is_empty() {
            map.entry(k).or_default().add(o, now);
        }
    }
    map
}

/// The best group by smoothed rate, but only if it is clearly good and clearly ahead.
fn pick(groups: &BTreeMap<&str, Tally>, current: Option<&str>) -> Option<String> {
    let mut ranked: Vec<(&str, Tally)> = groups.iter().filter(|(_, t)| t.eligible()).map(|(k, t)| (*k, *t)).collect();
    ranked.sort_by(|a, b| {
        b.1.rate().total_cmp(&a.1.rate()).then(b.1.n.cmp(&a.1.n)).then(a.0.cmp(b.0))
    });
    let (best, t) = *ranked.first()?;
    if t.rate() < GOOD {
        return None;
    }
    if let Some((_, second)) = ranked.get(1) {
        if t.rate() - second.rate() < MARGIN {
            // no clear winner: keep what we have if it still qualifies
            return current.filter(|c| ranked.iter().any(|(k, g)| k == c && g.rate() >= GOOD)).map(str::to_owned);
        }
    }
    if let Some(c) = current {
        if c != best {
            let cur = groups.get(c).filter(|g| g.eligible());
            if cur.is_some_and(|g| g.rate() >= GOOD && t.rate() - g.rate() < MARGIN) {
                return Some(c.to_owned());
            }
        }
    }
    Some(best.to_owned())
}

fn phrase(label: &str, t: &Tally) -> String {
    format!("{label}: {} из {} раз без подсказок", t.independent, t.n)
}

/// Derive the profile from active observations. `current` is the profile in force (hysteresis).
pub fn derive(obs: &[&Obs], current: &Value, now: f64) -> Value {
    let cur = |f: &str| current[f].as_str();
    let forms = tallies(obs, now, |o| {
        if o.form == "plain" { "" } else { o.form.as_str()
        }
    });
    let styles = tallies(obs, now, |o| o.style.as_str());
    let mut overall = Tally::default();
    for o in obs {
        overall.add(o, now);
    }
    let mut evidence = serde_json::Map::new();
    let form = pick(&forms, cur("preferred_form"));
    if let Some(f) = &form {
        evidence.insert("preferred_form".into(), json!(phrase(form_label(f), &forms[f.as_str()])),
        );
    }
    let style = pick(&styles, cur("preferred_style"));
    if let Some(s) = &style {
        evidence.insert("preferred_style".into(), json!(phrase(style_label(s), &styles[s.as_str()])),
        );
    }
    let (mut hint, mut step) = (None, None);
    if overall.eligible() {
        let r = overall.rate();
        let line = format!("Без подсказок решено {} из {} задач", overall.independent, overall.n);
        if r >= HIGH {
            hint = Some("late");
            step = Some("bigger");
        } else if r <= LOW {
            hint = Some("early");
            step = Some("smaller");
        } else {
            hint = cur("hint_start").map(|s| if s == "late" { "late" } else { "early" });
            step = cur("step_size").map(|s| if s == "bigger" { "bigger" } else { "smaller" });
        }
        if hint.is_some() {
            evidence.insert("hint_start".into(), json!(line.clone()));
            evidence.insert("step_size".into(), json!(line));
        }
    }
    json!({"preferred_style":style,"preferred_form":form,"hint_start":hint,"step_size":step,"evidence":evidence})
}

pub fn same(a: &Value, b: &Value) -> bool {
    FIELDS.iter().all(|f| a[*f] == b[*f])
}

pub fn field_label(f: &str) -> &'static str {
    match f {
        "preferred_style" => "Стиль",
        "preferred_form" => "Форма объяснения",
        "hint_start" => "Подсказки",
        _ => "Размер шага",
    }
}

/// Plain-language reason for moving from `old` to `new`.
pub fn reason(old: &Value, new: &Value) -> String {
    let mut parts = Vec::new();
    let mut cleared = Vec::new();
    for f in FIELDS {
        if old[f] == new[f] {
            continue;
        }
        match new["evidence"][f].as_str() {
            Some(e) if !new[f].is_null() => parts.push(e.to_owned()),
            _ => cleared.push(field_label(f)),
        }
    }
    if !cleared.is_empty() {
        parts.push(format!("Мало свежих данных, сброшено: {}", cleared.join(", ")));
    }
    parts.join("; ")
}

/// What to do next for a given context; the seam a contextual bandit can replace.
pub struct Choice {
    pub style: Option<String>,
    pub form: Option<String>,
    pub hint_start: Option<String>,
    pub step_size: Option<String>,
    pub reason: String,
}

/// `context` is reserved for topic kind / error type / mode; the rule engine ignores it today.
pub fn choose(profile: &Value, _context: &Value) -> Choice {
    let get = |f: &str| profile[f].as_str().map(str::to_owned);
    let reasons: Vec<String> = FIELDS.iter().filter_map(|f| profile["evidence"][*f].as_str()).map(str::to_owned).collect();
    Choice {
        style: get("preferred_style"),
        form: get("preferred_form"),
        hint_start: get("hint_start"),
        step_size: get("step_size"),
        reason: reasons.join("; "),
    }
}
