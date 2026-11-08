"""Offline contract for prompts/quiz.md: no agent loop, no model, no tools are run."""

import pathlib
import re

PROMPTS = pathlib.Path(__file__).resolve().parents[1] / "graphy" / "prompts"
QUIZ = (PROMPTS / "quiz.md").read_text(encoding="utf-8")


def test_quiz_prompt_is_english_and_names_its_mode():
    assert not re.search("[а-яё]", QUIZ, re.I)
    assert QUIZ.startswith("# MODE: QUIZ")


def test_quiz_forbids_hints_and_teaching_until_the_report():
    assert "No hints" in QUIZ and "no explanations" in QUIZ
    assert "first moment teaching is allowed again" in QUIZ
    assert "Explanations, hints and re-teaching" in QUIZ


def test_tasks_come_only_as_ask_questions_blocks_of_three_to_eight():
    assert "ask_questions" in QUIZ and "3 to 8 questions" in QUIZ


def test_graded_answers_go_through_record_assessment_as_independent_evidence():
    assert "record_assessment" in QUIZ and 'assistance "none"' in QUIZ
    assert "legitimately independent" in QUIZ


def test_timer_is_advisory():
    assert "advisory" in QUIZ and "mock exam" not in QUIZ


def test_report_covers_topics_error_types_and_a_next_lesson_per_weak_topic():
    for needle in ("Per topic", "Error patterns", "What to repeat first", "Next steps"):
        assert needle in QUIZ


def test_teaching_prompt_does_not_leak_quiz_rules():
    assert "MODE: QUIZ" not in (PROMPTS / "teacher.md").read_text(encoding="utf-8")
