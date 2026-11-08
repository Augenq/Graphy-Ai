"""Validated human-answered tool calls. No UI or network dependencies."""

import copy
import json

from jsonschema import Draft202012Validator, ValidationError

from .native import invoke

MAX_QUESTIONS = 8
MAX_BLOCK_BYTES = 100_000
TEXT = {"type": "string", "minLength": 1, "maxLength": 8000, "pattern": r"\S"}
ID = {"type": "string", "minLength": 1, "maxLength": 100, "pattern": r"^[\w-]+$"}


def obj(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


QUESTION_SCHEMA = obj(
    {
        "id": ID,
        "type": {"type": "string", "enum": ["free_text", "single_choice", "multiple_choice"]},
        "prompt": TEXT,
        "topic_id": ID,
        "options": {
            "type": "array", "minItems": 2, "maxItems": 8,
            "items": obj({"id": ID, "label": TEXT}, ["id", "label"]),
        },
        "allow_custom_answer": {"type": "boolean"},
        "grading": obj(
            {
                "correct_option_ids": {"type": "array", "minItems": 1, "uniqueItems": True, "items": ID},
                "explanation": TEXT,
                "rubric": TEXT,
            }, [],
        ),
    }, ["id", "type", "prompt"],
)
ASK_SCHEMA = obj(
    {
        "title": TEXT | {"maxLength": 200},
        "purpose": {"type": "string", "enum": ["diagnosis", "check", "practice", "clarification"]},
        "questions": {"type": "array", "minItems": 1, "maxItems": MAX_QUESTIONS, "items": QUESTION_SCHEMA},
    }, ["title", "purpose", "questions"],
)
ANSWER_SCHEMA = obj(
    {
        "question_id": ID,
        "status": {"type": "string", "enum": ["answered", "skipped", "dont_know", "draft"]},
        "selected_option_ids": {"type": "array", "uniqueItems": True, "items": ID, "maxItems": 8},
        "text": {"type": "string", "maxLength": 16000},
        "reasoning": {"type": "string", "maxLength": 16000},
    }, ["question_id", "status", "selected_option_ids", "text", "reasoning"],
)


def validate_schema(schema, value):
    try:
        Draft202012Validator(schema).validate(value)
    except ValidationError as exc:
        raise ValueError(f"{'.'.join(map(str, exc.absolute_path)) or 'input'}: {exc.message}") from None


def normalize_questions(arguments):
    """Simple form the model writes -> internal block. Idempotent: an internal block comes back unchanged.

    Model form: {title, questions: [{prompt, type, options?: [text], correct?: [1-based integer]}]}.
    Integers and normalized numeric strings are positions. Saved internal grading IDs stay unchanged.
    IDs, option ids, grading and defaults are filled here so the model never has to invent them."""
    from .contracts import PUBLIC

    # Preserve Python's legacy object display at the language boundary.
    def display_values(question):
        if not isinstance(question, dict):
            return question
        question = question.copy()
        if isinstance(question.get("options"), list):
            question["options"] = [o if isinstance(o, dict) else str(o) for o in question["options"]]
        correct = question.get("correct")
        if isinstance(correct, list):
            question["correct"] = [str(v) if isinstance(v, (list, dict)) else v for v in correct]
        elif isinstance(correct, dict):
            question["correct"] = str(correct)
        return question

    if isinstance(arguments, dict) and isinstance(arguments.get("questions"), list):
        arguments = arguments | {"questions": [display_values(q) for q in arguments["questions"]]}
    return invoke("context.normalize_questions", {"arguments": arguments, "schema": PUBLIC["ask_questions"]})


def validate_questions(arguments, topic_ids=None):
    validate_schema(ASK_SCHEMA, arguments)
    if len(json.dumps(arguments, ensure_ascii=False).encode()) > MAX_BLOCK_BYTES:
        raise ValueError("Question block is too large")
    seen = set()
    for q in arguments["questions"]:
        if q["id"] in seen:
            raise ValueError("Question IDs must be unique")
        seen.add(q["id"])
        # Before a plan exists, topic IDs are diagnostic labels, not plan references.
        if topic_ids and q.get("topic_id") and q["topic_id"] not in topic_ids:
            raise ValueError("Unknown topic_id; use an existing plan step or omit topic_id for an unlinked question")
        options = q.get("options", [])
        ids = [option["id"] for option in options]
        if len({option["label"].strip().casefold() for option in options}) != len(options):
            raise ValueError("Option texts must be distinct")
        if len(set(ids)) != len(ids):
            raise ValueError("Option IDs must be unique")
        if q["type"] == "free_text" and options:
            raise ValueError("free_text cannot have options")
        if q["type"] != "free_text" and not options:
            raise ValueError("Choice questions require options")
        correct = q.get("grading", {}).get("correct_option_ids", [])
        if q["type"] == "free_text" and correct:
            raise ValueError(f"Question {q['id']}: free_text has no options. Remove grading.correct_option_ids; "
                             "use grading.rubric for an open answer, or omit grading for self-reports")
        if not set(correct) <= set(ids):
            raise ValueError(f"Question {q['id']}: grading references unknown options. "
                             f"correct_option_ids must use IDs from options: {ids}")
        if q["type"] == "single_choice" and correct and len(correct) != 1:
            raise ValueError("single_choice requires exactly one correct option")
    return copy.deepcopy(arguments)


def blank_answer(question):
    return {"question_id": question["id"], "status": "draft", "selected_option_ids": [],
            "text": "", "reasoning": ""}


def validate_answers(block, answers, *, final=False):
    if not isinstance(answers, list) or len(answers) != len(block["questions"]):
        raise ValueError("Provide one answer per question")
    normalized = []
    for answer in answers:
        if isinstance(answer, dict):
            answer = {k: v for k, v in answer.items() if k != "confidence"}
        validate_schema(ANSWER_SCHEMA, answer)
        normalized.append(answer)
    result = invoke("questions.validate_answers", {"block": block, "answers": normalized, "final": final})
    if len(json.dumps(result, ensure_ascii=False).encode()) > 300_000:
        raise ValueError("Answers are too large")
    return result


def formal_results(block, answers):
    """Only grade selections with an explicit key. Reasoning remains evidence for the teacher."""
    return invoke("questions.formal_results", {"block": block, "answers": answers})


def public_block(block):
    return invoke("questions.public_block", {"block": block})



DONT_KNOW = "(the learner chose \"I don't know\": a declared gap, not a wrong answer)"


def learner_answers(block, answers, results):
    """What the learner submitted, in words: the model must not have to decode ids to know whose answers these are."""
    return invoke("questions.learner_answers", {"block": block, "answers": answers, "results": results})


SUBMITTED_NOTE = ("These are the LEARNER's own answers to your test (not system-generated). Assess every question "
                  "against the key you committed in the call; read the reasoning too.")


def question_summary(call, result=None):
    """One quiet line for the transcript. The test itself is on screen while it is answered, and the model
    reports the outcome; repeating every question, option and answer in grey only buries the chat."""
    block = call.get("arguments", {})
    block = block if isinstance(block, dict) else {}
    questions = block.get("questions", [])
    total = len(questions) if isinstance(questions, list) else 0
    title = f"Тест «{block.get('title', 'Вопросы')}»"
    if not result:
        return f"{title} · ожидает ответов"
    if result.get("error"):  # a refused form is the model's problem to fix; the reason is for it, not for the learner
        return f"{title} · форма не принята, модель исправляет её"
    try:
        payload = json.loads(result.get("content", "{}"))
    except (ValueError, TypeError):
        return f"{title} · ответ получен"
    if not isinstance(payload, dict):
        return f"{title} · ответ получен"
    if payload.get("status") == "cancelled":
        return f"{title} · отменён"
    answers = payload.get("answers", [])
    answers = answers if isinstance(answers, list) else []
    skipped = sum(1 for a in answers if isinstance(a, dict) and a.get("status") == "skipped")
    unknown = sum(1 for a in answers if isinstance(a, dict) and a.get("status") == "dont_know")
    return (f"{title} · ответы отправлены ({total - skipped - unknown} из {total})"
            + (f", пропущено {skipped}" if skipped else "") + (f", «не знаю» {unknown}" if unknown else ""))
