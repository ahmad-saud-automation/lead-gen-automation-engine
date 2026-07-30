"""
eval_emailgen.py - offline test for the email-pattern generator (matches V7).
    python eval_emailgen.py   /   pytest eval_emailgen.py
No network, no keys, no cost.
"""
from __future__ import annotations

import sys

from core.emailgen import (generate, candidates_for_firm, derive_name,
                          clean_local_part, matches_generated_pattern)


def check_lean_order():
    c = generate("Ian", "Smith", "smithco.co.uk", mode="lean")
    emails = [x["email"] for x in c]
    assert emails == ["ian@smithco.co.uk", "ian.smith@smithco.co.uk", "i.smith@smithco.co.uk"], emails
    assert [x["pattern"] for x in c] == ["first", "first.last", "f.last"]


def check_plus_mode():
    c = generate("Ian", "Smith", "smithco.co.uk", mode="plus", middle="Hamish")
    emails = [x["email"] for x in c]
    # first, middle, first.last, f.last, firstlast, flast
    assert "hamish@smithco.co.uk" in emails
    assert "iansmith@smithco.co.uk" in emails      # firstlast
    assert "ismith@smithco.co.uk" in emails        # flast
    assert len(emails) == len(set(emails))         # deduped


def check_derive_name():
    d = derive_name("MR Ian Hamish Smith")
    assert d["first"] == "ian" and d["middle"] == "hamish" and d["last"] == "smith", d
    d2 = derive_name("Jane Doe")
    assert d2["first"] == "jane" and d2["middle"] == "" and d2["last"] == "doe"


def check_short_local_skipped():
    # single-letter first with no last: 'first' -> 'i' (len 1) is skipped
    c = generate("I", "", "x.co.uk", mode="lean")
    assert all(len(x["email"].split("@")[0]) >= 2 for x in c)


def check_clean_local():
    assert clean_local_part("John..Smith") == "john.smith"
    assert clean_local_part(".jsmith-") == "jsmith"
    assert clean_local_part("O'Brien") == "obrien"


def check_no_domain():
    assert generate("Ian", "Smith", "") == []


def check_candidates_for_firm():
    firm = {"lead_director": "MR Ian Hamish Smith", "lead_firstname": "ian",
            "lead_lastname": "smith", "lead_domain": "smithco.co.uk"}
    c = candidates_for_firm(firm, mode="lean")
    assert c[0]["email"] == "ian@smithco.co.uk"
    assert c[1]["email"] == "ian.smith@smithco.co.uk"


def check_matches_pattern():
    assert matches_generated_pattern("ian.smith@smithco.co.uk", "Ian", "Smith", "smithco.co.uk")
    assert not matches_generated_pattern("info@smithco.co.uk", "Ian", "Smith", "smithco.co.uk")
    assert not matches_generated_pattern("ian.smith@other.com", "Ian", "Smith", "smithco.co.uk")


CHECKS = [check_lean_order, check_plus_mode, check_derive_name, check_short_local_skipped,
          check_clean_local, check_no_domain, check_candidates_for_firm, check_matches_pattern]

def test_lean_order(): check_lean_order()
def test_plus_mode(): check_plus_mode()
def test_derive_name(): check_derive_name()
def test_short_local(): check_short_local_skipped()
def test_clean_local(): check_clean_local()
def test_no_domain(): check_no_domain()
def test_candidates_for_firm(): check_candidates_for_firm()
def test_matches_pattern(): check_matches_pattern()


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
