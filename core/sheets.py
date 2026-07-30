"""
sheets.py — Google Sheets source + status write-back (V7's "Load Endole Lead List"
and "Update Sheet — Pushed to Instantly").

Two access paths, so reading works with zero setup:

  1. CSV export (read-only, NO credentials) — works when the sheet is shared
     "anyone with the link can view". Just paste the sheet URL.
  2. Service account (read + WRITE) — needed to write statuses back. Requires
     `google-auth` + `google-api-python-client` and a service-account JSON whose
     client_email is shared as an Editor on the sheet.

`update_statuses` matches rows by Company Name (V7's key) and writes only the V7
columns, leaving every other column untouched.
"""
from __future__ import annotations

import csv
import io
import re
import urllib.request

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

# the columns V7 writes back after a successful push
WRITEBACK_COLUMNS = [
    "Status", "Final Status", "Found Email", "Selected Director", "Email Source",
    "Email Type", "Verification Status", "Campaign Type", "Ice Breaker",
    "Oldest Director Name", "Oldest Director Email", "Oldest Director Source", "Oldest Director Verification",
    "Youngest Director Name", "Youngest Director Email", "Youngest Director Source", "Youngest Director Verification",
    "Director 1 Name", "Director 1 Email", "Director 1 Source", "Director 1 Verification",
    "Director 2 Name", "Director 2 Email", "Director 2 Source", "Director 2 Verification",
    "Director 3 Name", "Director 3 Email", "Director 3 Source", "Director 3 Verification",
    "Alternate Emails",
]


def parse_sheet_url(url: str) -> dict:
    """Pull the document id and gid out of any Google Sheets URL (or accept a bare id)."""
    s = str(url or "").strip()
    doc = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", s)
    gid = re.search(r"[#&?]gid=(\d+)", s)
    if not doc and re.fullmatch(r"[a-zA-Z0-9-_]{20,}", s):
        return {"doc_id": s, "gid": ""}
    return {"doc_id": doc.group(1) if doc else "", "gid": gid.group(1) if gid else ""}


def csv_export_url(doc_id: str, gid: str = "") -> str:
    u = f"https://docs.google.com/spreadsheets/d/{doc_id}/export?format=csv"
    return u + (f"&gid={gid}" if gid else "")


def read_via_csv_export(doc_id: str, gid: str = "", *, timeout: int = 30, opener=None) -> list[dict]:
    """Read rows with no credentials — requires the sheet to be link-viewable."""
    url = csv_export_url(doc_id, gid)
    if opener:
        text = opener(url)
    else:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            if "text/csv" not in (r.headers.get("Content-Type") or "") and r.geturl().find("accounts.google.com") != -1:
                raise PermissionError("Sheet is not link-viewable — share it or use a service account.")
            text = r.read().decode("utf-8-sig", "replace")
    if text.lstrip().lower().startswith("<!doctype html") or "<html" in text[:400].lower():
        raise PermissionError("Sheet is not link-viewable — share it (Anyone with link) or use a service account.")
    return [{(k or "").strip(): (v or "") for k, v in row.items()}
            for row in csv.DictReader(io.StringIO(text))]


# ── service-account client (read + write) ────────────────────────────

class SheetsClient:
    """Thin wrapper over the Sheets REST API using a service-account JSON."""

    def __init__(self, service_account_file: str):
        try:
            from google.oauth2 import service_account  # type: ignore
            from googleapiclient.discovery import build  # type: ignore
        except ImportError as e:  # noqa: BLE001
            raise RuntimeError(
                "Writing to Google Sheets needs the Google libraries. Install them with:\n"
                "  pip install google-auth google-api-python-client"
            ) from e
        creds = service_account.Credentials.from_service_account_file(service_account_file, scopes=SCOPES)
        self._svc = build("sheets", "v4", credentials=creds, cache_discovery=False)
        self.client_email = getattr(creds, "service_account_email", "")

    def read(self, doc_id: str, tab: str = "Combined") -> list[dict]:
        res = self._svc.spreadsheets().values().get(
            spreadsheetId=doc_id, range=tab).execute()
        values = res.get("values", [])
        if not values:
            return []
        header = [str(h).strip() for h in values[0]]
        rows = []
        for raw in values[1:]:
            padded = list(raw) + [""] * (len(header) - len(raw))
            rows.append({header[i]: padded[i] for i in range(len(header))})
        return rows

    def _header(self, doc_id: str, tab: str) -> list[str]:
        res = self._svc.spreadsheets().values().get(spreadsheetId=doc_id, range=f"{tab}!1:1").execute()
        return [str(h).strip() for h in (res.get("values") or [[]])[0]]

    def open_writer(self, doc_id: str, tab: str, key_column: str = "Company Name"):
        """Read the header + row index ONCE, then write rows one at a time as each
        lead is pushed — same live behaviour as n8n's per-item Update Sheet node."""
        header = self._header(doc_id, tab)
        if key_column not in header:
            raise ValueError(f"'{key_column}' column not found in tab '{tab}'")
        rows = self.read(doc_id, tab)
        norm = lambda v: re.sub(r"\s+", " ", str(v or "").strip().lower())
        index = {norm(r.get(key_column)): i for i, r in enumerate(rows)}
        cols = {c: i for i, c in enumerate(header)}

        def col_letter(i: int) -> str:
            return chr(65 + i) if i < 26 else chr(64 + i // 26) + chr(65 + i % 26)

        def write_row(update: dict) -> dict:
            """Push one row's V7 columns to the sheet immediately."""
            row_i = index.get(norm(update.get(key_column)))
            if row_i is None:
                return {"ok": False, "reason": "row not found", "key": update.get(key_column)}
            sheet_row = row_i + 2                       # +1 header, +1 for 1-based rows
            data = [{"range": f"{tab}!{col_letter(cols[c])}{sheet_row}", "values": [[v]]}
                    for c, v in update.items()
                    if c != key_column and c in WRITEBACK_COLUMNS and c in cols]
            if not data:
                return {"ok": False, "reason": "no writable columns"}
            self._svc.spreadsheets().values().batchUpdate(
                spreadsheetId=doc_id,
                body={"valueInputOption": "RAW", "data": data}).execute()
            return {"ok": True, "row": sheet_row, "cells": len(data)}

        return write_row

    def update_statuses(self, doc_id: str, tab: str, updates: list[dict],
                        key_column: str = "Company Name") -> dict:
        """updates = [{'Company Name': ..., 'Status': ..., ...}]. Matches existing rows by
        key_column and writes only WRITEBACK_COLUMNS that exist in the sheet header."""
        header = self._header(doc_id, tab)
        if key_column not in header:
            return {"ok": False, "error": f"'{key_column}' column not found in {tab}", "updated": 0}
        rows = self.read(doc_id, tab)
        norm = lambda v: re.sub(r"\s+", " ", str(v or "").strip().lower())
        index = {norm(r.get(key_column)): i for i, r in enumerate(rows)}
        col_letter = lambda i: (chr(65 + i) if i < 26 else chr(64 + i // 26) + chr(65 + i % 26))

        data, updated, missing = [], 0, []
        for up in updates:
            row_i = index.get(norm(up.get(key_column)))
            if row_i is None:
                missing.append(up.get(key_column))
                continue
            sheet_row = row_i + 2                      # +1 header, +1 to 1-based
            for col, val in up.items():
                if col == key_column or col not in WRITEBACK_COLUMNS or col not in header:
                    continue
                a1 = f"{tab}!{col_letter(header.index(col))}{sheet_row}"
                data.append({"range": a1, "values": [[val]]})
            updated += 1
        if data:
            self._svc.spreadsheets().values().batchUpdate(
                spreadsheetId=doc_id,
                body={"valueInputOption": "RAW", "data": data}).execute()
        return {"ok": True, "updated": updated, "cells": len(data), "not_found": missing}


def build_writeback_row(result: dict, status: str) -> dict:
    """One result row -> the V7 sheet update payload."""
    src = result.get("email_source") or "selected"
    email = result.get("found_email", "")
    ver = result.get("verification", "")
    return {
        "Company Name": result.get("company", ""),
        "Status": status, "Final Status": status,
        "Found Email": email,
        "Selected Director": result.get("selected_director", ""),
        "Email Source": src,
        "Email Type": result.get("email_type", "director"),
        "Verification Status": ver,
        "Campaign Type": result.get("campaign_type", "director_main_campaign"),
        "Ice Breaker": result.get("icebreaker", ""),
        "Oldest Director Name": result.get("Oldest Director Name", ""),
        "Oldest Director Email": result.get("Oldest Director Email", ""),
        "Oldest Director Source": src if result.get("Oldest Director Email") else "",
        "Oldest Director Verification": result.get("Oldest Director Verification", ""),
        "Youngest Director Name": result.get("Youngest Director Name", ""),
        "Director 1 Name": result.get("Director 1 Name", ""),
        "Director 1 Email": result.get("Director 1 Email", ""),
        "Director 1 Source": src if result.get("Director 1 Email") else "",
        "Director 1 Verification": result.get("Director 1 Verification", ""),
        "Director 2 Name": result.get("Director 2 Name", ""),
        "Director 3 Name": result.get("Director 3 Name", ""),
    }
