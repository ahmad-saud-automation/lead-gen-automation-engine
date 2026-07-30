"""
pipeline.py — the per-firm cascade, a faithful port of V7's decision spine.

Order per firm (stop at the first accepted email):
  1. Security-gateway guard      -> hold_security_gateway
  2. Endole email (existing)     -> optional MillionVerifier
  3. Pattern guess               -> MillionVerifier   (skipped on no-website leads)
  4. Icypeas fallback            -> optional MillionVerifier   (Phase 2)
  5. Anymailfinder fallback      -> optional MillionVerifier   (Phase 2)
  6. Found  -> build icebreaker (Phase 2) ; else no_website / email_not_found

Emits a structured event at every step (live feed + Log) and returns one result row.
The caller injects the tools so tests + no-spend mode work:
  verify_email(email)  -> {accepted, verification, tier}
  find_icypeas(firm)   -> {email, certainty}   (credit charged by caller only if email)
  find_anymail(firm)   -> {email}
  make_icebreaker(firm, email) -> {text, style}
"""
from __future__ import annotations

from . import emailgen
from . import gateway
from . import icebreaker as icebreaker_mod

STAGES = ["organize", "gateway", "endole", "pattern", "verify", "icypeas", "anymail", "icebreaker", "result"]


def _row(firm: dict, *, status: str, found_email: str = "", source: str = "", verification: str = "",
         tries=None, verifs: int = 0, icebreaker: str = "", ice_style: str = "") -> dict:
    director = firm.get("lead_director", "") or firm.get("Oldest Director Name", "")
    got = bool(found_email)
    return {
        "company_key": firm.get("company_key") or firm.get("Company Name", ""),
        "company": firm.get("Company Name", ""), "domain": firm.get("lead_domain", ""),
        "phone": firm.get("lead_phone", ""), "city": firm.get("lead_city", ""),
        "gateway_provider": firm.get("email_security_gateway_provider", ""),
        "selected_director": director, "found_email": found_email, "email_source": source,
        "verification": verification, "status": status, "verifications_used": verifs,
        "icebreaker": icebreaker, "ice_style": ice_style, "tries": tries or [],
        "Oldest Director Name": firm.get("Oldest Director Name", ""),
        "Youngest Director Name": firm.get("Youngest Director Name", ""),
        "Director 1 Name": firm.get("Director 1 Name", ""),
        "Director 2 Name": firm.get("Director 2 Name", ""),
        "Director 3 Name": firm.get("Director 3 Name", ""),
        "Oldest Director Email": found_email if got else "",
        "Director 1 Email": found_email if got else "",
        "Oldest Director Verification": verification if got else "",
        "Director 1 Verification": verification if got else "",
    }


def _finder_stage(firm, cfg, stage, use_key, verify_key, source, finder, check, emit):
    """Run one external finder (Icypeas / Anymailfinder). Returns a `found` dict or None."""
    company = firm.get("Company Name", "")
    if not (cfg.get(use_key, False) and finder):
        return None
    emit(company, stage, "info", "searching…")
    r = finder(firm)
    em = r.get("email", "")
    if not em:
        emit(company, stage, "fail", r.get("error") or "not found")
        return None
    if cfg.get(verify_key, False):
        v = check(em)
        if v["accepted"]:
            emit(company, stage, "success", f"{em} · {v['verification']}", em)
            return {"email": em, "source": source, "verification": v["verification"]}
        emit(company, stage, "fail", f"{em} · {v['verification']}", em)
        return None
    cert = r.get("certainty", "")
    emit(company, stage, "success", f"{em} · accepted (no MF{', ' + cert if cert else ''})", em)
    return {"email": em, "source": source, "verification": f"verified_by_{stage}_no_mf{('_' + cert) if cert else ''}"}


def process_firm(firm: dict, cfg: dict, verify_email, emit,
                 find_icypeas=None, find_anymail=None, make_icebreaker=None) -> dict:
    company = firm.get("Company Name", "")
    domain = firm.get("lead_domain", "")
    state = {"verifs": 0}

    def check(email):
        state["verifs"] += 1
        return verify_email(email)

    # 1) security gateway
    gw = gateway.guard(firm.get("email_security_gateway_provider", ""),
                       block=bool(cfg.get("block_security_gateways", False)))
    if gw["held"]:
        emit(company, "gateway", "held", f"held · {gw['provider']}")
        return _row(firm, status="hold_security_gateway", verification="hold_security_gateway")

    found, tries = None, []

    # 2) existing Endole email
    endole = str(firm.get("lead_endole_email", "") or "").strip()
    if cfg.get("use_endole", True) and endole:
        if firm.get("endole_generic"):
            emit(company, "endole", "skip", f"generic mailbox skipped · {endole}")
        elif cfg.get("verify_endole_with_mf", True):
            v = check(endole)
            if v["accepted"]:
                emit(company, "endole", "success", f"{endole} · {v['verification']}", endole)
                found = {"email": endole, "source": "endole", "verification": v["verification"]}
            else:
                emit(company, "endole", "fail", f"{endole} · {v['verification']}", endole)
        else:
            emit(company, "endole", "success", f"{endole} · accepted (no verify)", endole)
            found = {"email": endole, "source": "endole", "verification": "accepted_no_mf"}

    no_web = bool(firm.get("is_no_website_path"))

    # 3) pattern guess (needs a domain)
    if not found and not no_web and cfg.get("use_patterns", True) and domain:
        for c in emailgen.candidates_for_firm(firm, mode=cfg.get("pattern_mode", "lean")):
            v = check(c["email"])
            tries.append({"email": c["email"], "accepted": v["accepted"],
                          "verification": v["verification"], "pattern": c.get("pattern", "")})
            if v["accepted"]:
                emit(company, "verify", "success", f"{c['email']} · {v['verification']}", c["email"])
                found = {"email": c["email"], "source": f"pattern_{c.get('pattern', '')}", "verification": v["verification"]}
                break
            emit(company, "verify", "fail", f"{c['email']} · {v['verification']}", c["email"])
    elif not found and no_web:
        emit(company, "pattern", "skip", "no website — patterns skipped")

    # 4) Icypeas fallback  5) Anymailfinder fallback
    if not found:
        found = _finder_stage(firm, cfg, "icypeas", "use_icypeas", "verify_icypeas_with_mf",
                              "icypeas_director", find_icypeas, check, emit)
    if not found:
        found = _finder_stage(firm, cfg, "anymail", "use_anymailfinder", "verify_anymailfinder_with_mf",
                              "anymailfinder_director", find_anymail, check, emit)

    # 6) result (+ icebreaker on a hit)
    if found:
        ib = {"text": "", "style": ""}
        if cfg.get("use_icebreaker", True):
            fw = dict(firm); fw["found_email"] = found["email"]
            ib = (make_icebreaker(fw, found["email"]) if make_icebreaker else icebreaker_mod.build(fw, found["email"]))
            if ib.get("text"):
                emit(company, "icebreaker", "success", f"[{ib.get('style', '')}] {ib['text'][:60]}…")
        return _row(firm, status="email_found", found_email=found["email"], source=found["source"],
                    verification=found["verification"], tries=tries, verifs=state["verifs"],
                    icebreaker=ib.get("text", ""), ice_style=ib.get("style", ""))

    if no_web:
        return _row(firm, status="no_website", verification="no_website", tries=tries, verifs=state["verifs"])
    emit(company, "result", "fail", "email_not_found · all sources exhausted")
    return _row(firm, status="email_not_found", verification="not_found", tries=tries, verifs=state["verifs"])


def run(firms, cfg, verify_email, emit, should_cancel=None, **tools) -> list[dict]:
    results = []
    for firm in firms:
        if should_cancel and should_cancel():
            break
        results.append(process_firm(firm, cfg, verify_email, emit, **tools))
    return results
