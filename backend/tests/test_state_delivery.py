"""The lesson state reaches the model inside the learner's message; a task followed by code is still the task."""

import pytest
from reference_graphy.context import asked_in, assessment_due
from reference_graphy.courses import Courses
from reference_graphy.learning_tools import LearningTools
from reference_graphy.providers import payload
from reference_graphy.session import Session

TASK_THEN_CODE = "Задача: что вернёт `f(3)`?\n\n```python\ndef f(n):\n    return 0 if n == 0 else n + f(n-1)\n```"


def test_a_task_followed_by_its_code_sample_is_still_found():
    assert asked_in(TASK_THEN_CODE) == "Задача: что вернёт `f(3)`?"
    assert asked_in("Найди ошибку в коде:\n```python\nx = 1\n```").startswith("Найди ошибку")
    assert asked_in("Вот пример.\n```python\nprint('?')\n```") == ""  # a '?' inside code is not a question
    assert asked_in("Что выведет код?\n```python\nprint(1)") == "Что выведет код?"  # an unclosed fence


def test_the_reply_to_a_task_with_code_makes_the_assessment_due(tmp_path):
    course = Courses(tmp_path).create("Python")
    session = Session(tmp_path, tmp_path, course_id=course["id"])
    tools = LearningTools(tmp_path, session)
    session.add({"role": "user", "content": "Что такое рекурсия?"})
    session.add({"role": "assistant", "content": "Рекурсия — функция вызывает себя.\n\n" + TASK_THEN_CODE})
    session.add({"role": "user", "content": "Вернёт 0: базовый случай всё отбрасывает."})
    assert assessment_due(session, tools)
    session.close()


@pytest.mark.parametrize("api", ["chat", "anthropic", "google"])
def test_state_is_folded_into_the_learner_message_and_labelled(api):
    model = {"id": "t", "provider": "test", "api": api}
    state = "Application lesson state (data):\n{\"phase\":\"practice\"}"
    messages = [{"role": "user", "content": "Объясни"}, {"role": "assistant", "content": "Вот."},
                {"role": "context", "content": state}, {"role": "user", "content": "Тогда напишу range(0, n)."}]
    _, _, body = payload(model, messages, "Tutor", [], "off", "s")
    text = str(body)
    assert text.count("Application lesson state") == 1 and "<learner_message>" in text and "Тогда напишу range(0, n)." in text
    assert "not written by the learner" in text
    if api == "chat":  # no stray system message in the middle of the conversation
        assert [m["role"] for m in body["messages"]] == ["system", "user", "assistant", "user"]
    if api == "anthropic":
        assert [m["role"] for m in body["messages"]] == ["user", "assistant", "user"]


def test_a_context_without_a_following_user_message_is_kept_and_the_journal_is_untouched():
    model = {"id": "t", "provider": "test", "api": "chat"}
    messages = [{"role": "user", "content": "Привет"}, {"role": "context", "content": "State"}]
    _, _, body = payload(model, messages, "Tutor", [], "off", "s")
    assert [m["role"] for m in body["messages"]] == ["system", "user", "system"]
    assert messages[0]["content"] == "Привет"
