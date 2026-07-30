"""
eval_sheets.py - offline test for the Google Sheets source + write-back mapping.
    python eval_sheets.py   /   pytest eval_sheets.py
No network: the CSV reader is driven through an injected opener.
"""
from __future__ import annotations

import sys

from core import sheets

URL = "https://docs.google.com/spreadsheets/d/1_UewlDS_M7XC9-Ike1UbUoO6s1R4PRknBEMZpkpjMYo/edit#gid=1420196366"


def check_parse_url():
    p = sheets.parse_sheet_url(URL)
    assert p["doc_id"] == "1_UewlDS_M7XC9-Ike1UbUoO6s1R4PRknBEMZpkpjMYo", p
    assert p["gid"] == "1420196366", p
    bare = sheets.parse_sheet_url("1_UewlDS_M7XC9-Ike1UbUoO6s1R4PRknBEMZpkpjMYo")
    assert bare["doc_id"] and bare["gid"] == ""
    assert sheets.parse_sheet_url("not a sheet")["doc_id"] == ""


def check_export_url():
    u = sheets.csv_export_url("DOC", "42")
    assert u == "https://docs.google.com/spreadsheets/d/DOC/export?format=csv&gid=42", u
    assert "gid" not in sheets.csv_export_url("DOC")


def check_read_csv_export():
    csv_text = "Company Name,Website,Status\nSmith & Co,smithco.co.uk,new\nOrbit Ltd,orbit.co.uk,\n"
    rows = sheets.read_via_csv_export("DOC", "1", opener=lambda url: csv_text)
    assert len(rows) == 2 and rows[0]["Company Name"] == "Smith & Co", rows
    assert rows[1]["Status"] == ""


def check_read_rejects_login_page():
    html = "<!DOCTYPE html><html><head><title>Sign in</title></head></html>"
    try:
        sheets.read_via_csv_export("DOC", "1", opener=lambda url: html)
    except PermissionError as e:
        assert "link-viewable" in str(e)
        return
    raise AssertionError("expected PermissionError for a non-shared sheet")


def check_writeback_row():
    result = {
        "company": "Smith & Co", "selected_director": "Ian Smith",
        "found_email": "ian.smith@smithco.co.uk", "email_source": "pattern_first.last",
        "verification": "good", "icebreaker": "hello there",
        "Oldest Director Name": "Ian Smith", "Oldest Director Email": "ian.smith@smithco.co.uk",
        "Director 1 Name": "Ian Smith", "Director 1 Email": "ian.smith@smithco.co.uk",
        "Director 1 Verification": "good",
    }
    up = sheets.build_writeback_row(result, "pushed_to_instantly_pattern_first.last")
    assert up["Company Name"] == "Smith & Co"
    assert up["Status"] == up["Final Status"] == "pushed_to_instantly_pattern_first.last"
    assert up["Campaign Type"] == "director_main_campaign"
    assert up["Ice Breaker"] == "hello there"
    assert up["Oldest Director Source"] == "pattern_first.last"
    # every written key must be a recognised V7 column (or the match key)
    for k in up:
        assert k == "Company Name" or k in sheets.WRITEBACK_COLUMNS, k


def check_writeback_blank_director_has_no_source():
    up = sheets.build_writeback_row({"company": "X", "email_source": "endole"}, "pushed_to_instantly_endole")
    assert up["Director 1 Source"] == "" and up["Oldest Director Source"] == ""


CHECKS = [check_parse_url, check_export_url, check_read_csv_export,
          check_read_rejects_login_page, check_writeback_row, check_writeback_blank_director_has_no_source]

def test_parse(): check_parse_url()
def test_export(): check_export_url()
def test_read(): check_read_csv_export()
def test_login_page(): check_read_rejects_login_page()
def test_writeback(): check_writeback_row()
def test_blank_dir(): check_writeback_blank_director_has_no_source()


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
