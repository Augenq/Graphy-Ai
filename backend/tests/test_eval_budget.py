"""The live evaluation must reserve cost before sending and retain uncertain charges."""

import json

import pytest

from scripts.evaluate_luna import BudgetStop, GuardedProvider

MODEL = {"id": "test", "provider": "openrouter", "api": "chat", "output_limit": 100}


class Provider:
    def __init__(self, fail=False):
        self.calls = 0
        self.fail = fail

    async def stream(self, *args):
        self.calls += 1
        if self.fail:
            raise ConnectionError("stream lost")
        return {"usage": {"input": 20, "output": 10, "cost": .00002}}


async def emit(_event):
    pass


@pytest.mark.parametrize("fail", [False, True])
async def test_reserves_before_request_and_retains_reserve_when_request_fails(tmp_path, fail):
    provider = Provider(fail)
    ledger = {"cap_usd": .36, "calls": []}
    guarded = GuardedProvider(provider, MODEL, tmp_path, ledger, .00000025, .00000075)
    if fail:
        with pytest.raises(ConnectionError):
            await guarded.stream(MODEL, [], "system", [], "off", "s", emit)
    else:
        await guarded.stream(MODEL, [], "system", [], "off", "s", emit)
    saved = json.loads((tmp_path / "ledger.json").read_text())
    assert provider.calls == 1
    row = saved["calls"][0]
    assert row["accounted_usd"] == (row["upper_usd"] if fail else .00002)
    assert row["status"] == ("error-reserve-retained" if fail else "settled")


async def test_rejects_request_before_it_can_exceed_the_budget(tmp_path):
    provider = Provider()
    ledger = {"cap_usd": .000001, "calls": []}
    guarded = GuardedProvider(provider, MODEL, tmp_path, ledger, .00000025, .00000075)
    with pytest.raises(BudgetStop):
        await guarded.stream(MODEL, [], "system", [], "off", "s", emit)
    assert provider.calls == 0
    assert ledger["calls"] == [] and ledger["budget_stopped"]
