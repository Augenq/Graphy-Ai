import pytest
from reference_graphy import agent as agent_module
from reference_graphy.session import Session


@pytest.fixture
def session(tmp_path):
    """An empty chat in tmp_path/state; the working directory is tmp_path."""
    value = Session(tmp_path / "state", tmp_path)
    yield value
    value.close()


@pytest.fixture(autouse=True)
def lenient_question_policy(monkeypatch):
    """Form tests use fixed multi-question blocks; the teaching-vs-quizzing policy has its own tests."""
    monkeypatch.setattr(agent_module, "POLICY_RETRIES", 0)
    yield
