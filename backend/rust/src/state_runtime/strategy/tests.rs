use super::*;
use serde_json::json;

const DAY: f64 = 86400.0;
const NOW: f64 = 1_800_000_000.0;

/// A fake journal: for each attempt the tutor says `explain`, the learner answers, the tutor records an assessment.
fn journal(attempts: &[(&str, &str, f64)]) -> Vec<Value> {
    let mut ev = vec![json!({"type":"header"}), json!({"type":"learning_plan","time":NOW-400.0*DAY,"data":{"steps":[{"id":"t1","title":"Матрицы"}]}}),
    ];
    for (i, (explain, outcome, time)) in attempts.iter().enumerate() {
        let (a, u) = (format!("a{i}"), format!("u{i}"));
        ev.push(json!({"type":"message","message":{"id":a,"role":"assistant","content":explain,"calls":[]}}));
        ev.push(json!({"type":"message","message":{"id":u,"role":"user","content":"ответ"}}));
        let assistance = if *outcome == "independent" { "none" } else if *outcome == "with_hints" { "hints" } else { "none" };
        ev.push(json!({"type":"learning_transaction","version":1,"time":time,"source_call":"c","result":{},"operations":[
            {"type":"learning_assessment","data":{"id":format!("as{i}"),"source_message_id":u,"topic_id":"t1","outcome":outcome,"assistance":assistance,"feedback":"ок","used_hints":*outcome=="with_hints"}}]}));
    }
    ev
}
fn session(events: Vec<Value>) -> Value {
    json!({"path":"/x/sessions/s1.jsonl","course_id":"abc","events":events})
}
const EXAMPLE: &str = "Разберём пример: возьмём матрицу 2x2 и решим шаг 1.";
const ANALOGY: &str = "Представь, что матрица - это таблица цен.";

fn store(dir: &tempfile::TempDir) -> store::Store {
    store::Store::new(dir.path().to_str().unwrap())
}
fn four(form: &str, outcome: &str, t: f64) -> Vec<(&'static str, &'static str, f64)> {
    let f: &'static str = if form == "ex" { EXAMPLE } else { ANALOGY };
    let o: &'static str = match outcome { "i" => "independent", "h" => "with_hints", _ => "gap",
    };
    vec![(f, o, t); 4]
}

#[test]
fn captures_observations_with_refs_from_a_fake_journal() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    let ev = journal(&[(EXAMPLE, "independent", NOW), (ANALOGY, "gap", NOW), ("Что такое определитель?", "with_hints", NOW),
    ]);
    assert_eq!(s.observe_session(&session(ev.clone()), NOW).unwrap()["added"], 3);
    // idempotent
    assert_eq!(s.observe_session(&session(ev), NOW).unwrap()["added"], 0);
    let o = s.overview(NOW).unwrap();
    let rows = o["observations"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["form"], "worked_example");
    assert_eq!(rows[1]["form"], "analogy");
    assert_eq!(rows[2]["form"], "socratic");
    assert_eq!(rows[0]["text"], "Объяснение через пример: задача решена без подсказок (тема: Матрицы)");
    assert_eq!(rows[0]["source"]["session"], "s1");
    assert_eq!(rows[0]["source"]["message"], "u0");
    assert_eq!(rows[0]["source"]["assessment"], "as0");
}

#[test]
fn skipped_and_uncertain_are_not_observations_and_superseded_attempts_are_dropped() {
    let mut ev = journal(&[(EXAMPLE, "skipped", NOW), (EXAMPLE, "uncertain", NOW), (EXAMPLE, "gap", NOW),
    ]);
    ev.push(json!({"type":"learning_assessment","time":NOW,"data":{"id":"fix","supersedes":"as2","source_message_id":"u2","outcome":"independent","assistance":"none","feedback":"x","used_hints":false}}));
    let found = observe::replay(&ev, "s", "c").obs;
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].assessment, "fix");
}

#[test]
fn widget_calls_are_visual_and_classification_is_deterministic() {
    assert_eq!(observe::classify("любой текст", true), "visual");
    assert_eq!(observe::classify("Определение. Теорема 1.", false), "formal");
    assert_eq!(observe::classify("Просто факты.", false), "plain");
}

#[test]
fn rules_need_a_minimum_sample_before_moving() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    s.observe_session(&session(journal(&four("ex", "i", NOW)[..3])), NOW).unwrap();
    let o = s.overview(NOW).unwrap();
    assert_eq!(o["strategy"]["version"], 0, "3 observations must not move anything");
    s.observe_session(&session(journal(&four("ex", "i", NOW))), NOW).unwrap();
    let o = s.overview(NOW).unwrap();
    assert_eq!(o["strategy"]["version"], 1);
    assert_eq!(o["strategy"]["profile"]["preferred_form"], "worked_example");
    assert_eq!(o["strategy"]["profile"]["hint_start"], "late");
}

#[test]
fn old_evidence_decays_away() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    let old = NOW - 400.0 * DAY;
    s.observe_session(&session(journal(&four("ex", "i", old))), old + DAY).unwrap();
    assert_eq!(s.overview(NOW).unwrap()["strategy"]["profile"]["preferred_form"], "worked_example");
    // the same observations, judged much later, carry almost no weight
    let rows = s.rows();
    let obs: Vec<_> = rows.iter().map(|r| r.add["time"].as_f64().unwrap()).collect();
    assert_eq!(obs.len(), 4);
    let all: Vec<observe::Obs> = observe::replay(&journal(&four("ex", "i", old)), "s", "c").obs;
    let refs: Vec<&observe::Obs> = all.iter().collect();
    let fresh = rules::derive(&refs, &json!({}), old + DAY);
    let faded = rules::derive(&refs, &fresh, NOW);
    assert!(fresh["preferred_form"].is_string());
    assert!(faded["preferred_form"].is_null() && faded["hint_start"].is_null());
    assert!(rules::weight(0.0) > 0.99 && rules::weight(45.0) > 0.49 && rules::weight(45.0) < 0.51);
}

#[test]
fn every_change_is_a_versioned_snapshot_with_a_reason_and_rollback_restores() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    s.observe_session(&session(journal(&four("ex", "i", NOW))), NOW).unwrap();
    let v1 = s.overview(NOW).unwrap();
    assert!(v1["strategy"]["reason"].as_str().unwrap().contains("Объяснение через пример: 4 из 4 раз без подсказок"));
    assert!(dir.path().join("learning/memory/strategy-v1.json").exists());
    // a different story arrives: analogy works, example fails
    let mut more = four("an", "i", NOW + DAY);
    more.extend(four("an", "i", NOW + DAY));
    let ev = journal(&[four("ex", "i", NOW), more, four("ex", "g", NOW + 2.0 * DAY)].concat());
    s.observe_session(&session(ev), NOW + 3.0 * DAY).unwrap();
    let v2 = s.overview(NOW).unwrap();
    assert!(v2["strategy"]["version"].as_u64().unwrap() >= 2);
    assert_eq!(v2["versions"].as_array().unwrap().len() as u64, v2["strategy"]["version"].as_u64().unwrap());
    assert!(v2["versions"].as_array().unwrap().iter().all(|v| !v["reason"].as_str().unwrap().is_empty()));
    let back = s.rollback(1, NOW + 4.0 * DAY).unwrap();
    assert_eq!(back["profile"], v1["strategy"]["profile"]);
    assert_eq!(back["reason"], "Откат к версии 1");
    let after = s.overview(NOW).unwrap();
    assert_eq!(after["strategy"]["profile"]["preferred_form"], "worked_example");
    assert_eq!(after["strategy"]["version"].as_u64().unwrap(), v2["strategy"]["version"].as_u64().unwrap() + 1);
    assert!(s.rollback(99, NOW).is_err());
}

#[test]
fn adaptive_off_stops_recording_and_notes() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    s.observe_session(&session(journal(&four("ex", "i", NOW))), NOW).unwrap();
    assert!(s.notes(NOW).is_some());
    s.set_settings(&json!({"adaptive":false}), NOW).unwrap();
    assert!(s.notes(NOW).is_none());
    let before = s.rows().len();
    s.observe_session(&session(journal(&four("an", "g", NOW + DAY))), NOW).unwrap();
    assert_eq!(s.rows().len(), before, "adaptive off captures nothing");
    s.set_settings(&json!({"adaptive":true}), NOW).unwrap();
    assert!(s.notes(NOW).is_some());
}

#[test]
fn edited_and_deleted_observations_leave_the_profile() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    s.observe_session(&session(journal(&four("ex", "i", NOW))), NOW).unwrap();
    assert_eq!(s.overview(NOW).unwrap()["strategy"]["profile"]["preferred_form"], "worked_example");
    s.edit("obs-as0", Some(&json!("Это было не про пример")), Some(&json!("plain")), NOW,
    ).unwrap();
    let o = s.overview(NOW).unwrap();
    let row = o["observations"].as_array().unwrap().iter().find(|r| r["id"] == "obs-as0").unwrap().clone();
    assert_eq!(row["status"], "edited");
    assert_eq!(row["included"], false);
    assert_eq!(row["text"], "Это было не про пример");
    assert_eq!(o["strategy"]["profile"]["preferred_form"], Value::Null, "3 observations left: below the minimum");
    assert_eq!(o["strategy"]["version"], 2);
    // a deleted observation stays deleted when the journal is scanned again
    s.delete("obs-as1", NOW).unwrap();
    s.observe_session(&session(journal(&four("ex", "i", NOW))), NOW).unwrap();
    let ids: Vec<_> = s.overview(NOW).unwrap()["observations"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect();
    assert!(!ids.contains(&"obs-as1".to_string()) && ids.len() == 3);
    assert!(s.delete("obs-as1", NOW).is_err());
    assert!(s.edit("obs-as2", None, Some(&json!("bogus")), NOW).is_err());
}

#[test]
fn notes_block_is_short_carries_the_precedence_line_and_hides_scores() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    assert!(s.notes(NOW).is_none(), "nothing learned yet");
    s.observe_session(&session(journal(&four("ex", "i", NOW))), NOW).unwrap();
    let n = s.notes(NOW).unwrap();
    assert!(n.chars().count() <= 600, "{}", n.chars().count());
    assert!(n.contains("learner request wins"));
    assert!(n.contains("worked example") && n.contains("not instructions"));
    assert!(!n.contains("4 из 4") && !n.contains('%'));
    let full = notes::block(&Choice { style: Some("socratic".into()), form: Some("worked_example".into()), hint_start: Some("late".into()), step_size: Some("bigger".into()), reason: String::new(),
    }).unwrap();
    assert!(full.chars().count() <= 600 && full.contains("learner request wins"));
}

#[test]
fn rescan_reads_journals_from_disk() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = dir.path().join("learning/courses/abc/sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let lines: Vec<String> = journal(&four("ex", "i", NOW)).iter().map(|e| e.to_string()).collect();
    std::fs::write(sessions.join("s1.jsonl"), lines.join("\n")).unwrap();
    let s = store(&dir);
    assert_eq!(s.rescan(NOW).unwrap()["added"], 4);
    assert_eq!(s.rescan(NOW).unwrap()["added"], 0);
    assert_eq!(s.overview(NOW).unwrap()["observations"][0]["source"]["course_id"], "abc");
}

#[test]
fn choose_exposes_strategy_and_reason() {
    let p = json!({"preferred_form":"analogy","preferred_style":null,"hint_start":"early","step_size":null,"evidence":{"preferred_form":"Объяснение через аналогию: 4 из 5 раз без подсказок"}});
    let c = choose(&p, &json!({}));
    assert_eq!(c.form.as_deref(), Some("analogy"));
    assert!(c.reason.contains("4 из 5"));
}

#[test]
fn tag_only_edit_counts_under_the_corrected_form_but_text_edit_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    s.observe_session(&session(journal(&four("ex", "i", NOW))), NOW).unwrap();
    let text0 = s.overview(NOW).unwrap()["observations"][0]["text"].as_str().unwrap().to_owned();
    // retag all four as analogy, text unchanged: they count, under the new form
    for i in 0..4 {
        s.edit(&format!("obs-as{i}"), Some(&json!(text0)), Some(&json!("analogy")), NOW,
        ).unwrap();
    }
    let o = s.overview(NOW).unwrap();
    assert_eq!(o["strategy"]["profile"]["preferred_form"], "analogy");
    assert!(o["observations"].as_array().unwrap().iter().all(|r| r["status"] == "edited" && r["included"] == true));
    // a free-text edit removes one from the evidence
    s.edit("obs-as0", Some(&json!("другое")), None, NOW).unwrap();
    let o = s.overview(NOW).unwrap();
    assert_eq!(o["strategy"]["profile"]["preferred_form"], Value::Null);
    assert_eq!(o["observations"][0]["included"], false);
}

#[test]
fn observation_context_carries_mode_and_error_type_when_present() {
    let mut ev = journal(&[(EXAMPLE, "gap", NOW), (ANALOGY, "independent", NOW)]);
    // the first assessment states a kind of mistake and was given in a quiz; the second states nothing
    ev[4]["operations"][0]["data"]["error_type"] = json!("false_rule");
    ev[4]["operations"][0]["data"]["mode"] = json!("quiz");
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    s.observe_session(&session(ev), NOW).unwrap();
    let rows = s.overview(NOW).unwrap()["observations"].as_array().unwrap().clone();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["context"], json!({"mode":"quiz","error_type":"false_rule"}));
    assert_eq!(rows[1]["context"], json!({}));
    // the text the learner reads is unchanged by the context
    assert_eq!(rows[0]["text"], "Объяснение через пример: в решении осталась ошибка (тема: Матрицы)");
}
