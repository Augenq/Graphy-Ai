"""'I don't know', retired answer fields, committed keys and argument healing."""

import json

import pytest
from reference_graphy.contracts import PUBLIC, heal_member, normalize_optional
from reference_graphy.courses import Courses
from reference_graphy.learning_tools import LearningTools
from reference_graphy.questions import blank_answer, learner_answers, question_summary, validate_answers
from reference_graphy.session import Session
from test_learning import BLOCK, complete_answers, open_question
from test_reliability import call


@pytest.fixture
def lesson(tmp_path):
    course = Courses(tmp_path).create("Сигналы")
    session = Session(tmp_path, tmp_path, course_id=course["id"])
    yield session
    session.close()


@pytest.fixture
def lesson_tools(lesson, tmp_path):
    class NoSkills:
        def list(self):
            return []

    return lesson, LearningTools(tmp_path, lesson, skills=NoSkills())


def submitted(session, mutate):
    """Open the standard test, apply `mutate` to the answers, submit; returns evidence refs by question."""
    open_question(session)
    answers = complete_answers()
    mutate(answers)
    message = session.resolve_question("ask", answers)
    return message, {q["id"]: ref for ref, q in zip(
        (r for r in session.evidence), BLOCK["questions"], strict=True)}


def test_dont_know_is_a_filled_answer_distinct_from_skipping():
    answers = [blank_answer(q) for q in BLOCK["questions"]]
    for answer in answers:
        answer["status"] = "dont_know"
    validate_answers(BLOCK, answers, final=True)  # nothing is left as a draft
    answers[0].update(status="dont_know", text="x")
    with pytest.raises(ValueError, match="cannot also have an answer"):
        validate_answers(BLOCK, answers)


def test_retired_confidence_is_discarded_without_changing_answers(lesson):
    session = lesson
    answers = complete_answers()
    expected = complete_answers()
    answers[0]["confidence"] = 90
    answers[1]["status"], answers[1]["selected_option_ids"] = "dont_know", []
    answers[1]["reasoning"] = ""
    expected[1] = answers[1].copy()
    assert validate_answers(BLOCK, answers, final=True) == expected
    assert answers[0]["confidence"] == 90  # validation leaves the saved input intact
    open_question(session)
    message = session.resolve_question("ask", answers)
    assert "confidence" not in message["content"]
    rows = json.loads(message["content"])["learner_answers"]
    assert "don't know" in rows[1]["learner_answer"]
    projection = session.question_projection(message)["content"]
    assert "confidence" not in projection
    attempts = json.loads(projection)["attempts"]
    assert attempts[1]["status"] == "dont_know" and attempts[1]["key_verdict"] is None
    line = question_summary({"arguments": BLOCK}, {"content": message["content"]})
    assert "(2 из 3)" in line and "«не знаю» 1" in line


async def test_dont_know_must_be_recorded_as_a_gap(lesson_tools):
    session, tools = lesson_tools

    def know_nothing(answers):
        answers[0].update(status="dont_know", selected_option_ids=[], reasoning="")

    _, refs = submitted(session, know_nothing)
    item = {"evidence_ref": refs["one"], "outcome": "uncertain", "assistance": "none", "feedback": "?"}
    result = await call(tools, "record_assessment", {"items": [item]})
    assert result["error"] and "outcome=gap" in result["content"]
    ok = await call(tools, "record_assessment", {"items": [item | {"outcome": "gap"}]}, "gap")
    assert not ok.get("error")


async def test_assessment_cannot_contradict_the_committed_key(lesson_tools):
    session, tools = lesson_tools

    def first_wrong(answers):
        answers[0].update(selected_option_ids=["b"])  # key says "a"

    _, refs = submitted(session, first_wrong)
    right = {"evidence_ref": refs["many"], "outcome": "gap", "assistance": "none", "feedback": "no"}
    wrong = {"evidence_ref": refs["one"], "outcome": "independent", "assistance": "none", "feedback": "yes"}
    result = await call(tools, "record_assessment", {"items": [wrong]})
    assert result["error"] and "committed" in result["content"] and "incorrect" in result["content"]
    result = await call(tools, "record_assessment", {"items": [right]}, "r2")
    assert result["error"] and "correct" in result["content"]
    # The escape hatch for a faulty key is an honest "uncertain", never a silent flip.
    fixed = wrong | {"outcome": "uncertain", "feedback": "my key may have been wrong"}
    assert not (await call(tools, "record_assessment", {"items": [fixed]}, "r3")).get("error")
    gap = wrong | {"outcome": "gap", "feedback": "wrong"}
    assert not (await call(tools, "record_assessment", {"items": [gap | {"correction": True}]}, "r4")).get("error")


def test_old_answers_without_the_new_fields_still_validate_and_blank_answers_are_unchanged():
    assert set(blank_answer(BLOCK["questions"][0])) == {
        "question_id", "status", "selected_option_ids", "text", "reasoning"}
    validate_answers(BLOCK, complete_answers(), final=True)
    rows = learner_answers(BLOCK, complete_answers(), [{"question_id": q["id"], "correct": None} for q in BLOCK["questions"]])
    assert all("learner_confidence_percent" not in row for row in rows)


@pytest.mark.parametrize("raw,expected", [
    ('"check"', "check"), (":check", "check"), ("`check`", "check"), (" Check. ", "check"),
    ('"\\"check\\""', "check"), ("check", "check"), ("chek", "chek"), ("", ""),
])
def test_enum_values_are_recovered_from_copy_debris(raw, expected):
    assert heal_member(raw, ["check", "practice"]) == expected


def test_encoded_arguments_are_healed_before_validation_but_nonsense_stays_for_rejection():
    healed = normalize_optional(PUBLIC["record_assessment"], {"items": json.dumps([
        {"evidence_ref": "E1", "outcome": '"gap"', "assistance": "NONE", "feedback": "f", "correction": "True"}])})
    assert healed["items"][0] | {} == {"evidence_ref": "E1", "outcome": "gap", "assistance": "none",
                                      "feedback": "f", "correction": True}
    assert normalize_optional(PUBLIC["set_learning_phase"], {"phase": "`teaching`", "step": "2"}) == {
        "phase": "teaching", "step": 2}
    assert normalize_optional(PUBLIC["set_learning_phase"], {"phase": "nonsense"}) == {"phase": "nonsense"}


def test_question_markdown_and_latex_survive_json_normalization_and_public_projection():
    from reference_graphy.questions import normalize_questions, validate_questions
    from reference_graphy.wire import public_question

    prompt = "**Differentiate** $f(x) = \\frac{x^2}{2}$.\n\n$$\nf'(x) = ?\n$$"
    options = [r"$\frac{2x}{2}$", "`x**2`", "**None**"]
    arguments = json.loads(json.dumps({"title": "Derivatives", "questions": [
        {"prompt": prompt, "type": "single_choice", "options": options, "correct": [1]},
        {"prompt": "Find $x$.", "type": "free_text"},
        {"prompt": "Select **all** identities.", "type": "multiple_choice",
         "options": [r"$\sin^2 x + \cos^2 x = 1$", "$1 = 1$"], "correct": [1, 2]},
    ]}))
    normalized = normalize_questions(arguments)
    validate_questions(normalized)
    projected = public_question(normalized)
    first = projected["questions"][0]
    assert first["prompt"] == prompt
    assert [option["label"] for option in first["options"]] == options
    assert "grading" not in first
    assert normalized["questions"][0]["grading"]["correct_option_ids"] == ["a"]
