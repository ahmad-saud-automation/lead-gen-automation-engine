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
        "lead_id": "P-abc1234567",
        "company": "Smith & Co", "contact_name": "Ian Smith",
        "found_email": "ian.smith@smithco.co.uk", "email_source": "pattern_first.last",
        "verification": "good", "icebreaker": "hello there",
        "mv_date": "2026-08-31",
    }
    up = sheets.build_writeback_row(result, "pushed_to_instantly_pattern_first.last")
    assert up["Company Name"] == "Smith & Co"
    assert up["Status"] == up["Final Status"] == "pushed_to_instantly_pattern_first.last"
    assert up["Campaign Type"] == "director_main_campaign"
    assert up["Ice Breaker"] == "hello there"
    assert up["Contact Name"] == "Ian Smith"
    assert up["mv_date"] == "2026-08-31"
    # a MillionVerifier PASS is what opens the send gate
    assert up["send_ready"] == "yes", up
    # every written key must be a recognised column (or one of the two match keys)
    for k in up:
        assert k in ("Company Name", "lead_id") or k in sheets.WRITEBACK_COLUMNS, k
    # a campaign lane never writes the Ice Breaker column: it is Icebreaker Studio's
    lane = sheets.build_writeback_row(result, "pushed_to_instantly_x", write_icebreaker=False)
    assert "Ice Breaker" not in lane, lane
    assert lane["Found Email"] == "ian.smith@smithco.co.uk"


def check_unverified_is_not_send_ready():
    """A guessed address that MillionVerifier has not passed must never be sendable."""
    up = sheets.build_writeback_row(
        {"company": "X", "found_email": "a@b.com", "verification": "unknown"}, "s")
    assert up["send_ready"] == "no", up

    # ...but a lead that found NOTHING must not stamp send_ready at all. Writing "no"
    # here would overwrite a "yes" the row already earned from an earlier verification,
    # which is the same data-loss class as blanking Found Email. (changed 2026-09-06)
    up = sheets.build_writeback_row({"company": "X", "found_email": ""}, "s")
    assert "send_ready" not in up, up
    assert up["Status"] == "s" and up["Final Status"] == "s", up


def check_writeback_blank_director_has_no_source():
    """No contact and no email -> nothing is claimed, and contact 2 stays untouched.
    Contact 2 is released BY HAND via verify_contact_2, never by the engine."""
    up = sheets.build_writeback_row({"company": "X", "email_source": "endole"},
                                    "pushed_to_instantly_endole")
    # "nothing is claimed" is now expressed by leaving the key OUT rather than writing an
    # empty string, because an empty string is a destructive write. (changed 2026-09-06)
    assert "Contact Name" not in up and "Found Email" not in up, up
    assert "Contact 2 Email" not in up, up
    assert "send_ready" not in up, up
    assert up["Status"] == "pushed_to_instantly_endole", up


def check_a_failed_lead_never_erases_the_address_already_on_the_row():
    """⛔ THE 2026-09-06 DATA-LOSS BUG. A live run wrote `Found Email: ""` for two leads it
    failed to find, wiping two paid-for apollo_old addresses off the real sheet.

    A failed search tells us our attempt failed. It tells us NOTHING about the address
    already sitting on the row, so that row keeps everything it had."""
    row = sheets.build_writeback_row(
        {"company": "Acme", "row_key": "P-1", "found_email": "", "verification": "not_found",
         "email_source": "", "icebreaker": "", "campaign_type": "eco-size-micro"},
        "email_not_found")
    assert row["Status"] == "email_not_found" and row["Final Status"] == "email_not_found"
    assert row["Campaign Type"] == "eco-size-micro"
    for destructive in ("Found Email", "Email Source", "Verification Status", "send_ready",
                        "Ice Breaker", "Alternate Emails", "Contact 2 Email", "mv_date"):
        assert destructive not in row, f"{destructive} would be blanked onto the sheet: {row}"


def check_a_blank_is_never_written_over_anything():
    """Rule 2: empty means 'we did not learn this', never 'delete what is there'."""
    row = sheets.build_writeback_row(
        {"company": "Acme", "row_key": "P-2", "found_email": "a@b.co.uk",
         "verification": "ok", "email_source": "pattern_first",
         "icebreaker": "", "alternate_emails": "", "mv_date": "", "contact_2_email": ""},
        "pushed_to_instantly_pattern_first")
    assert row["Found Email"] == "a@b.co.uk"
    assert row["send_ready"] == "yes"
    for blank in ("Ice Breaker", "Alternate Emails", "mv_date", "Contact 2 Email"):
        assert blank not in row, f"{blank} is blank and must not be written: {row}"
    assert all(str(v).strip() for v in row.values()), row


CHECKS = [check_parse_url, check_export_url, check_read_csv_export,
          check_read_rejects_login_page, check_writeback_row,
          check_unverified_is_not_send_ready, check_writeback_blank_director_has_no_source,
          check_a_failed_lead_never_erases_the_address_already_on_the_row,
          check_a_blank_is_never_written_over_anything]


def test_failed_lead_preserves_row(): check_a_failed_lead_never_erases_the_address_already_on_the_row()
def test_no_blank_writes(): check_a_blank_is_never_written_over_anything()

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
