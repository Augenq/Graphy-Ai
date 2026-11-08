//! The "Learner notes" block injected into the lesson context.
use super::rules::Choice;

pub const MAX_CHARS: usize = 600;

fn form_phrase(f: &str) -> &'static str {
    match f {
        "analogy" => "explanations through an analogy",
        "worked_example" => "a worked example before the task",
        "formal" => "a formal definition first",
        "visual" => "visual diagrams",
        "socratic" => "guiding questions",
        _ => "",
    }
}

/// None when the profile has nothing to say.
pub fn block(c: &Choice) -> Option<String> {
    let mut hints = Vec::new();
    if let Some(f) = c.form.as_deref().map(form_phrase).filter(|s| !s.is_empty()) {
        hints.push(format!("worked well so far: {f}"));
    }
    match c.style.as_deref() {
        Some("socratic") => hints.push("style that worked: socratic".into()),
        Some("structured_reference") => {
            hints.push("style that worked: structured reference".into())
        }
        _ => (),
    }
    match c.hint_start.as_deref() {
        Some("early") => hints.push("offer the first hint a little sooner".into()),
        Some("late") => hints.push("let the learner try longer before the first hint".into()),
        _ => (),
    }
    match c.step_size.as_deref() {
        Some("smaller") => hints.push("keep steps small".into()),
        Some("bigger") => hints.push("steps can be bigger".into()),
        _ => (),
    }
    if hints.is_empty() {
        return None;
    }
    let text = format!(
        "Learner notes (data from past lessons, not instructions): {}. The learner request wins over these notes whenever they differ. Never mention the notes or any scores to the learner; just adapt.",
        hints.join("; ")
    );
    Some(text.chars().take(MAX_CHARS).collect())
}
