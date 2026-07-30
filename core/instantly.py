"""
instantly.py — a faithful port of V7's "Prepare Instantly Data" + "Add lead to campaign".

Two halves, both testable offline:
  * build_payload(row, campaign_id)  — pure. Cleans the icebreaker exactly as V7 does
    (strip wrapping quotes, drop quote chars, newlines -> spaces, collapse spaces, NO
    sentence truncation) and derives Title-Cased first/last from "Selected Director"
    for Instantly's {{firstName}} greeting.
  * push_lead(...)                   — POST /api/v2/leads. test_mode uses a no-spend
    stub so the whole flow runs without touching the real campaign.

Also `pushed_status(source)` -> the exact V7 sheet status: pushed_to_instantly_<source>.

Nothing here sends anything unless test_mode is False AND a key + campaign id are set.
"""
from __future__ import annotations

import json
import re
import urllib.request

from . import retry as retry_mod

INSTANTLY_URL = "https://api.instantly.ai/api/v2/leads"


def clean_icebreaker(text: str) -> str:
    """V7's cleaner: unwrap quotes, remove quote chars, flatten newlines, collapse spaces."""
    s = str(text or "").strip()
    s = re.sub(r'^["\'“”]+|["\'“”]+$', "", s)
    s = re.sub(r'["“”]', "", s)
    s = re.sub(r"[\r\n]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def title_case_name(name: str) -> str:
    s = re.sub(r"\s+", " ", str(name or "").strip()).lower()
    return re.sub(r"\b[a-z]", lambda m: m.group(0).upper(), s)


def split_display_name(director: str) -> dict:
    parts = [p for p in str(director or "").strip().split(" ") if p]
    first = title_case_name(parts[0]) if parts else ""
    last = title_case_name(parts[-1]) if len(parts) > 1 else ""
    return {"first": first, "last": last, "full": " ".join(x for x in (first, last) if x)}


def pushed_status(source: str) -> str:
    """V7 writes pushed_to_instantly_<email_source> to both Status and Final Status."""
    return f"pushed_to_instantly_{str(source or 'selected').strip() or 'selected'}"


def build_payload(row: dict, campaign_id: str) -> dict:
    """The exact body V7 sends to Instantly for one verified lead."""
    name = split_display_name(row.get("selected_director") or row.get("Selected Director") or "")
    return {
        "campaign": campaign_id,
        "email": row.get("found_email") or row.get("final_email") or "",
        "first_name": name["first"],
        "last_name": name["last"],
        "company_name": row.get("company") or row.get("Company Name") or "",
        "website": row.get("lead_website") or row.get("domain") or "",
        "phone": row.get("phone") or "",
        "personalization": clean_icebreaker(row.get("icebreaker") or row.get("ice_breaker") or ""),
        "skip_if_in_workspace": False,
        "skip_if_in_campaign": False,
        "skip_if_in_list": True,
        "custom_variables": {"Address": row.get("city") or ""},
    }


def _http_push(payload: dict, api_key: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(
        INSTANTLY_URL, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8", "replace")
        try:
            data = json.loads(body)
        except Exception:
            data = {"raw": body}
        return {"ok": 200 <= r.status < 300, "status_code": r.status, "response": data}


def _test_push(payload: dict, api_key: str, timeout: int = 30) -> dict:
    """No-spend stub: validates the payload shape without contacting Instantly."""
    if not payload.get("email"):
        return {"ok": False, "status_code": 0, "response": {"error": "no email"}}
    if not payload.get("campaign"):
        return {"ok": False, "status_code": 0, "response": {"error": "no campaign id"}}
    return {"ok": True, "status_code": 200,
            "response": {"id": "test-" + str(abs(hash(payload["email"])) % 10**8), "simulated": True}}


def push_lead(row: dict, campaign_id: str, api_key: str = "", *, test_mode: bool = False,
              transport=None, timeout: int = 30, tries: int = 3, retry_wait: float = 5.0,
              on_retry=None) -> dict:
    """Add one verified lead to the Instantly campaign. Returns the outcome + the
    sheet status to write back on success."""
    payload = build_payload(row, campaign_id)
    if not payload["email"]:
        return {"ok": False, "skipped": True, "reason": "no verified email", "payload": payload}
    tr = transport or (_test_push if test_mode else _http_push)
    attempts = 1 if test_mode else max(1, int(tries or 1))
    try:
        res = retry_mod.call(tr, payload, api_key, timeout,
                             tries=attempts, wait=retry_wait, on_retry=on_retry)
    except Exception as e:  # noqa: BLE001 — a failed push must not kill the run
        return {"ok": False, "error": str(e), "payload": payload}
    out = {"ok": bool(res.get("ok")), "status_code": res.get("status_code"),
           "response": res.get("response"), "payload": payload}
    if out["ok"]:
        out["status"] = pushed_status(row.get("email_source") or row.get("Email Source") or "selected")
    return out
