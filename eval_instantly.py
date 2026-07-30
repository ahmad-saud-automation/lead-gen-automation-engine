"""
eval_instantly.py - offline test for the Instantly payload + push (no network, no keys).
    python eval_instantly.py   /   pytest eval_instantly.py
Nothing is ever sent: the push uses the no-spend stub transport.
"""
from __future__ import annotations

import sys

from core import instantly

CAMPAIGN = "00000000-1111-2222-3333-444444444444"
ROW = {
    "company": "Smith & Co", "selected_director": "ian hamish smith",
    "found_email": "ian.smith@smithco.co.uk", "email_source": "pattern_first.last",
    "domain": "smithco.co.uk", "phone": "020 7946 0001", "city": "London",
    "icebreaker": '  "know you guys are crushing it at Smith & Co,\nso this is a bit out of the blue."  ',
}


def check_clean_icebreaker():
    c = instantly.clean_icebreaker(ROW["icebreaker"])
    assert not c.startswith('"') and '"' not in c, c
    assert "\n" not in c and "  " not in c, repr(c)
    assert c.endswith("out of the blue."), c            # NOT truncated
    assert c.startswith("know you guys"), c


def check_display_name():
    n = instantly.split_display_name("ian hamish smith")
    assert n == {"first": "Ian", "last": "Smith", "full": "Ian Smith"}, n
    assert instantly.split_display_name("madonna")["last"] == ""
    assert instantly.split_display_name("")["full"] == ""


def check_payload_shape():
    p = instantly.build_payload(ROW, CAMPAIGN)
    assert p["campaign"] == CAMPAIGN
    assert p["email"] == "ian.smith@smithco.co.uk"
    assert p["first_name"] == "Ian" and p["last_name"] == "Smith"
    assert p["company_name"] == "Smith & Co"
    assert p["website"] == "smithco.co.uk"
    assert p["personalization"].startswith("know you guys")
    # V7's exact skip flags
    assert p["skip_if_in_workspace"] is False
    assert p["skip_if_in_campaign"] is False
    assert p["skip_if_in_list"] is True
    assert p["custom_variables"] == {"Address": "London"}


def check_pushed_status():
    assert instantly.pushed_status("pattern_first.last") == "pushed_to_instantly_pattern_first.last"
    assert instantly.pushed_status("") == "pushed_to_instantly_selected"


def check_push_test_mode():
    r = instantly.push_lead(ROW, CAMPAIGN, test_mode=True)
    assert r["ok"] and r["response"].get("simulated") is True, r
    assert r["status"] == "pushed_to_instantly_pattern_first.last", r


def check_push_needs_email_and_campaign():
    assert instantly.push_lead({**ROW, "found_email": ""}, CAMPAIGN, test_mode=True)["skipped"] is True
    assert instantly.push_lead(ROW, "", test_mode=True)["ok"] is False      # no campaign id


def check_push_error_is_non_fatal():
    def boom(payload, key, timeout=30):
        raise RuntimeError("instantly down")
    r = instantly.push_lead(ROW, CAMPAIGN, "k", transport=boom)
    assert r["ok"] is False and "instantly down" in r["error"]


CHECKS = [check_clean_icebreaker, check_display_name, check_payload_shape, check_pushed_status,
          check_push_test_mode, check_push_needs_email_and_campaign, check_push_error_is_non_fatal]

def test_clean(): check_clean_icebreaker()
def test_name(): check_display_name()
def test_payload(): check_payload_shape()
def test_status(): check_pushed_status()
def test_push(): check_push_test_mode()
def test_guards(): check_push_needs_email_and_campaign()
def test_error(): check_push_error_is_non_fatal()


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
