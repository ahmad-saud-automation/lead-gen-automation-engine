"""
ledger.py — the local "already handled" record.

The Google Sheet's Status column is the source of truth when you sync a sheet, but
it only helps if you HAVE a sheet. This ledger gives the same protection locally:
every lead that reaches a terminal outcome is recorded by company key, so the next
run skips it instead of re-verifying (and re-charging) the same leads.

It also covers the gap where a sheet write-back fails mid-run — the lead is still
marked done locally, so it won't be silently redone.

`retry_not_found` lets email_not_found leads back in (e.g. after adding a new finder
or getting a fresh API key), while pushed leads stay done forever.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

# outcomes that mean "don't try this lead again"
TERMINAL = {"email_found", "email_not_found", "no_website", "hold_security_gateway"}
RETRYABLE = {"email_not_found"}


def _key(firm_or_row: dict) -> str:
    v = (firm_or_row.get("company_key") or firm_or_row.get("Company Name")
         or firm_or_row.get("company") or "")
    return " ".join(str(v).strip().lower().split())


class Ledger:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.entries: dict[str, dict] = {}
        self.load()

    def load(self) -> None:
        try:
            self.entries = json.loads(self.path.read_text(encoding="utf-8")) or {}
        except Exception:
            self.entries = {}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.entries, indent=2, ensure_ascii=False), encoding="utf-8")

    def record(self, row: dict, *, pushed: bool = False) -> None:
        k = _key(row)
        if not k:
            return
        prev = self.entries.get(k, {})
        self.entries[k] = {
            "company": row.get("company") or row.get("Company Name", ""),
            "status": row.get("status", "") or prev.get("status", ""),
            "email": row.get("found_email", "") or prev.get("email", ""),
            "pushed": bool(pushed or prev.get("pushed")),
            "when": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

    def is_done(self, firm: dict, *, retry_not_found: bool = False) -> bool:
        e = self.entries.get(_key(firm))
        if not e:
            return False
        if retry_not_found and not e.get("pushed") and e.get("status") in RETRYABLE:
            return False
        return e.get("status") in TERMINAL

    def filter_pending(self, firms: list[dict], *, retry_not_found: bool = False) -> tuple[list[dict], int]:
        pending = [f for f in firms if not self.is_done(f, retry_not_found=retry_not_found)]
        return pending, len(firms) - len(pending)

    def stats(self) -> dict:
        pushed = sum(1 for e in self.entries.values() if e.get("pushed"))
        by_status: dict[str, int] = {}
        for e in self.entries.values():
            by_status[e.get("status", "")] = by_status.get(e.get("status", ""), 0) + 1
        return {"total": len(self.entries), "pushed": pushed, "by_status": by_status}

    def clear(self) -> None:
        self.entries = {}
        self.save()
