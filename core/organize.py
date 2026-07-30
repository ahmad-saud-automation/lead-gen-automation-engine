"""
organize.py — turn raw Apollo/Companies-House lead rows into clean, deduped,
MillionVerifier-ready firm rows.

A faithful Python port of the n8n "Accountancy Firms Outreach v7" logic
("Filter Processable Leads" + "Store Lead Data Code"):
  * skip rows already processed (blocked statuses),
  * clean the website into a bare domain,
  * split multi-value director names, parse ages,
  * sort directors OLDEST-first (oldest = primary contact, like v7),
  * strip title prefixes (MR/DR/…), split into first/last/initials,
  * keep Director 1..3 + Oldest/Youngest name slots,
  * dedupe by company (reg number, else company name) across many CSVs,
  * skip firms you already own (suppression).

Deterministic and pure — testable offline.
"""
from __future__ import annotations

import re

# ── statuses that mean "already handled" — skip these rows (v7) ──
BLOCKED_STATUSES = {
    "pushed_to_instantly", "no_website", "email_not_found", "generic_skipped",
    "fallback_failed", "duplicate_company_skipped", "hold_security_gateway",
    "skipped_security_gateway", "bounced", "risky", "catch_all",
    "risky_catch_all_accepted",
}

# ── title prefixes stripped from director names (v7) ──
NAME_PREFIXES = {"mr", "mrs", "ms", "miss", "mts", "dr", "prof", "sir",
                 "dame", "lady", "lord", "rev", "hon", "capt"}

# ── generic / role mailbox locals to skip (v7) ──
GENERIC_LOCALS = {
    "info", "admin", "contact", "hello", "office", "accounts", "account",
    "enquiries", "enquiry", "mail", "email", "sales", "support", "team", "help",
    "reception", "bookings", "booking", "service", "services", "practice", "tax",
    "payroll", "billing", "billings", "finance", "partners", "partner", "clients",
    "clientcare", "customerservice", "customer.service", "general", "secretary",
    "pa", "hr", "careers", "jobs", "legal", "compliance", "data", "privacy",
    "marketing", "webmaster", "post", "inbox",
}

KNOWN_CITIES = ["london", "manchester", "birmingham", "bristol", "leeds",
                "liverpool", "sheffield", "glasgow", "edinburgh", "cardiff",
                "nottingham", "leicester", "coventry", "southampton", "reading",
                "oxford", "cambridge", "newcastle"]

DIRECTOR_COLUMNS_TO_LOG = 3   # v7 keeps up to 3 director names on the sheet


# ───────────────────────── field helpers (ported from v7) ─────────────────────────

def clean_domain(website: str) -> str:
    d = re.sub(r"^=", "", str(website or "")).strip()
    d = re.sub(r"^https?://", "", d, flags=re.I)
    d = re.sub(r"^www\.", "", d, flags=re.I)
    return d.split("/")[0].strip().lower()


def extract_city(address: str) -> str:
    parts = [p.strip() for p in str(address or "").split(",") if p.strip()]
    for part in parts:
        low = part.lower()
        if any(c in low for c in KNOWN_CITIES):
            return part
    return parts[-2] if len(parts) >= 2 else ""


def split_people(value: str) -> list[str]:
    raw = str(value or "").strip()
    if not raw:
        return []
    out = []
    for part in re.split(r"\r?\n|;|\|", raw):
        for name in str(part or "").split(","):
            n = re.sub(r"\s+", " ", name.strip())
            if len(n) > 1:
                out.append(n)
    return out


def parse_ages(value: str) -> list[int | None]:
    matches = re.findall(r"\d{1,3}", str(value or "").strip())
    ages = []
    for m in matches:
        v = int(m)
        ages.append(v if 0 < v < 120 else None)
    return ages


def _strip_prefixes(parts: list[str]) -> list[str]:
    result = list(parts)
    while len(result) > 1:
        first_clean = re.sub(r"[^a-z]", "", result[0].lower())
        if first_clean in NAME_PREFIXES:
            result.pop(0)
        else:
            break
    return result


def name_parts(full_name: str) -> dict:
    clean = re.sub(r"\s+", " ", str(full_name or "").strip())
    parts = [p for p in clean.split(" ") if p]
    parts = _strip_prefixes(parts)
    cleaned_full = " ".join(parts)
    first = re.sub(r"[^a-z]", "", (parts[0] if parts else "").lower())
    last = re.sub(r"[^a-z]", "", (parts[-1] if len(parts) > 1 else "").lower())
    initials = re.sub(r"[^a-z]", "", "".join(p[0] if p else "" for p in parts).lower())
    return {"clean": cleaned_full, "first": first, "last": last, "initials": initials}


def is_generic_email(email: str) -> bool:
    e = str(email or "").strip().lower()
    local = e.split("@")[0] if "@" in e else ""
    compact = re.sub(r"[^a-z]", "", local)
    if not local or "@" not in e:
        return False
    if local in GENERIC_LOCALS or compact in GENERIC_LOCALS:
        return True
    for g in GENERIC_LOCALS:
        if local == g or compact == g:
            return True
        if len(local) > len(g) and local.startswith(g):
            nxt = local[len(g)]
            if not ("a" <= nxt <= "z"):
                return True
    return False


def is_processable(status: str, *, strict: bool = True) -> bool:
    """Which sheet rows still need work.

    strict=True (default): a BLANK Status means "not done"; anything written in that
    column means the row was already handled. This is what lets an unattended schedule
    advance — each run writes a status, so the next run skips that row. "new" is the
    one exception, since sheets commonly use it as a blank placeholder.

    strict=False: v7's looser rule — only recognised blocked statuses are skipped.
    """
    s = str(status or "").strip().lower()
    if not s or s == "new":
        return True
    if strict:
        return False
    if s.startswith("pushed_to_instantly"):
        return False
    return not any(b in s for b in BLOCKED_STATUSES)


def _norm_company(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", str(name or "").lower())).strip()


# ───────────────────────── the main organize step ─────────────────────────

def _get(row: dict, *keys: str) -> str:
    for k in keys:
        if k in row and str(row[k]).strip():
            return str(row[k]).strip()
    return ""


# seniority ranking (from the Apollo-API leads project): most senior first,
# plain title beats a prefixed one (Partner > Audit Partner).
SENIORITY = ["owner", "founder", "managing partner", "managing director",
             "president", "ceo", "chief executive", "partner", "principal", "director"]


def title_rank(title: str) -> tuple[int, int]:
    t = str(title or "").strip().lower()
    for i, word in enumerate(SENIORITY):
        if word in t:
            return (i, 0 if t == word else 1)     # plain beats prefixed
    return (len(SENIORITY), 9)


def _directors_from_row(row: dict) -> list[dict]:
    """Directors on one input row.
    Company-rows (Companies House / v7): a multi-value 'Director Names' field
    (+ parallel 'Director's Age'), no per-person titles.
    Apollo person-rows: a single Name (+ Title, + optional Age)."""
    names = split_people(_get(row, "Director Names", "Director Name", "Directors"))
    if names:
        ages = parse_ages(_get(row, "Director's Age", "Director Age", "Directors Age"))
        return [{"name": n, "title": "", "age": ages[i] if i < len(ages) else None}
                for i, n in enumerate(names) if n]
    single = _get(row, "Name", "Full Name", "Director", "Contact Name")
    if not single:
        single = (_get(row, "First Name") + " " + _get(row, "Last Name")).strip()
    if single:
        ages = parse_ages(_get(row, "Age", "Director's Age"))
        return [{"name": single,
                 "title": _get(row, "Title", "Job Title", "Role", "Position", "Seniority"),
                 "age": ages[0] if ages else None}]
    return []


def organize(rows, owned_companies=None, owned_domains=None, *, strict_status: bool = True) -> dict:
    """Merge many CSVs -> group by firm -> rank the primary contact by seniority
    (oldest-age tie-break) -> dedupe -> suppress. One clean row per firm.
    strict_status: blank Status = process, anything written = already done."""
    owned_c = {_norm_company(c) for c in (owned_companies or []) if c}
    owned_d = {clean_domain(d) for d in (owned_domains or []) if d}
    skipped = {"already_processed": 0, "no_company": 0, "duplicate": 0, "suppressed": 0}

    groups, order = {}, []
    for row in rows:
        if not is_processable(_get(row, "Status", "Final Status"), strict=strict_status):
            skipped["already_processed"] += 1
            continue
        company = _get(row, "Company Name", "lead_company", "Organization", "Company")
        if not company:
            skipped["no_company"] += 1
            continue
        reg = _get(row, "Reg Number", "Registration Number")
        key = _norm_company(reg or company)
        if key not in groups:
            website = _get(row, "Website", "lead_website", "URL", "Domain", "Clean Website Domain")
            groups[key] = {
                "Company Name": company, "Reg Number": reg, "company_key": reg or company,
                "website": website, "domain": clean_domain(website),
                "phone": _get(row, "Telephone", "Phone", "Phone Number"),
                "city": extract_city(_get(row, "Address", "Region")),
                "years": _get(row, "Years Trading", "lead_years"),
                "directors": [], "seen_names": set(),
            }
            order.append(key)
        g = groups[key]
        for d in _directors_from_row(row):
            nkey = re.sub(r"[^a-z]", "", d["name"].lower())
            if nkey and nkey in g["seen_names"]:      # same person across files -> merge
                skipped["duplicate"] += 1
                continue
            if nkey:
                g["seen_names"].add(nkey)
            d["idx"] = len(g["directors"]) + 1
            g["directors"].append(d)

    firms = []
    for key in order:
        g = groups[key]
        if key in owned_c or (g["domain"] and g["domain"] in owned_d):
            skipped["suppressed"] += 1
            continue
        directors = g["directors"] or [{"name": "", "title": "", "age": None, "idx": 1}]
        # primary: most senior title; tie -> oldest age; tie -> plain-beats-prefixed; tie -> order
        ranked = sorted(directors, key=lambda d: (
            title_rank(d["title"])[0],
            -(d["age"] if d["age"] is not None else -1),
            title_rank(d["title"])[1],
            d["idx"]))
        by_age = sorted(directors, key=lambda d: -(d["age"] if d["age"] is not None else -1))
        primary = ranked[0]
        p = name_parts(primary["name"])
        firm = {
            "Company Name": g["Company Name"], "Reg Number": g["Reg Number"],
            "company_key": g["company_key"], "lead_domain": g["domain"],
            "lead_website": g["website"], "lead_phone": g["phone"],
            "lead_city": g["city"], "lead_years": g["years"],
            "is_no_website_path": not g["domain"],
            "total_directors_available": len([d for d in directors if d["name"]]),
            "primary_title": primary["title"],
            "lead_director": p["clean"], "lead_firstname": p["first"],
            "lead_lastname": p["last"], "lead_initials": p["initials"],
            "Oldest Director Name": by_age[0]["name"],
            "Youngest Director Name": by_age[-1]["name"],
        }
        for i in range(DIRECTOR_COLUMNS_TO_LOG):
            firm[f"Director {i + 1} Name"] = ranked[i]["name"] if i < len(ranked) else ""
        firms.append(firm)

    return {"firms": firms, "skipped": skipped, "count": len(firms)}
