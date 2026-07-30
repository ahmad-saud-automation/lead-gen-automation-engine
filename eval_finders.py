"""
eval_finders.py - offline test for Icypeas + Anymailfinder (no network, no keys).
    python eval_finders.py   /   pytest eval_finders.py
Uses the no-spend test transports + the response parsers.
"""
from __future__ import annotations

import sys

from core import finders


def check_icypeas_test_find():
    r = finders.find_icypeas({"lead_firstname": "ian", "lead_lastname": "reed", "lead_domain": "gamma.co.uk"}, test_mode=True)
    assert r["email"] == "ian.reed@gamma.co.uk", r


def check_icypeas_no_name():
    r = finders.find_icypeas({"lead_firstname": "", "lead_lastname": "", "Company Name": "X"}, test_mode=True)
    assert r["email"] == "", r


def check_icypeas_company_fallback():
    r = finders.find_icypeas({"lead_firstname": "amy", "lead_lastname": "poole", "Company Name": "Orbit Ltd"}, test_mode=True)
    assert r["email"].startswith("amy.poole@") and r["email"].endswith(".co.uk"), r


def check_icypeas_parse():
    ok = {"items": [{"results": {"emails": [{"email": "A.B@x.com", "certainty": "high"}]}, "status": "DONE"}], "success": True}
    assert finders._parse_icypeas(ok)["email"] == "a.b@x.com"
    processing = {"items": [{"results": {"emails": [{"email": "a@x.com"}]}, "status": "IN_PROGRESS"}]}
    assert finders._parse_icypeas(processing)["email"] == ""


def check_anymail_test_find():
    r = finders.find_anymailfinder({"lead_domain": "peak.co.uk", "lead_director": "Jane Clark"}, test_mode=True)
    assert r["email"] == "jane.clark@peak.co.uk", r


def check_anymail_no_domain():
    assert finders.find_anymailfinder({"lead_domain": "", "lead_director": "Jane Clark"}, test_mode=True)["email"] == ""


def check_anymail_parse():
    assert finders._parse_anymail({"valid_email": "X@Y.com"})["email"] == "x@y.com"
    assert finders._parse_anymail({"data": {"email": "z@q.com"}})["email"] == "z@q.com"
    assert finders._parse_anymail({})["email"] == ""


CHECKS = [check_icypeas_test_find, check_icypeas_no_name, check_icypeas_company_fallback,
          check_icypeas_parse, check_anymail_test_find, check_anymail_no_domain, check_anymail_parse]

def test_icypeas_find(): check_icypeas_test_find()
def test_icypeas_no_name(): check_icypeas_no_name()
def test_icypeas_company(): check_icypeas_company_fallback()
def test_icypeas_parse(): check_icypeas_parse()
def test_anymail_find(): check_anymail_test_find()
def test_anymail_no_domain(): check_anymail_no_domain()
def test_anymail_parse(): check_anymail_parse()


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
