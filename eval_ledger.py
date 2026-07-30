"""
eval_ledger.py - offline test for the processed ledger (no network, temp file only).
    python eval_ledger.py   /   pytest eval_ledger.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from core.ledger import Ledger


def _fresh() -> Ledger:
    return Ledger(Path(tempfile.mkdtemp()) / "ledger.json")


FIRMS = [{"company_key": "Alpha Ltd", "Company Name": "Alpha Ltd"},
         {"company_key": "Beta Ltd", "Company Name": "Beta Ltd"},
         {"company_key": "Gamma Ltd", "Company Name": "Gamma Ltd"}]


def check_records_and_skips():
    led = _fresh()
    led.record({"company_key": "Alpha Ltd", "company": "Alpha Ltd",
                "status": "email_found", "found_email": "a@alpha.co.uk"})
    pending, skipped = led.filter_pending(FIRMS)
    assert skipped == 1 and len(pending) == 2, (skipped, pending)
    assert pending[0]["company_key"] == "Beta Ltd"


def check_every_terminal_status_sticks():
    led = _fresh()
    for i, st in enumerate(["email_found", "email_not_found", "no_website", "hold_security_gateway"]):
        led.record({"company_key": f"C{i}", "company": f"C{i}", "status": st})
    firms = [{"company_key": f"C{i}"} for i in range(4)]
    pending, skipped = led.filter_pending(firms)
    assert skipped == 4 and pending == [], (skipped, pending)   # none get re-charged


def check_retry_not_found():
    led = _fresh()
    led.record({"company_key": "A", "status": "email_not_found"})
    led.record({"company_key": "B", "status": "no_website"})
    firms = [{"company_key": "A"}, {"company_key": "B"}]
    assert led.filter_pending(firms)[1] == 2                        # both skipped by default
    pending, skipped = led.filter_pending(firms, retry_not_found=True)
    assert [p["company_key"] for p in pending] == ["A"], pending    # only not_found comes back
    assert skipped == 1


def check_pushed_never_retried():
    led = _fresh()
    led.record({"company_key": "A", "status": "email_not_found"}, pushed=True)
    pending, _ = led.filter_pending([{"company_key": "A"}], retry_not_found=True)
    assert pending == [], "a pushed lead must never be reprocessed"


def check_persists_and_key_is_normalised():
    path = Path(tempfile.mkdtemp()) / "ledger.json"
    led = Ledger(path)
    led.record({"company_key": "  Alpha   LTD ", "status": "email_found"})
    led.save()
    again = Ledger(path)                                            # reloaded from disk
    assert again.is_done({"company_key": "alpha ltd"}), again.entries
    assert again.is_done({"Company Name": "ALPHA LTD"})


def check_stats_and_clear():
    led = _fresh()
    led.record({"company_key": "A", "status": "email_found"}, pushed=True)
    led.record({"company_key": "B", "status": "no_website"})
    s = led.stats()
    assert s["total"] == 2 and s["pushed"] == 1, s
    assert s["by_status"]["no_website"] == 1
    led.clear()
    assert led.stats()["total"] == 0


CHECKS = [check_records_and_skips, check_every_terminal_status_sticks, check_retry_not_found,
          check_pushed_never_retried, check_persists_and_key_is_normalised, check_stats_and_clear]

def test_records(): check_records_and_skips()
def test_terminal(): check_every_terminal_status_sticks()
def test_retry(): check_retry_not_found()
def test_pushed(): check_pushed_never_retried()
def test_persist(): check_persists_and_key_is_normalised()
def test_stats(): check_stats_and_clear()


def main() -> int:
    failed = 0
    for c in CHECKS:
        try:
            c(); print(f"PASS  {c.__name__}")
        except AssertionError as e:
            failed += 1; print(f"FAIL  {c.__name__}: {e}")
    print(f"\n{len(CHECKS) - failed}/{len(CHECKS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
