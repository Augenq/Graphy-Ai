"""Exercise the real library ABI and its ownership boundary."""

from concurrent.futures import ThreadPoolExecutor

import pytest

from graphy.native import invoke


def test_real_engine_and_errors():
    assert invoke("health")["engine"] == "rust"
    assert invoke("health")["abi"] == 1
    with pytest.raises(ValueError, match="Unknown core operation"):
        invoke("nonexistent")
    with pytest.raises(ValueError):
        invoke("health", float("nan"))


def test_parallel_native_calls():
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: invoke("health"), range(500)))
    assert all(row["abi"] == 1 for row in results)


@pytest.mark.parametrize("space", ["\x1c", "\x1d", "\x1e", "\x1f", "\u2003"])
def test_python_whitespace_semantics(space):
    result = invoke("agent.request_outcome", {
        "response": {"stop": "stop", "content": space}, "attempt": 0, "retries": 1,
    })
    assert result["empty"] and result["retry"]
    block = {"questions": [{"id": "q1", "type": "free_text"}]}
    answer = {"question_id": "q1", "status": "answered", "selected_option_ids": [],
              "text": space, "reasoning": ""}
    with pytest.raises(ValueError, match="An answer cannot be empty"):
        invoke("questions.validate_answers", {"block": block, "answers": [answer], "final": True})
