"""
finders.py — Icypeas + Anymailfinder email-finders (faithful to V7's HTTP nodes).

Each returns {"email": "<found or ''>", ...}. Like verify.py, a transport can be
injected; test_mode uses a no-spend stub so the whole cascade runs offline. Keys are
passed in (never hardcoded).

Credit rules are applied by the caller (web layer): Icypeas / Anymailfinder cost 1
credit ONLY when they return an email; MillionVerifier costs 1 per check.
"""
from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request

from . import net
from . import retry as retry_mod

ICYPEAS_SEARCH = "https://app.icypeas.com/api/email-search"
ICYPEAS_READ = "https://app.icypeas.com/api/bulk-single-searchs/read"
ANYMAIL_URL = "https://api.anymailfinder.com/v5.1/find-email/person"


def _domain_or_company(firm: dict) -> str:
    v = str(firm.get("lead_domain") or firm.get("lead_website") or firm.get("Company Name") or firm.get("lead_company") or "")
    v = re.sub(r"^https?://", "", v, flags=re.I)
    v = re.sub(r"^www\.", "", v, flags=re.I)
    return v.split("/")[0].strip()


# ── Icypeas (async: search -> wait -> read) ──────────────────────────

def _http_icypeas(first, last, doc, api_key, timeout, wait):
    body = json.dumps({"firstname": first, "lastname": last, "domainOrCompany": doc}).encode()
    req = urllib.request.Request(ICYPEAS_SEARCH, data=body, method="POST",
                                 headers=net.headers({"Content-Type": "application/json",
                                                      "Authorization": api_key}))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        find = json.loads(r.read().decode("utf-8", "replace"))
    sid = (find.get("item") or {}).get("_id") or find.get("_id") or ""
    if not sid:
        return {"items": [], "success": False}
    time.sleep(wait)
    rbody = json.dumps({"id": sid}).encode()
    req2 = urllib.request.Request(ICYPEAS_READ, data=rbody, method="POST",
                                  headers=net.headers({"Content-Type": "application/json",
                                                       "Authorization": api_key}))
    with urllib.request.urlopen(req2, timeout=timeout) as r2:
        return json.loads(r2.read().decode("utf-8", "replace"))


def _test_icypeas(first, last, doc, api_key, timeout, wait):
    if not (first and last):
        return {"items": [{"results": {"emails": []}, "status": "DONE"}], "success": True}
    dom = re.sub(r"[^a-z0-9.]", "", str(doc).lower()) or "firm.co.uk"
    if "." not in dom:
        dom += ".co.uk"
    return {"items": [{"results": {"emails": [{"email": f"{first}.{last}@{dom}", "certainty": "probable"}]},
                       "status": "DONE"}], "success": True}


def _parse_icypeas(resp: dict) -> dict:
    items = resp.get("items") or []
    first = items[0] if items else {}
    emails = (first.get("results") or {}).get("emails") or []
    status = str(first.get("status", "")).upper()
    still = status in ("NONE", "IN_PROGRESS", "")
    if not emails or still or resp.get("success") is False:
        return {"email": "", "certainty": ""}
    top = emails[0] or {}
    return {"email": str(top.get("email", "")).strip().lower(), "certainty": str(top.get("certainty", "")).lower()}


def find_icypeas(firm: dict, api_key: str = "", *, test_mode: bool = False,
                 transport=None, timeout: int = 15, wait: int = 15,
                 throttle: float = 2.0, tries: int = 3, retry_wait: float = 5.0,
                 on_retry=None) -> dict:
    """throttle mirrors V7's 2-second "Throttle Before Icypeas" node."""
    tr = transport or (_test_icypeas if test_mode else _http_icypeas)
    if not test_mode and throttle:
        time.sleep(max(0.0, float(throttle)))
    attempts = 1 if test_mode else max(1, int(tries or 1))
    try:
        resp = retry_mod.call(tr, firm.get("lead_firstname", ""), firm.get("lead_lastname", ""),
                              _domain_or_company(firm), api_key, timeout,
                              0 if test_mode else wait,
                              tries=attempts, wait=retry_wait, on_retry=on_retry) or {}
    except Exception as e:  # noqa: BLE001 — finder errors are non-fatal
        return {"email": "", "certainty": "", "error": str(e)}
    return _parse_icypeas(resp)


# ── Anymailfinder (single call) ──────────────────────────────────────

def _http_anymail(domain, full_name, company, api_key, timeout):
    body = urllib.parse.urlencode({"domain": domain, "full_name": full_name, "company_name": company}).encode()
    req = urllib.request.Request(ANYMAIL_URL, data=body, method="POST",
                                 headers=net.headers({"Content-Type": "application/x-www-form-urlencoded",
                                                      "Authorization": "Bearer " + api_key}))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _test_anymail(domain, full_name, company, api_key, timeout):
    parts = str(full_name).lower().split()
    if len(parts) < 2 or not domain:
        return {"email": ""}
    return {"email": f"{parts[0]}.{parts[-1]}@{domain}"}


def _parse_anymail(resp: dict) -> dict:
    email = (resp.get("email") or resp.get("valid_email") or resp.get("best_email")
             or (resp.get("data") or {}).get("email") or (resp.get("result") or {}).get("email") or "")
    return {"email": str(email).strip().lower()}


def find_anymailfinder(firm: dict, api_key: str = "", *, test_mode: bool = False,
                       transport=None, timeout: int = 15, tries: int = 3,
                       retry_wait: float = 5.0, on_retry=None) -> dict:
    tr = transport or (_test_anymail if test_mode else _http_anymail)
    attempts = 1 if test_mode else max(1, int(tries or 1))
    try:
        resp = retry_mod.call(tr, firm.get("lead_domain", ""), firm.get("lead_director", ""),
                              firm.get("Company Name") or firm.get("lead_company", ""),
                              api_key, timeout,
                              tries=attempts, wait=retry_wait, on_retry=on_retry) or {}
    except Exception as e:  # noqa: BLE001
        return {"email": "", "error": str(e)}
    return _parse_anymail(resp)
