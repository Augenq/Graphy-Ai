"""Integration coverage for the mandatory native context and contract core."""

import json
from types import SimpleNamespace

import pytest
from reference_graphy.context import (
    asked_in,
    chat_exchange,
    checks_declined,
    estimate,
    is_acknowledgement,
    pending_check,
    plan_due,
    split_history,
)
from reference_graphy.contracts import heal_member, normalize_optional
from reference_graphy.evidence import candidate_attempt

from graphy.native import invoke


@pytest.mark.parametrize("verb", ["Найдите", "Вычислите", "Решите", "Посчитайте", "Упростите", "Докажите", "Определите"])
def test_inflected_task_verbs_survive_fenced_examples(verb):
    task = f"{verb} значение выражения."
    assert asked_in(f"Теория.\n{task}\n```python\nprint('?')\n```") == task
    assert asked_in(f"не{verb.lower()} значение") == ""


def test_code_points_and_unicode_line_breaks_survive_native_boundary():
    task = "Найди " + "🧮я" * 200
    assert asked_in("Пример\u2028" + task) == task[:300]
    session = SimpleNamespace(messages=[
        {"role": "assistant", "content": "Старый контекст\n" + "🧮я" * 200},
        {"role": "user", "id": "ответ", "content": "ё🧮" * 2500},
    ], learning=True)
    question, answer, identifier, replied, tail = chat_exchange(session)
    assert question == "" and replied and identifier == "ответ"
    assert answer == ("ё🧮" * 2500)[:4000]
    assert tail == ("🧮я" * 200)[-300:]
    assert pending_check(session) == ""  # long replies are not assumed to answer explanation-only text


@pytest.mark.parametrize("number", [0, -0.0, 1e-7, 1e16, 1.2345678901234567e25, 10**70])
def test_estimate_counts_python_json_spacing_and_unicode_without_replay_bytes(number):
    message = {"role": "user", "content": "Текст 🧮\n\x01", "extra": {"number": number, "flags": [True, None]},
               "native": {"signature": "s" * 10000}, "images": [{"data": "b" * 10000}]}
    visible = {key: value for key, value in message.items() if key not in ("native", "images")}
    assert estimate([message]) == len(json.dumps(visible, ensure_ascii=False)) // 4 + 1600


def test_transaction_boundaries_keep_multiple_pending_calls_and_reversed_results_together():
    messages = [
        {"role": "user", "content": "old"},
        {"role": "assistant", "calls": [{"id": "a"}, {"id": "b"}]},
        {"role": "tool", "call_id": "b", "content": "done b"},
        {"role": "assistant", "content": "still waiting"},
        {"role": "tool", "call_id": "a", "content": "done a"},
        {"role": "assistant", "content": "complete"},
        {"role": "user", "content": "new"},
    ]
    assert split_history(messages, estimate(messages[3:])) == 1
    assert split_history(messages, 1) == 6
    assert split_history(messages, estimate(messages) + 1) == 0


def test_compaction_retains_unassessed_task_and_limits_tool_payload_without_mutation():
    messages = [
        {"role": "user", "id": "old", "content": "old"},
        {"role": "assistant", "content": "old answer"},
        {"role": "tool", "name": "read", "content": "я🧮" * 1500, "call_id": "a"},
        {"role": "assistant", "content": "Найди значение 2+2"},
        {"role": "user", "id": "attempt", "content": "4"},
        {"role": "assistant", "content": "next"},
    ]
    prepared = invoke("context.compact_prepare", {"messages": messages, "keep": 1, "learning": True,
                      "unassessed": [{"source_message_id": "attempt", "candidate": True,
                                      "question": "Найди значение 2+2"}]})
    assert prepared["split"] == 3
    assert prepared["transcript"][-1]["content"] == ("я🧮" * 1500)[:2000]
    assert len(messages[2]["content"]) == 3000
    assert set(prepared["transcript"][-1]) == {"role", "name", "content"}


def test_latest_question_batch_is_retained_during_learning_compaction():
    messages = [{"role": "user", "content": "old"}, {"role": "assistant", "content": "old"},
                {"role": "assistant", "calls": [{"id": "q", "name": "ask_questions"}]},
                {"role": "tool", "call_id": "q", "content": "submitted"},
                {"role": "assistant", "content": "feedback"}, {"role": "user", "content": "new"}]
    prepared = invoke("context.compact_prepare", {"messages": messages, "keep": 1, "learning": True})
    assert prepared["split"] == 2


@pytest.mark.parametrize(("raw", "members", "expected"), [
    ("STRASSE", ["straße"], "straße"), ("Σ", ["ς"], "ς"), ("FFI", ["ﬃ"], "ﬃ"),
    ("Ꭰ", ["ꭰ"], "ꭰ"), ("S", ["s", "S"], "S"), ("s.", ["S", "ſ"], "s."),
])
def test_enum_healing_preserves_full_unicode_casefold_and_ambiguity(raw, members, expected):
    assert heal_member(raw, members) == expected


def test_recursive_normalization_keeps_required_nulls_unknown_keys_and_free_text():
    schema = {"type": "object", "required": ["required"], "properties": {
        "required": {"type": "string"}, "optional": {"type": "integer"},
        "rows": {"type": "array", "items": {"type": "object", "properties": {
            "phase": {"type": "string", "enum": ["check"]}, "count": {"type": "integer"},
            "enabled": {"type": "boolean"}, "text": {"type": "string"}}}}}}
    value = {"required": None, "optional": None, "unknown": None,
             "rows": json.dumps([{"phase": '`CHECK`', "count": "١_٢٠", "enabled": " True ", "text": '"unchanged"'}])}
    assert normalize_optional(schema, value) == {"required": None, "unknown": None,
        "rows": [{"phase": "check", "count": 120, "enabled": True, "text": '"unchanged"'}]}
    assert normalize_optional({"type": "integer"}, "1e300") == int(float("1e300"))
    for invalid in ("1e400", "2.5", "1__2", "\x1c2\x1f"):
        assert normalize_optional({"type": "integer"}, invalid) == invalid


def test_latest_practice_request_resets_decline_and_plan_waits_for_assistant():
    session = SimpleNamespace(messages=[{"role": "user", "content": "Составь план без вопросов"}],
                              learning=SimpleNamespace(steps=[]))
    tools = SimpleNamespace(session=session)
    assert checks_declined(session) and not plan_due(session, tools)
    session.messages.extend([{"role": "assistant", "content": "Какова цель?"},
                             {"role": "user", "content": "Для работы. Проверь меня"}])
    assert not checks_declined(session) and plan_due(session, tools)
    assert is_acknowledgement("Да, всё ясно")
    assert not is_acknowledgement("Да, ответ: 4")


@pytest.mark.parametrize(("text", "attempt"), [
    ("Got it, thanks", False), ("объясни ещё раз", False), ("не новая попытка", False),
    ("без вопросов", False), ("мой ответ: 4", True), ("да", True),
    ("https://example.com/?q=2+2", True),  # URL content is not an answer cue, but a task was asked
])
def test_candidate_attempts_share_agent_refusal_rules(text, attempt):
    source = {"candidate": True, "answer": {"text": text}, "question": "Найди значение 2+2"}
    assert candidate_attempt(source) is attempt
    assert candidate_attempt({"candidate": False})  # committed form answers bypass chat heuristics


def test_native_inputs_exclude_opaque_and_image_payloads(monkeypatch):
    from reference_graphy import context

    requests = []
    original = context.invoke

    def capture(operation, data):
        requests.append((operation, data))
        return original(operation, data)

    monkeypatch.setattr(context, "invoke", capture)
    messages = [{"role": "assistant", "content": "Найди значение", "native": {"signature": "s" * 1000000},
                 "images": [{"data": "x" * 1000000}]},
                {"role": "user", "id": "a", "content": "4", "images": []}]
    session = SimpleNamespace(messages=messages, learning=True)
    estimate(messages)
    split_history(messages, 1)
    chat_exchange(session)
    pending_check(session)
    checks_declined(session)
    for operation, data in requests:
        assert "native" not in data["messages"][0]
        if operation in ("context.estimate", "context.split_history"):
            assert data["messages"][0]["images"] == [None]
        else:
            assert "images" not in data["messages"][0]
        assert len(json.dumps(data)) < 300
    assert len(messages[0]["images"][0]["data"]) == 1000000


def test_question_normalization_maps_positions_preserves_internal_ids_and_does_not_mutate():
    from reference_graphy.contracts import PUBLIC

    arguments = {"questions": [{"prompt": "Выбери чётные", "options": ["2", "3", "4"], "correct": ["1", "3", "3"]},
                               {"prompt": "Объясни", "rubric": "Нужно рассуждение"}]}
    normalized = invoke("context.normalize_questions", {"arguments": arguments, "schema": PUBLIC["ask_questions"]})
    assert normalized == {"title": "Тест", "purpose": "check", "questions": [
        {"id": "q1", "prompt": "Выбери чётные", "type": "multiple_choice", "options": [
            {"id": "a", "label": "2"}, {"id": "b", "label": "3"}, {"id": "c", "label": "4"}],
            "grading": {"correct_option_ids": ["a", "c"]}},
        {"id": "q2", "prompt": "Объясни", "type": "free_text", "grading": {"rubric": "Нужно рассуждение"}}]}
    assert arguments["questions"][0]["correct"] == ["1", "3", "3"]
    assert invoke("context.normalize_questions", {"arguments": normalized, "schema": PUBLIC["ask_questions"]}) == normalized


def test_question_normalization_handles_legacy_text_keys_and_rejects_out_of_range_positions():
    from reference_graphy.contracts import PUBLIC

    arguments = {"questions": [{"prompt": "Выбери", "options": [{"id": "z", "label": " ПЕРВЫЙ "},
                                                               {"label": "второй"}], "correct": ["первый", "b"]}]}
    normalized = invoke("context.normalize_questions", {"arguments": arguments, "schema": PUBLIC["ask_questions"]})
    assert normalized["questions"][0]["grading"] == {"correct_option_ids": ["z", "b"]}
    arguments["questions"][0]["correct"] = [3]
    with pytest.raises(ValueError, match="1-based option numbers within the options range"):
        invoke("context.normalize_questions", {"arguments": arguments, "schema": PUBLIC["ask_questions"]})
    assert invoke("context.normalize_questions", {"arguments": {"questions": "[1]"},
                                                  "schema": PUBLIC["ask_questions"]}) == {"questions": "[1]"}


@pytest.mark.parametrize("correct", ["['x']", ["x"]])
def test_legacy_nested_option_labels_preserve_python_display_and_answer_keys(correct):
    from reference_graphy.questions import normalize_questions, validate_questions

    original = {"questions": [{"prompt": "Choose", "options": [["x"], ["y"]], "correct": [correct]}]}
    block = normalize_questions(original)
    validate_questions(block)
    assert [o["label"] for o in block["questions"][0]["options"]] == ["['x']", "['y']"]
    assert block["questions"][0]["grading"]["correct_option_ids"] == ["a"]
    assert original["questions"][0]["options"] == [["x"], ["y"]]
