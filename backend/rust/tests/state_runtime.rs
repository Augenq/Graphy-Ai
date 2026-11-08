use graphy_core::state_runtime::dispatch;
use serde_json::{json, Value};
use std::{fs, io::Write};
use uuid::Uuid;
fn store() -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!("graphy-state-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&p).unwrap();
    p
}
fn input(root: &std::path::Path) -> Value {
    json!({"store_dir":root,"cwd":root})
}
fn run(op: &str, base: &Value, fields: Value) -> Result<Value, String> {
    let mut data = base.clone();
    for (k, v) in fields.as_object().unwrap() {
        data[k] = v.clone()
    }
    dispatch(op, data)
}
#[test]
fn session_form_round_trip_and_redaction() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    let call = json!({"id":"call1","name":"ask_questions","arguments":{"title":"Check","questions":[{"prompt":"Two plus two?","type":"single_choice","options":["3","4"],"correct":[2]}]}});
    run("session.append",&base,json!({"event":{"type":"message","message":{"id":"m1","role":"assistant","content":"","calls":[call],"stop":"tool_use"}}})).unwrap();
    let s = run("session.question_open", &base, json!({"call":call})).unwrap();
    let block = &s["pending_question"];
    assert_eq!(
        block["questions"][0]["grading"]["correct_option_ids"],
        json!(["b"])
    );
    let public = dispatch("wire.public_question", json!({"block":block})).unwrap();
    assert!(public["questions"][0].get("grading").is_none());
    let answers = json!([{"question_id":"q1","status":"answered","selected_option_ids":["b"],"text":"","reasoning":""}]);
    let s = run(
        "session.question_draft",
        &base,
        json!({"batch_id":"call1","answers":answers,"step":1}),
    )
    .unwrap();
    assert_eq!(s["pending_question"]["answers"], answers);
    let s = run(
        "session.question_resolve",
        &base,
        json!({"batch_id":"call1","answers":answers}),
    )
    .unwrap();
    assert_eq!(
        s["resolved_questions"]["call1"]["payload"]["formal_results"][0]["correct"],
        true
    );
    let evidence = dispatch("learning.evidence", json!({"session":s})).unwrap();
    let reference = evidence
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .to_owned();
    let c = json!({"id":"assess1","name":"record_assessment","arguments":{"items":[{"evidence_ref":reference,"outcome":"independent","assistance":"none","feedback":"Correct"}]}});
    let s = run("session.lesson_call", &base, json!({"call":c})).unwrap();
    assert_eq!(s["learning"]["assessments"].as_array().unwrap().len(), 1);
    let before = s["events"].as_array().unwrap().len();
    let s = run("session.lesson_call", &base, json!({"call":c})).unwrap();
    assert_eq!(s["events"].as_array().unwrap().len(), before);
    let history = dispatch("wire.history", json!({"session":s}))
        .unwrap()
        .to_string();
    assert!(!history.contains("correct_option_ids"));
    assert!(!history.contains("formal_results"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn plan_and_tail_recovery() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    let s=run("session.lesson_call",&base,json!({"call":{"id":"plan","name":"set_learning_plan","arguments":{"goal":"Understand vectors","steps":["Coordinates","Addition"]}}})).unwrap();
    assert_eq!(s["learning"]["current_step"], "s1");
    assert_eq!(s["learning"]["phase"], "teaching");
    let p = std::path::Path::new(base["path"].as_str().unwrap());
    let mut f = fs::OpenOptions::new().append(true).open(p).unwrap();
    f.write_all(b"{incomplete").unwrap();
    drop(f);
    let s = run("session.load", &base, json!({})).unwrap();
    assert!(s["warning"].as_str().unwrap().contains("Recovered"));
    assert_eq!(s["learning"]["steps"].as_array().unwrap().len(), 2);
    assert!(fs::read_dir(p.parent().unwrap()).unwrap().any(|x| x
        .unwrap()
        .path()
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .starts_with("damaged-")));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn invalid_inputs_do_not_append() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    let path = base["path"].as_str().unwrap();
    let before = fs::read(path).unwrap();
    assert!(run(
        "session.lesson_call",
        &base,
        json!({"call":{"id":"x","name":"set_learning_phase","arguments":{"phase":"practice"}}})
    )
    .is_err());
    assert!(run("session.append",&base,json!({"event":{"type":"learning_assessment","data":{"id":"a","outcome":"independent","used_hints":false,"feedback":"yes","question":"Invented","answer":{"text":"not in transcript"},"batch_id":"missing"}}})).is_err());
    assert_eq!(fs::read(path).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn exclusive_lock_and_interrupted_call_recovery() {
    use fs2::FileExt;
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    run("session.append",&base,json!({"event":{"type":"message","message":{"id":"m1","role":"assistant","content":"","calls":[{"id":"write1","name":"write","arguments":{}}]}}})).unwrap();
    let lock_path = format!("{}.lock", base["path"].as_str().unwrap());
    let lock = fs::OpenOptions::new().write(true).open(lock_path).unwrap();
    lock.try_lock_exclusive().unwrap();
    assert!(run("session.load", &base, json!({}))
        .unwrap_err()
        .contains("another process"));
    let s = run("session.load", &base, json!({"already_locked":true})).unwrap();
    let last = s["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(last["call_id"], "write1");
    assert_eq!(last["error"], true);
    assert!(last["content"]
        .as_str()
        .unwrap()
        .contains("Outcome unknown"));
    FileExt::unlock(&lock).unwrap();
    let reopened = run("session.load", &base, json!({})).unwrap();
    assert_eq!(reopened["messages"].as_array().unwrap().len(), 2);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn skill_precedence_and_size_limit() {
    let root = store();
    let local = root.join(".graphy/skills/demo");
    let global = root.join("skills/demo");
    fs::create_dir_all(&local).unwrap();
    fs::create_dir_all(&global).unwrap();
    fs::write(
        local.join("SKILL.md"),
        "---\nname: demo\ndescription: >\n  Local lesson\n---\n# Body\nUse examples.",
    )
    .unwrap();
    fs::write(
        global.join("SKILL.md"),
        "---\nname: demo\ndescription: Global\n---\n",
    )
    .unwrap();
    // An empty resource dir isolates the precedence rules from the bundled skills.
    let d = json!({"store_dir":root,"cwd":root,"home":root,"name":"demo","resource_dir":root.join("no-resources")});
    let bundled = dispatch("skills.list", json!({"store_dir":root,"cwd":root,"home":root})).unwrap();
    assert!(bundled["skills"].as_array().unwrap().iter().any(|s| s["name"] == "graphy-document-style"));
    let list = dispatch("skills.list", d.clone()).unwrap();
    assert_eq!(list["skills"].as_array().unwrap().len(), 1);
    assert_eq!(list["skills"][0]["description"], "Local lesson");
    let row = dispatch("skills.load", d.clone()).unwrap();
    assert!(row["instructions"]
        .as_str()
        .unwrap()
        .contains("Use examples"));
    fs::write(local.join("SKILL.md"), "x".repeat(49 * 1024)).unwrap();
    let list = dispatch("skills.list", d).unwrap();
    assert_eq!(list["warnings"].as_array().unwrap().len(), 1);
    assert_eq!(list["skills"][0]["description"], "Global");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn corrections_preserve_original_evidence_and_only_latest_is_public() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    for m in [
        json!({"id":"q","role":"assistant","content":"What is 2+2?"}),
        json!({"id":"a","role":"user","content":"4"}),
    ] {
        run(
            "session.append",
            &base,
            json!({"event":{"type":"message","message":m}}),
        )
        .unwrap();
    }
    let s = run("session.load", &base, json!({})).unwrap();
    let evidence = dispatch("learning.evidence", json!({"session":s})).unwrap();
    let r = evidence
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .to_owned();
    let args = json!({"items":[{"evidence_ref":r,"outcome":"independent","assistance":"none","feedback":"Good"}]});
    let s = run(
        "session.lesson_call",
        &base,
        json!({"call":{"id":"one","name":"record_assessment","arguments":args}}),
    )
    .unwrap();
    let original = s["learning"]["assessments"][0]["id"].clone();
    let correction = json!({"items":[{"evidence_ref":r,"outcome":"gap","assistance":"none","feedback":"Revised"}]});
    assert!(run(
        "session.lesson_call",
        &base,
        json!({"call":{"id":"two","name":"record_assessment","arguments":correction}})
    )
    .is_err());
    let correction = json!({"items":[{"evidence_ref":r,"outcome":"gap","assistance":"none","feedback":"Revised","correction":true}]});
    let s = run(
        "session.lesson_call",
        &base,
        json!({"call":{"id":"two","name":"record_assessment","arguments":correction}}),
    )
    .unwrap();
    assert_eq!(s["learning"]["assessments"][1]["supersedes"], original);
    assert_eq!(s["learning"]["assessments"][1]["answer"]["text"], "4");
    let projection = dispatch("learning.projection", json!({"learning":s["learning"]})).unwrap();
    assert_eq!(projection["assessments"].as_array().unwrap().len(), 1);
    assert_eq!(projection["assessments"][0]["outcome"], "gap");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn invalid_header_and_bad_middle_record_are_rejected() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    let p = std::path::Path::new(base["path"].as_str().unwrap());
    let original = fs::read_to_string(p).unwrap();
    fs::write(p, original.replace("\"version\":2", "\"version\":1")).unwrap();
    assert!(run("session.load", &base, json!({}))
        .unwrap_err()
        .contains("Unsupported session version"));
    fs::write(
        p,
        format!("{original}{{bad json}}\n{{\"type\":\"name\",\"name\":\"valid\"}}\n"),
    )
    .unwrap();
    assert!(run("session.load", &base, json!({}))
        .unwrap_err()
        .contains("line 2"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn draft_idempotence_and_cancel_prevent_assessment() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    let questions = (1..=3)
        .map(|i| json!({"prompt":format!("Question {i}?"),"type":"free_text"}))
        .collect::<Vec<_>>();
    let call = json!({"id":"quiz","name":"ask_questions","arguments":{"title":"Test","questions":questions}});
    run("session.append",&base,json!({"event":{"type":"message","message":{"id":"owner","role":"assistant","content":"","calls":[call],"stop":"tool_use"}}})).unwrap();
    // A crash between the assistant call and question_open is repaired on load.
    let s = run("session.load", &base, json!({})).unwrap();
    assert_eq!(s["pending_question"]["batch_id"], "quiz");
    let mut answers = s["pending_question"]["answers"].clone();
    answers[0]["text"] = json!("partial");
    let draft = run(
        "session.question_draft",
        &base,
        json!({"batch_id":"quiz","answers":answers,"step":0}),
    )
    .unwrap();
    let count = draft["events"].as_array().unwrap().len();
    let same = run(
        "session.question_draft",
        &base,
        json!({"batch_id":"quiz","answers":answers,"step":0}),
    )
    .unwrap();
    assert_eq!(same["events"].as_array().unwrap().len(), count);
    let s = run(
        "session.question_resolve",
        &base,
        json!({"batch_id":"quiz","answers":answers,"cancel":true}),
    )
    .unwrap();
    assert_eq!(
        s["resolved_questions"]["quiz"]["payload"]["status"],
        "cancelled"
    );
    assert!(dispatch("learning.evidence", json!({"session":s}))
        .unwrap()
        .as_object()
        .unwrap()
        .is_empty());
    assert!(run(
        "session.question_resolve",
        &base,
        json!({"batch_id":"quiz","answers":answers,"cancel":true})
    )
    .is_err());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn legacy_typed_calls_use_actual_chat_evidence() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    let plan = json!({"id":"p","name":"set_learning_plan","arguments":{"goal":"Math","steps":[{"id":"x","title":"Arithmetic"}]}});
    let s = run("session.lesson_call", &base, json!({"call":plan})).unwrap();
    assert_eq!(s["learning"]["current_step"], "x");
    for m in [
        json!({"id":"a","role":"assistant","content":"What is 2+2?"}),
        json!({"id":"u","role":"user","content":"4"}),
    ] {
        run(
            "session.append",
            &base,
            json!({"event":{"type":"message","message":m}}),
        )
        .unwrap();
    }
    let s=run("session.lesson_call",&base,json!({"call":{"id":"legacy","name":"record_assessment","arguments":{"outcome":"independent","feedback":"Correct","answer":"fabricated"}}})).unwrap();
    assert_eq!(s["learning"]["assessments"][0]["answer"]["text"], "4");
    assert_eq!(s["learning"]["assessments"][0]["source_message_id"], "u");
    let s = run("session.load", &base, json!({})).unwrap();
    assert_eq!(s["learning"]["assessments"].as_array().unwrap().len(), 1);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn assessments_split_quoted_tasks_and_correct_only_the_matching_task() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    for m in [
        json!({"id":"question-1","role":"assistant","content":"Solve **2+2** and 3+3."}),
        json!({"id":"user-1","role":"user","content":"2+2=4 and 3+3=7"}),
    ] {
        run(
            "session.append",
            &base,
            json!({"event":{"type":"message","message":m}}),
        )
        .unwrap();
    }
    let reference = "E3362214bb8";
    let one = json!({"evidence_ref":reference,"task":"2+2","outcome":"independent","assistance":"none","feedback":"Верно"});
    let two = json!({"evidence_ref":reference,"task":"3+3","outcome":"gap","assistance":"none","feedback":"Неверно"});
    let forged = json!({"evidence_ref":reference,"task":"invented task","outcome":"gap","assistance":"none","feedback":"x"});
    assert!(run(
        "session.lesson_call",
        &base,
        json!({"call":{"id":"fake","name":"record_assessment","arguments":{"items":[forged]}}})
    )
    .unwrap_err()
    .contains("quote"));
    let duplicate = json!({"evidence_ref":reference,"task":"**２+２**?","outcome":"gap","assistance":"none","feedback":"x"});
    assert!(run("session.lesson_call",&base,json!({"call":{"id":"duplicate","name":"record_assessment","arguments":{"items":[one,duplicate]}}})).unwrap_err().contains("Duplicate"));
    let bad_assistance = json!({"evidence_ref":reference,"task":"2+2","outcome":"independent","assistance":"hints","feedback":"x"});
    assert!(run("session.lesson_call",&base,json!({"call":{"id":"help","name":"record_assessment","arguments":{"items":[bad_assistance]}}})).is_err());
    let s = run(
        "session.lesson_call",
        &base,
        json!({"call":{"id":"split","name":"record_assessment","arguments":{"items":[one,two]}}}),
    )
    .unwrap();
    assert_eq!(
        s["last_result"]["saved"],
        json!(["A2b1367f19e", "Ad04ee07050"])
    );
    assert_eq!(
        s["learning"]["assessments"][0]["task_source_message_id"],
        "question-1"
    );
    assert_eq!(
        s["learning"]["assessments"][0]["answer"]["text"],
        "2+2=4 and 3+3=7"
    );
    let correction = json!({"evidence_ref":reference,"task":"3+3","outcome":"with_hints","assistance":"hints","feedback":"Assistance came before reply","correction":true});
    let s=run("session.lesson_call",&base,json!({"call":{"id":"correct","name":"record_assessment","arguments":{"items":[correction]}}})).unwrap();
    assert_eq!(s["learning"]["assessments"][2]["supersedes"], "Ad04ee07050");
    assert_eq!(s["learning"]["assessments"][2]["used_hints"], true);
    let s = run("session.load", &base, json!({})).unwrap();
    assert_eq!(s["learning"]["assessments"].as_array().unwrap().len(), 3);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn pending_evidence_retains_chronological_chat_order() {
    use sha2::{Digest, Sha256};
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    let mut refs = Vec::new();
    for n in 0..4 {
        let id = format!("user-{n}");
        let reference =
            format!("E{:x}", Sha256::digest(format!("{id}:").as_bytes()))[..11].to_string();
        refs.push(reference);
        for m in [
            json!({"id":format!("q{n}"),"role":"assistant","content":format!("Calculate {n} + 1?")}),
            json!({"id":id,"role":"user","content":format!("{}",n+1)}),
        ] {
            run(
                "session.append",
                &base,
                json!({"event":{"type":"message","message":m}}),
            )
            .unwrap();
        }
    }
    let item = json!({"evidence_ref":refs[3],"outcome":"independent","assistance":"none","feedback":"Correct"});
    let s = run(
        "session.lesson_call",
        &base,
        json!({"call":{"id":"assess","name":"record_assessment","arguments":{"items":[item]}}}),
    )
    .unwrap();
    assert_eq!(s["last_result"]["unassessed"], json!(&refs[..3]));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn correction_without_task_targets_a_single_existing_task() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    for m in [
        json!({"id":"q","role":"assistant","content":"Solve 2+2?"}),
        json!({"id":"user-1","role":"user","content":"2+2=4"}),
    ] {
        run(
            "session.append",
            &base,
            json!({"event":{"type":"message","message":m}}),
        )
        .unwrap();
    }
    let first = json!({"evidence_ref":"E3362214bb8","task":"2+2","outcome":"independent","assistance":"none","feedback":"Верно"});
    run(
        "session.lesson_call",
        &base,
        json!({"call":{"id":"first","name":"record_assessment","arguments":{"items":[first]}}}),
    )
    .unwrap();
    let correction = json!({"evidence_ref":"E3362214bb8","outcome":"gap","assistance":"none","feedback":"Revision","correction":true});
    let s=run("session.lesson_call",&base,json!({"call":{"id":"second","name":"record_assessment","arguments":{"items":[correction]}}})).unwrap();
    assert_eq!(s["last_result"]["saved"][0], "A9b16fb8526");
    let row = &s["learning"]["assessments"][1];
    assert_eq!(row["task"], "2+2");
    assert_eq!(row["question"], "Solve 2+2?");
    assert_eq!(row["supersedes"], "A2b1367f19e");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn historical_learning_schema_rejects_wrong_types_and_allows_persisted_metadata() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    for event in [
        json!({"type":"learning_goal","data":{"goal":"   "}}),
        json!({"type":"learning_skill","data":{"name":"skill","path":"/skill","extra":1}}),
        json!({"type":"learning_plan","data":{"steps":[{"id":"s1","title":"Title","extra":1}]}}),
        json!({"type":"learning_phase","data":{"phase":"diagnosis","current_step":42}}),
    ] {
        assert!(run("session.append", &base, json!({"event":event})).is_err());
    }
    let event = json!({"type":"learning_plan","data":{"goal":"Valid goal","steps":[{"id":"s1","title":"Valid step"}],"unrecognized_legacy_metadata":true}});
    let s = run("session.append", &base, json!({"event":event})).unwrap();
    assert_eq!(s["learning"]["steps"][0]["id"], "s1");
    assert!(run("session.load", &base, json!({})).is_ok());
    fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn append_io_failures_are_distinguishable_from_validation_errors() {
    use std::os::unix::fs::PermissionsExt;
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    let p = std::path::Path::new(base["path"].as_str().unwrap());
    let err = run(
        "session.append",
        &base,
        json!({"event":{"type":"learning_phase","data":{"phase":"invalid"}}}),
    )
    .unwrap_err();
    assert!(!err.starts_with("storage_error: "));
    fs::set_permissions(p, fs::Permissions::from_mode(0o400)).unwrap();
    let err = run(
        "session.append",
        &base,
        json!({"event":{"type":"name","name":"new name"}}),
    )
    .unwrap_err();
    assert!(err.starts_with("storage_error: "));
    fs::set_permissions(p, fs::Permissions::from_mode(0o600)).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cached_append_and_replay_scaling_fixture() {
    use fs2::FileExt;
    use graphy_core::state_runtime::mutate_cached;
    use std::time::Instant;
    let root = store();
    let mut base = input(&root);
    let mut snapshot = run("session.create", &base, json!({})).unwrap();
    base["path"] = snapshot["path"].clone();
    base["already_locked"] = json!(true);
    let path = base["path"].as_str().unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!("{path}.lock"))
        .unwrap();
    lock.try_lock_exclusive().unwrap();
    let start = Instant::now();
    for i in 0..1000 {
        let mut data = base.clone();
        data["event"] = json!({"type":"message","message":{"id":format!("m{i}"),"role":"user","content":"x".repeat(1000)}});
        mutate_cached("session.append", data, &mut snapshot).unwrap();
        if [100, 500, 1000].contains(&(i + 1)) {
            let started = Instant::now();
            let loaded = run("session.load", &base, json!({})).unwrap();
            assert_eq!(loaded["messages"].as_array().unwrap().len(), i + 1);
            assert_eq!(loaded["events"].as_array().unwrap().len(), i + 2);
            eprintln!(
                "{} records: append total {:?}, load {:?}",
                i + 1,
                start.elapsed(),
                started.elapsed()
            );
        }
    }
    let before = snapshot.clone();
    let mut invalid = base.clone();
    invalid["event"] = json!({"type":"learning_transaction","version":1,"source_call":"bad","result":{},"operations":[{"type":"learning_phase","data":{"phase":"practice"}},{"type":"learning_phase","data":{"phase":"invalid"}}]});
    assert!(mutate_cached("session.append", invalid, &mut snapshot).is_err());
    assert_eq!(snapshot, before);
    FileExt::unlock(&lock).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn partially_applied_corrupt_tail_is_rolled_back() {
    let root = store();
    let mut base = input(&root);
    let snapshot = run("session.create", &base, json!({})).unwrap();
    base["path"] = snapshot["path"].clone();
    let path = base["path"].as_str().unwrap();
    let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
    let bad = json!({"type":"learning_transaction","version":1,"source_call":"bad","result":{},"operations":[{"type":"learning_phase","data":{"phase":"practice"}},{"type":"learning_phase","data":{"phase":"invalid"}}]});
    writeln!(file, "{bad}").unwrap();
    drop(file);
    let restored = run("session.load", &base, json!({})).unwrap();
    assert_eq!(restored["learning"], snapshot["learning"]);
    assert_eq!(restored["events"], snapshot["events"]);
    assert!(restored["operation_results"].get("bad").is_none());
    assert!(restored["warning"].as_str().unwrap().contains("Recovered"));
    assert!(!fs::read_to_string(path)
        .unwrap()
        .contains("learning_transaction"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn project_skills_exclude_other_discovery_folders() {
    let root = store();
    for (folder, name) in [
        (".graphy/skills/local", "local"),
        (".agents/skills/other", "other"),
        ("skills/global", "global"),
    ] {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Test\n---\n"),
        )
        .unwrap();
    }
    let result = dispatch("skills.list", json!({"store_dir":root,"cwd":root,"home":root,"project_only":true,"include_disabled":true})).unwrap();
    assert_eq!(result["skills"].as_array().unwrap().len(), 1);
    assert_eq!(result["skills"][0]["name"], "local");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn quiz_requires_answer_keys_marks_check_purpose_and_flags_late_submit() {
    let root = store();
    let mut base = input(&root);
    let s = run("session.create", &base, json!({})).unwrap();
    base["path"] = s["path"].clone();
    run("session.append", &base, json!({"event":{"type":"session_mode","mode":"quiz","quiz_kind":"check","deadline":1000.0}})).unwrap();
    let open = |base: &Value, id: &str, questions: Value| {
        let call = json!({"id":id,"name":"ask_questions","arguments":{"title":"Exam","questions":questions}});
        run("session.append",base,json!({"event":{"type":"message","message":{"id":format!("m-{id}"),"role":"assistant","content":"","calls":[call.clone()],"stop":"tool_use"}}})).unwrap();
        run("session.question_open", base, json!({"call":call}))
    };
    // no key: rejected with a message the model can act on (in its own session: the failed call stays unresolved)
    let mut other = input(&root);
    let o = run("session.create", &other, json!({})).unwrap();
    other["path"] = o["path"].clone();
    run("session.append", &other, json!({"event":{"type":"session_mode","mode":"quiz","quiz_kind":"check","deadline":1000.0}})).unwrap();
    let err = open(&other, "bad", json!([{"prompt":"2+2?","type":"single_choice","options":["3","4"]},{"prompt":"x","type":"free_text"},{"prompt":"y","type":"free_text"}])).unwrap_err();
    assert!(err.contains("no answer key"), "{err}");
    let keyed = json!([
        {"prompt":"2+2?","type":"single_choice","options":["3","4"],"correct":[2],"explanation":"2+2=4"},
        {"prompt":"Solve x+1=3","type":"free_text","rubric":"x=2","reference_answer":"2"},
        {"prompt":"3*3?","type":"free_text","rubric":"9"}]);
    let s = open(&base, "good", keyed).unwrap();
    let block = &s["pending_question"];
    assert_eq!(block["purpose"], "check");
    assert_eq!(block["questions"][0]["grading"]["explanation"], "2+2=4");
    assert_eq!(block["questions"][1]["grading"]["rubric"], "Reference answer: 2\nCriteria: x=2");
    let public = dispatch("wire.public_question", json!({"block":block})).unwrap();
    assert!(public["questions"].as_array().unwrap().iter().all(|q| q.get("grading").is_none()));
    let answers = json!([
        {"question_id":"q1","status":"answered","selected_option_ids":["b"],"text":"","reasoning":""},
        {"question_id":"q2","status":"answered","selected_option_ids":[],"text":"2","reasoning":""},
        {"question_id":"q3","status":"skipped","selected_option_ids":[],"text":"","reasoning":""}]);
    let late = run("session.question_resolve", &base, json!({"batch_id":"good","answers":answers,"late":true})).unwrap();
    assert!(graphy_core::state_runtime::forms::is_late(&late, 2000.0) && !graphy_core::state_runtime::forms::is_late(&late, 500.0));
    let payload = &late["resolved_questions"]["good"]["payload"];
    assert_eq!(payload["late"], true);
    assert!(payload["note"].as_str().unwrap().contains("LATE"));
    fs::remove_dir_all(root).unwrap();
}
