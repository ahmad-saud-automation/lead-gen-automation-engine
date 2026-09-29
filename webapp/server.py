"""
server.py - Lead Gen Automation Engine (Accountancy Outreach V7), Phase 1.

Local FastAPI app over the tested core engine. Phase-1 scope:
    Dashboard · Leads · Settings · Live run · Results · Log · History

Live run streams every pipeline event (per lead, per stage). Events are written to a
per-run append-only NDJSON file (so a 50k-lead run never lives in one JSON blob); the
live feed keeps a rolling in-memory window; the Log tab reads from disk with
server-side filter + limit. Credits are tracked per tool (MillionVerifier per check;
Anymailfinder / Icypeas per email found - those arrive in Phase 2).
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import sys
import threading
import time
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, PlainTextResponse, Response

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import organize as organize_mod  # noqa: E402
from core import verify as verify_mod  # noqa: E402
from core import cost as cost_mod  # noqa: E402
from core import pipeline as pipeline_mod  # noqa: E402
from core import finders as finders_mod  # noqa: E402
from core import icebreaker as icebreaker_mod  # noqa: E402
from core import instantly as instantly_mod  # noqa: E402
from core import sheets as sheets_mod  # noqa: E402
from core import ledger as ledger_mod  # noqa: E402
from core import net as net_mod  # noqa: E402
from core import fieldmap as fieldmap_mod  # noqa: E402
from core import campaigns as campaigns_mod  # noqa: E402
from core import runner as runner_mod  # noqa: E402
from core import rules as rules_mod  # noqa: E402

WEBAPP_DIR = Path(__file__).resolve().parent
CONFIG_DIR = ROOT / "config"
DATA = ROOT / "data"
RUNS_DIR = DATA / "runs"
UPLOADS_DIR = DATA / "uploads"
LEADS_FILE = DATA / "leads.json"
HISTORY_FILE = DATA / "history.json"
CONFIG_FILE = DATA / "config.json"
LEDGER_FILE = DATA / "ledger.json"
DEFAULT_CONFIG_FILE = ROOT / "config.json"
for d in (DATA, RUNS_DIR, UPLOADS_DIR):
    d.mkdir(parents=True, exist_ok=True)

KEEP_RUNS = 300        # retention: prune run files beyond this many
FEED_WINDOW = 1000     # rolling in-memory events kept for the live feed
LOG_SCAN_CAP = 6000    # max events the Log tab scans (recent-first)


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


DEFAULT_CONFIG = {
    "use_endole": True, "verify_endole_with_mf": True, "use_patterns": True,
    "use_icypeas": True, "use_anymailfinder": False,
    "verify_icypeas_with_mf": False, "verify_anymailfinder_with_mf": False,
    "use_icebreaker": True, "use_openai_echo": False,
    "accept_catchall": False, "block_security_gateways": False,
    "pattern_mode": "lean", "max_firms": 50,
    "mv_per_verification_usd": 0.00178,
    "anymailfinder_usd_per_credit": 0.0, "icypeas_usd_per_credit": 0.0,
    "apollo_credit_usd": 0.0236,
    "millionverifier_api_key": "", "icypeas_api_key": "",
    "anymailfinder_api_key": "", "openai_api_key": "",
    "owned_companies": [], "owned_domains": [],
    # ── Phase 3 ──
    "instantly_api_key": "", "instantly_campaign_id": "",
    "push_delay_seconds": 3,                 # V7 waits 3s between pushes
    "sheet_url": "", "sheet_tab": "Combined",
    "sheet_service_account_file": "", "sheet_writeback": False,
    # {tab name: local .csv path} - read a snapshot instead of the live sheet, so a
    # campaign can be tested with no credentials. Every screen says when this is on.
    "local_tabs": {},
    "strict_status": True,          # blank Status = process, anything written = done
    "api_tries": 3,                 # V7 parity: retry each API call 3x…
    "api_retry_wait": 5.0,          # …5s apart, backing off on 429 / 5xx / timeouts
    "verify_delay_ms": 0,           # optional pacing between verifications (0 = full speed)
    "icypeas_throttle_seconds": 2,  # V7's "Throttle Before Icypeas" node
    "use_ledger": True,             # skip leads already handled in a previous run
    "retry_not_found": False,       # let email_not_found leads back in on later runs
    "icebreaker_templates": {},     # edited copy from the Icebreaker tab (blank = defaults)
}
_BOOL_KEYS = {"use_endole", "verify_endole_with_mf", "use_patterns", "use_icypeas",
              "use_anymailfinder", "verify_icypeas_with_mf", "verify_anymailfinder_with_mf",
              "use_icebreaker", "use_openai_echo", "accept_catchall", "block_security_gateways",
              "sheet_writeback", "strict_status", "use_ledger", "retry_not_found"}
_KEY_FIELDS = ("millionverifier_api_key", "icypeas_api_key", "anymailfinder_api_key",
               "openai_api_key", "instantly_api_key")
TOOLS = [
    ("millionverifier", "MillionVerifier", "mv_per_verification_usd", "1 credit / check (found or not)"),
    ("anymailfinder", "Anymailfinder", "anymailfinder_usd_per_credit", "1 credit / email found"),
    ("icypeas", "Icypeas", "icypeas_usd_per_credit", "1 credit / email found"),
]


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(_read_json(DEFAULT_CONFIG_FILE, {}))
    cfg.update(_read_json(CONFIG_FILE, {}))
    return cfg


def save_config(patch: dict) -> dict:
    cfg = load_config()
    for k, v in patch.items():
        if k in DEFAULT_CONFIG:
            cfg[k] = v
    _write_json(CONFIG_FILE, cfg)
    return cfg


def _mv_key(cfg: dict) -> str:
    import os
    return (cfg.get("millionverifier_api_key") or os.environ.get("MILLIONVERIFIER_API_KEY", "")).strip()


# ───────────────────────── leads: import + organize (+ V7 endole/gateway) ─────────────────────────

def _rows_from_csv_bytes(raw: bytes) -> list[dict]:
    text = raw.decode("utf-8-sig", "replace")
    sample = text[:4096]
    delim = ","
    if sample.count(";") > sample.count(",") and sample.count(";") > sample.count("\t"):
        delim = ";"
    elif sample.count("\t") > sample.count(","):
        delim = "\t"
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    return [{(k or "").strip(): (v or "") for k, v in row.items()} for row in reader]


def _first(row: dict, *keys):
    for k in keys:
        if k in row and str(row[k]).strip():
            return str(row[k]).strip()
    return ""


def _attach_v7_fields(rows: list[dict], firms: list[dict]) -> None:
    info: dict[str, dict] = {}
    for row in rows:
        company = _first(row, "Company Name", "Organization", "Company", "lead_company")
        reg = _first(row, "Reg Number", "Registration Number")
        key = organize_mod._norm_company(reg or company)
        if not key or key in info:
            continue
        info[key] = {
            "endole": _first(row, "Original Endole email", "Email").lower(),
            "gateway": _first(row, "Email Security Gateway Provider", "Security Gateway Provider", "Security Gateway"),
        }
    for f in firms:
        meta = info.get(organize_mod._norm_company(f.get("company_key", "")), {})
        # organize() now fills these from the field map, so only overwrite when this
        # lookup actually found something — otherwise a blank here would erase it
        endole = meta.get("endole", "") or f.get("lead_endole_email", "")
        f["lead_endole_email"] = endole
        f["endole_generic"] = organize_mod.is_generic_email(endole) if endole else False
        f["email_security_gateway_provider"] = (meta.get("gateway", "")
                                                or f.get("email_security_gateway_provider", ""))


def firm_status_label(firm: dict) -> str:
    t = (firm.get("primary_title") or "").strip()
    return t.title() if t else "Director"


def _leads_view(payload: dict) -> dict:
    firms = payload.get("firms", [])
    return {
        "count": payload.get("count", 0), "rows_in": payload.get("rows_in", 0),
        "files": payload.get("files", []), "skipped": payload.get("skipped", {}),
        "ts": payload.get("ts"),
        "preview": [{
            "company": f.get("Company Name", ""), "domain": f.get("lead_domain", ""),
            "director": f.get("lead_director", "") or f.get("Oldest Director Name", ""),
            "status_label": firm_status_label(f),
            "gateway": f.get("email_security_gateway_provider", "") or "none",
            "endole": f.get("lead_endole_email", ""),
            "no_website": f.get("is_no_website_path", False),
        } for f in firms],
    }


# ───────────────────────── run jobs + streaming events ─────────────────────────

JOBS: dict[str, dict] = {}


def _now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _run_file(run_id: str) -> Path:
    return RUNS_DIR / f"{run_id}.json"


def _events_file(run_id: str) -> Path:
    return RUNS_DIR / f"{run_id}.events.ndjson"


def _append_event(run_id: str, ev: dict) -> None:
    with open(_events_file(run_id), "a", encoding="utf-8") as f:
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")


def _read_events(run_id: str, since: int = 0, limit: int | None = None) -> list[dict]:
    fp = _events_file(run_id)
    if not fp.exists():
        return []
    out = []
    with open(fp, encoding="utf-8") as f:
        for line in f:
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get("seq", 0) >= since:
                out.append(ev)
    return out[-limit:] if limit else out


def _credit_breakdown(cfg: dict, credits: dict) -> dict:
    rows, total_usd, total_credits = [], 0.0, 0
    for key, label, rate_key, rule in TOOLS:
        n = int(credits.get(key, 0))
        usd = round(n * float(cfg.get(rate_key) or 0.0), 4)
        total_usd += usd
        total_credits += n
        rows.append({"tool": label, "credits": n, "usd": usd, "rule": rule})
    return {"rows": rows, "total_credits": total_credits, "total_usd": round(total_usd, 4)}


def _run_record(job: dict) -> dict:
    return {
        "run_id": job["run_id"], "status": job["status"], "test_mode": job["test_mode"],
        "stage": job["stage"], "total": job["total"], "processed": job["processed"],
        "counters": job["counters"], "started": job["started"], "finished": job.get("finished"),
        "event_count": job["_seq"], "results": job["results"], "cfg_rates": job["rates"],
        "skipped_done": job.get("skipped_done", 0),
        "kind": job.get("kind", "run"), "source_run": job.get("source_run"),
        # which lane this run belonged to. It must survive to disk: the push reads it back
        # to find the campaign's target id, labels and options.
        "campaign": job.get("campaign", ""), "campaign_name": job.get("campaign_name", ""),
        "selection": job.get("selection"),
        "held_not_send_ready": job.get("held_not_send_ready", 0),
    }


def _snapshot(job: dict, since: int = 0) -> dict:
    rec = _run_record(job)
    rec["events"] = [e for e in job["events"] if e["seq"] >= since]
    rec["credits"] = _credit_breakdown_from_job(job)
    return rec


def _credit_breakdown_from_job(job: dict) -> dict:
    return _credit_breakdown(job["rates"], job["counters"]["credits"])


def _persist(job: dict) -> None:
    _write_json(_run_file(job["run_id"]), _run_record(job))


def _prune_runs() -> None:
    files = sorted(RUNS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[KEEP_RUNS:]:
        rid = old.stem
        try:
            old.unlink()
            _events_file(rid).unlink(missing_ok=True)
        except Exception:
            pass


TALLY = {"email_found": "found", "hold_security_gateway": "held",
         "no_website": "no_website", "email_not_found": "not_found"}

OPENAI_URL = "https://api.openai.com/v1/chat/completions"


def _openai_echo(text: str, api_key: str, model: str = "gpt-4o-mini") -> str:
    """V7's OpenAI node only echoes the icebreaker back verbatim. Off by default
    (use_openai_echo) since the text is already built deterministically in code."""
    import urllib.request
    payload = json.dumps({
        "model": model, "temperature": 0,
        "messages": [
            {"role": "system", "content": "Return the user's text back exactly as given. No preamble, no changes."},
            {"role": "user", "content": text},
        ],
    }).encode()
    req = urllib.request.Request(OPENAI_URL, data=payload, method="POST",
                                 headers=net_mod.headers({"Content-Type": "application/json",
                                                          "Authorization": "Bearer " + api_key}))
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        return (data.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
    except Exception:  # noqa: BLE001 - echo is cosmetic; fall back to the built text
        return ""


def _worker(run_id: str, firms: list[dict], cfg: dict, *, campaign=None, fm=None) -> None:
    job = JOBS[run_id]
    key = _mv_key(cfg)
    test_mode = job["test_mode"]
    accept_catchall = bool(cfg.get("accept_catchall", False))
    credits = job["counters"]["credits"]

    tries = max(1, int(cfg.get("api_tries", 3) or 1))
    retry_wait = float(cfg.get("api_retry_wait", 5.0) or 0)
    verify_delay = max(0, int(cfg.get("verify_delay_ms", 0) or 0)) / 1000.0

    def _retry_note(what):
        def note(attempt, attempts, exc, pause):
            job["counters"]["retries"] = job["counters"].get("retries", 0) + 1
            emit("", what, "retry", f"attempt {attempt}/{attempts} failed ({exc}) - retrying in {pause:.0f}s")
        return note

    def verify_email(email):
        v = verify_mod.verify_email(email, key, accept_catchall=accept_catchall, test_mode=test_mode,
                                    tries=tries, retry_wait=retry_wait, on_retry=_retry_note("verify"))
        credits["millionverifier"] += 1          # MillionVerifier: 1 credit per check
        job["counters"]["verifs"] += 1
        if v.get("tier") == "error":
            job["counters"]["errors"] += 1
        if verify_delay and not test_mode:
            time.sleep(verify_delay)
        return {"accepted": v["accepted"], "verification": v["verification"], "tier": v["tier"]}

    def emit(company, stage, status, detail, email=""):
        ev = {"seq": job["_seq"], "ts": _now(), "company": company, "stage": stage,
              "status": status, "detail": detail, "email": email}
        job["_seq"] += 1
        job["events"].append(ev)
        if len(job["events"]) > FEED_WINDOW + 200:
            job["events"] = job["events"][-FEED_WINDOW:]
        job["stage"] = stage
        _append_event(run_id, ev)

    # Icypeas / Anymailfinder: 1 credit ONLY when they return an email (no charge on a miss)
    def find_icypeas(firm):
        r = finders_mod.find_icypeas(firm, cfg.get("icypeas_api_key", ""), test_mode=test_mode,
                                     throttle=float(cfg.get("icypeas_throttle_seconds", 2) or 0),
                                     tries=tries, retry_wait=retry_wait, on_retry=_retry_note("icypeas"))
        if r.get("email"):
            credits["icypeas"] += 1
        elif r.get("error"):
            job["counters"]["errors"] += 1
        return r

    def find_anymail(firm):
        r = finders_mod.find_anymailfinder(firm, cfg.get("anymailfinder_api_key", ""), test_mode=test_mode,
                                           tries=tries, retry_wait=retry_wait, on_retry=_retry_note("anymail"))
        if r.get("email"):
            credits["anymailfinder"] += 1
        elif r.get("error"):
            job["counters"]["errors"] += 1
        return r

    def make_icebreaker(firm, email):
        ib = icebreaker_mod.build(firm, email, cfg.get("icebreaker_templates") or None)
        if cfg.get("use_openai_echo") and not test_mode and cfg.get("openai_api_key"):
            echoed = _openai_echo(ib["text"], cfg.get("openai_api_key", ""))
            if echoed:
                ib = {**ib, "text": echoed}
        return ib

    # V7 logged no_website / email_not_found straight back to the sheet - do the same,
    # live, so those leads are never re-verified on a later run.
    # ⛔ A TEST RUN TOUCHES NO PRODUCTION STATE. Same rule as the ledger: its addresses
    # and verdicts are invented, so it must never stamp a status onto the real sheet.
    # (The push worker already skips its writer in test mode; this is the run's half.)
    write_row = None
    if test_mode:
        emit("", "sheet", "skip", "test mode - the sheet is never written")
    else:
        write_row = _open_sheet_writer(cfg, emit, tab=(campaign.tab if campaign else ""), fm=fm)
    led = ledger_mod.Ledger(LEDGER_FILE) if cfg.get("use_ledger", True) else None
    camp_id = campaign.id if campaign else ""
    # only translate column names when the map actually knows the sheet's key column,
    # otherwise the writer is still matching rows on Company Name (V1 behaviour)
    use_map = fm is not None and bool(fm.header("row_key"))

    for firm in firms:
        if job.get("cancel"):
            break
        row = pipeline_mod.process_firm(firm, cfg, verify_email, emit,
                                        find_icypeas=find_icypeas, find_anymail=find_anymail,
                                        make_icebreaker=make_icebreaker)
        # the pipeline result knows nothing about the sheet it came from — carry the
        # identity and campaign across so the ledger, the labels and the write-back all
        # key on the SAME row
        for k in ("row_key", "lead_id", "campaign", "campaign_type", "seniority_label", "_raw"):
            if firm.get(k) not in (None, ""):
                row.setdefault(k, firm[k])
        job["results"].append(row)
        job["processed"] += 1
        bucket = TALLY.get(row["status"])
        if bucket:
            job["counters"][bucket] += 1
        # a test run marks nothing as handled — the ledger enforces that itself
        if led:
            led.record(row, fm=fm, campaign=camp_id, test_mode=test_mode)
        # found leads keep a blank sheet status until the push writes pushed_to_instantly_*
        if write_row and row["status"] in ("no_website", "email_not_found", "hold_security_gateway"):
            try:
                up = sheets_mod.build_writeback_row(row, row["status"])
                w = write_row(sheets_mod.to_sheet_row(up, fm) if use_map else up)
                if w.get("ok"):
                    job["counters"]["written_back"] += 1
                    emit(row.get("company", ""), "sheet", "success", f"Status → {row['status']} (row {w['row']})")
                else:
                    emit(row.get("company", ""), "sheet", "fail", f"write-back: {w.get('reason')}")
            except Exception as e:  # noqa: BLE001 - a sheet error must not kill the run
                emit(row.get("company", ""), "sheet", "fail", f"write-back error: {e}")
        _persist(job)

    job["status"] = "cancelled" if job.get("cancel") else "finished"
    job["stage"] = "done"
    job["finished"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _persist(job)
    _append_history(job)
    _prune_runs()


def _append_history(job: dict) -> None:
    c = job["counters"]
    cb = _credit_breakdown_from_job(job)
    hist = _read_json(HISTORY_FILE, [])
    hist.insert(0, {
        "run_id": job["run_id"], "when": job["started"], "status": job["status"],
        # which lane, so the campaign list can show each lane's last run
        "kind": job.get("kind", "run"), "campaign": job.get("campaign", ""),
        "campaign_name": job.get("campaign_name", ""), "source_run": job.get("source_run"),
        "test_mode": job["test_mode"], "leads": job["total"], "found": c["found"],
        "held": c["held"], "not_found": c["not_found"], "no_website": c["no_website"],
        "pushed": c.get("pushed", 0), "push_failed": c.get("push_failed", 0),
        "credits": cb["total_credits"], "spent_usd": cb["total_usd"],
    })
    _write_json(HISTORY_FILE, hist[:KEEP_RUNS])


def start_run(test_mode: bool) -> dict:
    cfg = load_config()
    firms = _read_json(LEADS_FILE, {}).get("firms", [])
    if not firms:
        return {"error": "No leads imported yet. Add CSV(s) on the Leads tab first."}
    skipped_done = 0
    if cfg.get("use_ledger", True):
        led = ledger_mod.Ledger(LEDGER_FILE)
        firms, skipped_done = led.filter_pending(
            firms, retry_not_found=bool(cfg.get("retry_not_found", False)))
        if not firms:
            return {"error": f"All {skipped_done} leads were handled in earlier runs. "
                             "Import more, or clear the ledger in Settings."}
    firms = firms[: int(cfg.get("max_firms", 50) or 50)]
    run_id = uuid.uuid4().hex[:12]
    job = {
        "run_id": run_id, "status": "running", "test_mode": bool(test_mode), "stage": "organize",
        "total": len(firms), "processed": 0, "results": [], "events": [], "_seq": 0,
        "counters": _new_counters(),
        "rates": {"mv_per_verification_usd": cfg.get("mv_per_verification_usd", 0.0),
                  "anymailfinder_usd_per_credit": cfg.get("anymailfinder_usd_per_credit", 0.0),
                  "icypeas_usd_per_credit": cfg.get("icypeas_usd_per_credit", 0.0)},
        "started": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "cancel": False,
        "skipped_done": skipped_done,
    }
    JOBS[run_id] = job
    _persist(job)
    threading.Thread(target=_worker, args=(run_id, firms, cfg), daemon=True).start()
    return _snapshot(job)


def _open_sheet_writer(cfg: dict, emit, *, tab: str = "", fm=None) -> object | None:
    """One live row-writer for the configured sheet, or None (with a reason emitted).

    With a field map the writer matches rows on the sheet's OWN key column (lead_id) and
    is allowed to write only the headers that map resolves — never a guessed name, whose
    write Google Sheets would discard in silence."""
    if not cfg.get("sheet_writeback"):
        return None
    sa = str(cfg.get("sheet_service_account_file") or "").strip()
    parsed = sheets_mod.parse_sheet_url(cfg.get("sheet_url", ""))
    if not (sa and parsed["doc_id"]):
        emit("", "sheet", "skip", "write-back needs a service-account file + sheet URL")
        return None
    key_col, allowed = "Company Name", None
    if fm is not None and fm.header("row_key"):
        key_col = fm.header("row_key")
        allowed = sheets_mod.writeback_headers(fm)
    try:
        w = sheets_mod.SheetsClient(sa).open_writer(
            parsed["doc_id"], tab or cfg.get("sheet_tab") or "Combined",
            key_column=key_col, allowed=allowed)
        emit("", "sheet", "info", f"live write-back ready (key: {key_col})")
        return w
    except Exception as e:  # noqa: BLE001
        emit("", "sheet", "fail", f"write-back unavailable: {e}")
        return None


def _new_counters() -> dict:
    return {"found": 0, "held": 0, "no_website": 0, "not_found": 0, "verifs": 0, "errors": 0,
            "retries": 0, "pushed": 0, "push_failed": 0, "push_skipped": 0, "written_back": 0,
            "credits": {"millionverifier": 0, "anymailfinder": 0, "icypeas": 0}}


def wait_for_job(run_id: str, timeout: float = 3600.0) -> dict | None:
    """Block until a job finishes (used by the headless scheduled runner)."""
    import time
    t0 = time.time()
    while run_id in JOBS and JOBS[run_id]["status"] == "running" and time.time() - t0 < timeout:
        time.sleep(0.25)
    return get_run(run_id)


# ── Google Sheets source + write-back ───────────────────────────────

def load_leads_from_sheet() -> dict:
    """Pull leads from the configured Sheet (service account if set, else the
    no-credentials CSV export) and organize them exactly like a CSV import."""
    cfg = load_config()
    parsed = sheets_mod.parse_sheet_url(cfg.get("sheet_url", ""))
    doc_id = parsed["doc_id"]
    if not doc_id:
        raise ValueError("No Google Sheet URL set in Settings.")
    tab = cfg.get("sheet_tab") or "Combined"
    sa = str(cfg.get("sheet_service_account_file") or "").strip()
    if sa:
        rows = sheets_mod.SheetsClient(sa).read(doc_id, tab)
        label = f"sheet:{tab} (service account)"
    else:
        rows = sheets_mod.read_via_csv_export(doc_id, parsed["gid"])
        label = f"sheet:{tab} (link export)"
    result = organize_mod.organize(rows, owned_companies=cfg.get("owned_companies"),
                                   owned_domains=cfg.get("owned_domains"),
                                   strict_status=bool(cfg.get("strict_status", True)))
    _attach_v7_fields(rows, result["firms"])
    payload = {"firms": result["firms"], "skipped": result["skipped"], "count": result["count"],
               "files": [label], "rows_in": len(rows),
               "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
    _write_json(LEADS_FILE, payload)
    return _leads_view(payload)


# ── campaigns: many lanes off one sheet ──────────────────────────────

def tab_source(cfg: dict, tab: str) -> dict:
    """Where a tab's rows come from, so the UI can say so out loud.

    A local CSV always wins when one is configured. That is deliberate — it lets a
    campaign be tested with no credentials at all — but it reads a SNAPSHOT, not the live
    sheet, so it must never be silently in effect."""
    local = str((cfg.get("local_tabs") or {}).get(tab) or "").strip()
    if local:
        return {"kind": "local_csv", "path": local, "live": False}
    sa = str(cfg.get("sheet_service_account_file") or "").strip()
    if sa:
        return {"kind": "service_account", "path": "", "live": True}
    return {"kind": "link_export", "path": "", "live": True}


def _read_tab(cfg: dict, tab: str) -> list[dict]:
    """Raw rows from ONE tab. A service account can address a tab by name; the
    no-credentials CSV export only reaches the tab the URL's gid points at. A local CSV
    configured in `local_tabs` overrides both, for offline testing."""
    local = str((cfg.get("local_tabs") or {}).get(tab) or "").strip()
    if local:
        p = Path(local)
        if not p.exists():
            raise ValueError(f"local_tabs points '{tab}' at {p}, which does not exist")
        return _rows_from_csv_bytes(p.read_bytes())
    parsed = sheets_mod.parse_sheet_url(cfg.get("sheet_url", ""))
    if not parsed["doc_id"]:
        raise ValueError("No Google Sheet URL set in Settings.")
    sa = str(cfg.get("sheet_service_account_file") or "").strip()
    if sa:
        return sheets_mod.SheetsClient(sa).read(parsed["doc_id"], tab)
    return sheets_mod.read_via_csv_export(parsed["doc_id"], parsed["gid"])


def campaigns_view() -> dict:
    """Every campaign, plus any config problem that would stop a run."""
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    camps = loaded["campaigns"]
    return {
        "globals": loaded["globals"],
        "issues": campaigns_mod.validate(camps),
        "campaigns": [{
            "id": c.id, "name": c.name, "enabled": c.enabled, "priority": c.priority,
            "tab": c.tab, "fieldmap": c.fieldmap,
            "per_run": c.per_run, "per_day": c.per_day,
            "max_spend_usd": c.max_spend_usd,
            "instantly_campaign_id": c.instantly_campaign_id,
            "labels": len(c.labels), "auto_push": c.auto_push,
            "label_issues": instantly_mod.validate_label_specs(c.labels or None),
        } for c in camps],
    }


def build_plan(*, enabled_only: bool = True) -> dict:
    """The free preview: what each campaign WOULD take. No API call, no spend."""
    cfg = load_config()
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    lanes = [c for c in loaded["campaigns"] if c.enabled or not enabled_only]
    if not lanes:
        return {"campaigns": [], "total_take": 0, "globals": loaded["globals"],
                "warnings": ["no campaign is enabled"], "fieldmaps": {}, "config_issues": []}

    rows_by_tab, fieldmaps, reports, errors = {}, {}, {}, []
    sources = {}
    for tab in sorted({c.tab for c in lanes if c.tab}):
        sources[tab] = tab_source(cfg, tab)
        try:
            rows = _read_tab(cfg, tab)
        except Exception as e:  # noqa: BLE001 — a bad tab must not hide the other tabs
            errors.append(f"could not read tab '{tab}': {e}")
            continue
        rows_by_tab[tab] = rows
        heads = runner_mod.headers_of(rows)
        lane = next((c for c in lanes if c.tab == tab), None)
        fm = runner_mod.fieldmap_for(lane, loaded["fieldmaps"], heads)
        fieldmaps[tab] = fm
        reports[tab] = runner_mod.check_fieldmap(fm, heads)

    led = ledger_mod.Ledger(LEDGER_FILE) if cfg.get("use_ledger", True) else None
    rep = campaigns_mod.plan(rows_by_tab, lanes, fieldmaps, ledger=led,
                             globals_cfg=loaded["globals"],
                             mv_rate_usd=float(cfg.get("mv_per_verification_usd", 0) or 0))
    rep["fieldmaps"] = reports
    rep["sources"] = sources
    rep["config_issues"] = campaigns_mod.validate(loaded["campaigns"])
    rep["warnings"] = (rep.get("warnings") or []) + errors
    return rep


def _read_campaigns_raw() -> dict:
    return _read_json(CONFIG_DIR / "campaigns.json", {"globals": {}, "campaigns": []})


def _write_campaigns_raw(body: dict) -> dict:
    """Validate, keep one backup, then write. A config file is never replaced by a broken
    one — the engine would refuse to run and the previous state would be gone."""
    camps = [campaigns_mod.Campaign(c) for c in (body.get("campaigns") or [])]
    issues = campaigns_mod.validate(camps)
    for c in camps:
        issues += [{"campaign": c.id, "issue": f"labels: {i}"}
                   for i in instantly_mod.validate_label_specs(c.labels or None)]
    if issues:
        return {"ok": False, "issues": issues}
    path = CONFIG_DIR / "campaigns.json"
    if path.exists():
        (CONFIG_DIR / "campaigns.backup.json").write_text(
            path.read_text(encoding="utf-8"), encoding="utf-8")
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "campaigns": len(camps)}


def save_campaign(patch: dict) -> dict:
    """Update ONE campaign in place, leaving every other key in the file untouched."""
    cid = str(patch.get("id") or "").strip()
    if not cid:
        return {"ok": False, "issues": [{"campaign": "", "issue": "no campaign id given"}]}
    body = _read_campaigns_raw()
    rows = body.get("campaigns") or []
    idx = next((i for i, c in enumerate(rows) if str(c.get("id")) == cid), -1)
    if idx < 0:
        return {"ok": False, "issues": [{"campaign": cid, "issue": "no such campaign"}]}
    merged = {**rows[idx]}
    for k, v in patch.items():
        if k != "id":
            merged[k] = v
    rows[idx] = merged
    body["campaigns"] = rows
    out = _write_campaigns_raw(body)
    out["campaign"] = cid
    return out


def save_globals(patch: dict) -> dict:
    body = _read_campaigns_raw()
    body["globals"] = {**(body.get("globals") or {}), **patch}
    return _write_campaigns_raw(body)


def create_campaign(req: dict) -> dict:
    """Add a lane — blank, or a copy of `copy_from`. It starts switched off and checked last."""
    body = _read_campaigns_raw()
    rows = body.get("campaigns") or []
    src = None
    if req.get("copy_from"):
        src = next((c for c in rows if str(c.get("id")) == str(req["copy_from"])), None)
        if src is None:
            return {"ok": False, "issues": [{"campaign": "", "issue": f"no campaign '{req['copy_from']}' to copy"}]}
    row, problems = campaigns_mod.new_campaign(
        rows, name=str(req.get("name") or ""), tab=str(req.get("tab") or ""),
        fieldmap=str(req.get("fieldmap") or ""), cid=str(req.get("id") or ""), copy_from=src)
    if problems:
        return {"ok": False, "issues": [{"campaign": str(req.get("id") or ""), "issue": p} for p in problems]}
    body["campaigns"] = rows + [row]
    out = _write_campaigns_raw(body)
    out["campaign"] = row["id"]
    return out


def delete_campaign(cid: str) -> dict:
    """Remove a lane's configuration. Refused while it is running; its past runs, events and
    ledger rows keep the id they recorded."""
    cid = str(cid or "").strip()
    if any(j.get("status") == "running" and j.get("campaign") == cid for j in JOBS.values()):
        return {"ok": False, "issues": [{"campaign": cid, "issue": "it is running — stop the run first"}]}
    body = _read_campaigns_raw()
    rows, problem = campaigns_mod.remove_campaign(body.get("campaigns") or [], cid)
    if problem:
        return {"ok": False, "issues": [{"campaign": cid, "issue": problem}]}
    body["campaigns"] = rows
    out = _write_campaigns_raw(body)
    out["campaign"] = cid
    return out


def fieldmap_detail(tab: str = "") -> dict:
    """Everything the mapping screen needs: the engine's fields, what they are mapped to
    today, the sheet's real headers, and how full each column actually is.

    Fill rate matters — mapping to a column that is 0% filled looks correct and silently
    does nothing."""
    cfg = load_config()
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    lane = next((c for c in loaded["campaigns"] if not tab or c.tab == tab), None)
    if not lane:
        return {"error": f"No campaign uses tab '{tab}'."}
    try:
        rows = _read_tab(cfg, lane.tab)
    except Exception as e:  # noqa: BLE001
        return {"error": f"Could not read tab '{lane.tab}': {e}"}

    heads = runner_mod.headers_of(rows)
    sample = rows[:500]
    fill = {h: (sum(1 for r in sample if str(r.get(h) or "").strip()) * 100 //
                max(1, len(sample))) for h in heads}
    saved = loaded["fieldmaps"].get(lane.fieldmap or "") or fieldmap_mod.FieldMap({})
    auto = fieldmap_mod.suggest(heads)
    check = runner_mod.check_fieldmap(saved.completed(heads), heads)

    fields = []
    for f in fieldmap_mod.FIELDS:
        name = f["name"]
        mapped = saved.header(name)
        fields.append({
            "field": name, "direction": f["dir"], "required": f["required"],
            "recommended": name in fieldmap_mod.RECOMMENDED,
            "note": f.get("note", ""), "aliases": f["aliases"][:4],
            "mapped": mapped, "suggested": auto.get(name, ""),
            "resolved": check["resolved"].get(name, ""),
            "fill": fill.get(mapped or check["resolved"].get(name, ""), None),
        })
    used = {v for v in check["resolved"].values()}
    return {"tab": lane.tab, "file": lane.fieldmap, "rows": len(rows),
            "source": tab_source(cfg, lane.tab),
            "headers": [{"name": h, "fill": fill[h], "used": h in used} for h in heads],
            "fields": fields, "check": check, "preview": rows[:5]}


def save_fieldmap(name: str, mapping: dict) -> dict:
    fname = (name or "").strip() or "fieldmap.json"
    if not fname.endswith(".json") or "/" in fname or "\\" in fname:
        return {"ok": False, "error": "field-map name must be a plain .json filename"}
    path = CONFIG_DIR / fname
    body = _read_json(path, {})
    body["name"] = body.get("name") or fname
    body["mapping"] = {str(k): str(v) for k, v in (mapping or {}).items() if str(v).strip()}
    if path.exists():
        (CONFIG_DIR / (fname[:-5] + ".backup.json")).write_text(
            path.read_text(encoding="utf-8"), encoding="utf-8")
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "file": fname, "mapped": len(body["mapping"])}


def start_campaign_run(campaign_id: str, *, test_mode: bool = True) -> dict:
    """Enrich one campaign's next batch. The push is still a separate, confirmed step."""
    cfg = load_config()
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    camp = next((c for c in loaded["campaigns"] if c.id == campaign_id), None)
    if not camp:
        return {"error": f"No campaign '{campaign_id}' in config/campaigns.json."}
    if not camp.enabled:
        return {"error": f"Campaign '{campaign_id}' is disabled. Enable it in config/campaigns.json."}

    problems = [i["issue"] for i in campaigns_mod.validate([camp])]
    if problems:
        return {"error": "Campaign config problem: " + "; ".join(problems)}

    try:
        rows = _read_tab(cfg, camp.tab)
    except Exception as e:  # noqa: BLE001
        return {"error": f"Could not read tab '{camp.tab}': {e}"}

    heads = runner_mod.headers_of(rows)
    fm = runner_mod.fieldmap_for(camp, loaded["fieldmaps"], heads)
    check = runner_mod.check_fieldmap(fm, heads)
    if not check["ok"]:
        return {"error": "Field map problem: " + "; ".join(check["blocking"])}

    led = ledger_mod.Ledger(LEDGER_FILE) if cfg.get("use_ledger", True) else None
    prep = runner_mod.prepare(camp, rows, fm, ledger=led, cfg=cfg)
    firms = prep["firms"]
    if not firms:
        return {"error": f"'{campaign_id}' has no rows to work on right now "
                         f"({prep['matched']} matched, {prep['blocked_by_ledger']} already done, "
                         f"{prep['day_remaining']} left in today's limit)."}

    run_id = uuid.uuid4().hex[:12]
    job = {
        "run_id": run_id, "status": "running", "test_mode": bool(test_mode), "stage": "organize",
        "campaign": camp.id, "campaign_name": camp.name,
        "total": len(firms), "processed": 0, "results": [], "events": [], "_seq": 0,
        "counters": _new_counters(),
        "rates": {"mv_per_verification_usd": cfg.get("mv_per_verification_usd", 0.0),
                  "anymailfinder_usd_per_credit": cfg.get("anymailfinder_usd_per_credit", 0.0),
                  "icypeas_usd_per_credit": cfg.get("icypeas_usd_per_credit", 0.0)},
        "started": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "cancel": False,
        "skipped_done": prep["blocked_by_ledger"], "selection": {
            k: prep[k] for k in ("matched", "blocked_by_ledger", "available",
                                 "day_remaining", "selected")},
    }
    JOBS[run_id] = job
    _persist(job)
    threading.Thread(target=_worker, args=(run_id, firms, cfg),
                     kwargs={"campaign": camp, "fm": fm}, daemon=True).start()
    return _snapshot(job)


# ── Instantly push (outward-facing: gated by confirm + test mode) ────

ACCEPTED_VERIFICATIONS = {"good", "ok", "valid", "deliverable", "verified"}


def _is_send_ready(row: dict) -> bool:
    """THE SEND GATE: `send_ready = yes`, or a verification that actually passed.

    Only a MillionVerifier PASS opens it. An address a finder merely thought was
    'probable' has an email but no pass, and must never be sent."""
    if str(row.get("send_ready") or "").strip().lower() == "yes":
        return True
    if str(row.get("send_ready") or "").strip().lower() == "no":
        return False
    ver = str(row.get("verification") or row.get("Verification Status") or "").strip().lower()
    return ver in ACCEPTED_VERIFICATIONS


def _push_worker(push_id: str, rows: list[dict], cfg: dict, *, camp=None, fm=None) -> None:
    import time
    job = JOBS[push_id]
    test_mode = job["test_mode"]
    key = str(cfg.get("instantly_api_key", "")).strip()
    # the campaign's own Instantly id wins; the single config id is the V1 fallback
    campaign = (camp.instantly_campaign_id if camp else "") or \
        str(cfg.get("instantly_campaign_id", "")).strip()
    labels = (camp.labels or None) if camp else None
    options = runner_mod.push_options(camp) if camp else None
    camp_id = camp.id if camp else ""
    use_map = fm is not None and bool(fm.header("row_key"))
    delay = max(0, min(int(cfg.get("push_delay_seconds", 3) or 0), 60))
    writeback = bool(cfg.get("sheet_writeback"))
    write_row, pending = None, []

    def emit(company, stage, status, detail, email=""):
        ev = {"seq": job["_seq"], "ts": _now(), "company": company, "stage": stage,
              "status": status, "detail": detail, "email": email}
        job["_seq"] += 1
        job["events"].append(ev)
        if len(job["events"]) > FEED_WINDOW + 200:
            job["events"] = job["events"][-FEED_WINDOW:]
        job["stage"] = stage
        _append_event(push_id, ev)

    # one live sheet writer, so each pushed lead updates its Status row immediately
    # (same behaviour as n8n's per-item "Update Sheet" node)
    if not test_mode:
        write_row = _open_sheet_writer(cfg, emit, tab=(camp.tab if camp else ""), fm=fm)
    led = ledger_mod.Ledger(LEDGER_FILE) if cfg.get("use_ledger", True) else None

    # global daily send ceiling, across every campaign — the mailbox limit, not a
    # per-campaign one, so one lane cannot quietly eat the whole day's capacity
    loaded_globals = runner_mod.load_config_dir(CONFIG_DIR)["globals"]
    day_cap = int(loaded_globals.get("daily_push_cap") or 0)
    sent_today = led.count_today("push") if (led and day_cap and not test_mode) else 0

    for row in rows:
        if job.get("cancel"):
            break
        if day_cap and not test_mode and sent_today >= day_cap:
            emit("", "push", "skip",
                 f"global daily cap reached ({day_cap}) - stopping, the rest stay queued")
            break
        company = row.get("company", "")
        res = instantly_mod.push_lead(
            runner_mod.label_source_row(row) if camp else row,
            campaign, key, test_mode=test_mode,
            labels=labels, fm=fm, options=options,
            tries=max(1, int(cfg.get("api_tries", 3) or 1)),
            retry_wait=float(cfg.get("api_retry_wait", 5.0) or 0),
            on_retry=lambda a, n, e, p: emit(company, "push", "retry",
                                             f"attempt {a}/{n} failed ({e}) - retrying in {p:.0f}s"))
        if res.get("skipped"):
            job["counters"]["push_skipped"] += 1
            emit(company, "push", "skip", res.get("reason", "skipped"))
        elif res["ok"]:
            job["counters"]["pushed"] += 1
            emit(company, "push", "success",
                 f"{row.get('found_email', '')} → campaign{' (test)' if test_mode else ''}", row.get("found_email", ""))
            sent_today += 1
            job["results"].append({**row, "status": res["status"], "pushed": True})
            # same rule as the run: a dry run never records a real send
            if led:
                led.record({**row, "status": res["status"]}, pushed=True, fm=fm,
                           campaign=camp_id, test_mode=test_mode)
            if writeback:
                up = sheets_mod.build_writeback_row(row, res["status"])
                up = sheets_mod.to_sheet_row(up, fm) if use_map else up
                if write_row:
                    try:
                        w = write_row(up)                    # live: one row, right now
                        if w.get("ok"):
                            job["counters"]["written_back"] += 1
                            emit(company, "sheet", "success", f"Status → {res['status']} (row {w['row']})")
                        else:
                            emit(company, "sheet", "fail", f"write-back: {w.get('reason')}")
                    except Exception as e:  # noqa: BLE001 - never let a sheet error kill the push
                        pending.append(up)
                        emit(company, "sheet", "fail", f"write-back error, queued: {e}")
                else:
                    pending.append(up)
        else:
            job["counters"]["push_failed"] += 1
            job["counters"]["errors"] += 1
            emit(company, "push", "fail", str(res.get("error") or res.get("response") or "push failed"))
        job["processed"] += 1
        _persist(job)
        if delay and not test_mode:
            time.sleep(delay)

    # anything that couldn't be written live gets one batched retry at the end
    if writeback and pending and not test_mode:
        sa = str(cfg.get("sheet_service_account_file") or "").strip()
        parsed = sheets_mod.parse_sheet_url(cfg.get("sheet_url", ""))
        if sa and parsed["doc_id"]:
            try:
                out = sheets_mod.SheetsClient(sa).update_statuses(
                    parsed["doc_id"],
                    (camp.tab if camp else "") or cfg.get("sheet_tab") or "Combined", pending,
                    key_column=(fm.header("row_key") if use_map else "Company Name"),
                    allowed=(sheets_mod.writeback_headers(fm) if use_map else None))
                job["counters"]["written_back"] += out.get("updated", 0)
                emit("", "sheet", "success", f"retried {out.get('updated', 0)} queued rows")
            except Exception as e:  # noqa: BLE001
                emit("", "sheet", "fail", f"queued write-back failed: {e}")

    job["status"] = "cancelled" if job.get("cancel") else "finished"
    job["stage"] = "done"
    job["finished"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _persist(job)
    _append_history(job)            # so a push can be found again after leaving its page
    _prune_runs()


def start_push(run_id: str = "", *, test_mode: bool = True, confirm: bool = False) -> dict:
    """Push the verified leads of a finished run to Instantly. Requires an explicit
    confirm; a real (non-test) push also needs a key + campaign id."""
    if not confirm:
        return {"error": "Push not confirmed."}
    cfg = load_config()
    snap = get_run(run_id) if run_id else latest_run(kind="run")
    if not snap:
        return {"error": "No run to push. Do a Live run first."}

    # the campaign this run belonged to, if any — it carries the target id, the label
    # table and the Instantly options
    camp, fm = None, None
    camp_id = str(snap.get("campaign") or "").strip()
    if camp_id:
        loaded = runner_mod.load_config_dir(CONFIG_DIR)
        camp = next((c for c in loaded["campaigns"] if c.id == camp_id), None)
        if camp is None:
            return {"error": f"This run belonged to campaign '{camp_id}', which is no longer "
                             "in config/campaigns.json. Restore it before pushing."}
        fm = loaded["fieldmaps"].get(camp.fieldmap or "")

    found = [r for r in snap.get("results", []) if r.get("found_email")]
    if not found:
        return {"error": "That run has no verified emails to push."}
    # THE SEND GATE. Only a verification PASS may be sent. V1 pushed anything with an
    # address, which is how an unverified Icypeas "probable" would have gone out.
    rows = [r for r in found if _is_send_ready(r)]
    held = len(found) - len(rows)
    if not rows:
        return {"error": f"None of the {len(found)} addresses passed verification, so none "
                         "are send-ready. Nothing was pushed."}

    if not test_mode:
        if not str(cfg.get("instantly_api_key", "")).strip():
            return {"error": "Add your Instantly API key in Settings before a live push."}
        target = (camp.instantly_campaign_id if camp else "") or \
            str(cfg.get("instantly_campaign_id", "")).strip()
        if not target:
            return {"error": ("Campaign '%s' has no instantly.campaign_id in "
                              "config/campaigns.json." % camp.id) if camp else
                             "Add your Instantly campaign id in Settings before a live push."}
    push_id = uuid.uuid4().hex[:12]
    job = {
        "run_id": push_id, "kind": "push", "source_run": snap.get("run_id"),
        "status": "running", "test_mode": bool(test_mode), "stage": "push",
        "total": len(rows), "processed": 0, "results": [], "events": [], "_seq": 0,
        "counters": _new_counters(),
        "rates": {"mv_per_verification_usd": cfg.get("mv_per_verification_usd", 0.0),
                  "anymailfinder_usd_per_credit": cfg.get("anymailfinder_usd_per_credit", 0.0),
                  "icypeas_usd_per_credit": cfg.get("icypeas_usd_per_credit", 0.0)},
        "started": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "cancel": False,
    }
    job["campaign"] = camp.id if camp else ""
    job["campaign_name"] = camp.name if camp else snap.get("campaign_name", "")
    job["held_not_send_ready"] = held
    JOBS[push_id] = job
    _persist(job)
    threading.Thread(target=_push_worker, args=(push_id, rows, cfg),
                     kwargs={"camp": camp, "fm": fm}, daemon=True).start()
    return _snapshot(job)


# ── Windows Task Scheduler (fixed commands, validated numbers only) ──

TASK_NAME = "LeadGenAutomationEngine"


def _schtasks(args: list[str]) -> dict:
    import subprocess
    try:
        p = subprocess.run(["schtasks"] + args, capture_output=True, text=True, timeout=25)
        return {"ok": p.returncode == 0, "out": (p.stdout or "").strip(), "err": (p.stderr or "").strip()}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "out": "", "err": str(e)}


def schedule_status() -> dict:
    r = _schtasks(["/query", "/tn", TASK_NAME, "/fo", "LIST"])
    if not r["ok"]:
        return {"scheduled": False, "task": TASK_NAME}
    info = {}
    for line in r["out"].splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            info[k.strip()] = v.strip()
    return {"scheduled": True, "task": TASK_NAME,
            "next_run": info.get("Next Run Time", ""), "status": info.get("Status", ""),
            "last_run": info.get("Last Run Time", "")}


_HHMM = r"([01]\d|2[0-3]):[0-5]\d"
WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]


def _schedule_args(kind: str, every: int, start: str, end: str, days: list[str]) -> tuple[list[str], dict, str]:
    """Translate a trigger choice into schtasks flags. Returns (flags, summary, error).
    Every value is validated here - nothing is interpolated into a shell string."""
    kind = (kind or "minute").lower().strip()
    if not re.fullmatch(_HHMM, str(start or "")):
        return [], {}, "Start time must be HH:MM (24h)."

    if kind == "minute":
        n = max(1, min(int(every or 30), 1439))
        if not re.fullmatch(_HHMM, str(end or "")):
            return [], {}, "End time must be HH:MM (24h)."
        return (["/sc", "minute", "/mo", str(n), "/st", start, "/et", end],
                {"summary": f"every {n} min, {start}–{end}"}, "")

    if kind == "hourly":
        n = max(1, min(int(every or 1), 23))
        args = ["/sc", "hourly", "/mo", str(n), "/st", start]
        summary = f"every {n} hour{'s' if n > 1 else ''} from {start}"
        if str(end or "").strip():
            if not re.fullmatch(_HHMM, str(end)):
                return [], {}, "End time must be HH:MM (24h)."
            args += ["/et", end]
            summary += f" until {end}"
        return args, {"summary": summary}, ""

    if kind == "daily":
        n = max(1, min(int(every or 1), 365))
        return (["/sc", "daily", "/mo", str(n), "/st", start],
                {"summary": f"every {n} day{'s' if n > 1 else ''} at {start}"}, "")

    if kind == "weekly":
        picked = [d.upper() for d in (days or []) if d.upper() in WEEKDAYS]
        if not picked:
            return [], {}, "Pick at least one weekday."
        n = max(1, min(int(every or 1), 52))
        return (["/sc", "weekly", "/mo", str(n), "/d", ",".join(picked), "/st", start],
                {"summary": f"{', '.join(picked)} at {start}" + (f" every {n} weeks" if n > 1 else "")}, "")

    return [], {}, f"Unknown trigger type '{kind}'."


def schedule_create(every_minutes: int = 30, start: str = "08:00", end: str = "17:30",
                    test_mode: bool = True, from_sheet: bool = False, push: bool = False,
                    kind: str = "minute", days: list[str] | None = None) -> dict:
    """Register the trigger. kind = minute | hourly | daily | weekly (n8n-style choices);
    V7's own cadence is minute/30 between 08:00 and 17:30."""
    args, info, err = _schedule_args(kind, every_minutes, start, end, days or [])
    if err:
        return {"ok": False, "error": err}
    flags = ""
    if test_mode:
        flags += " --test"
    if from_sheet:
        flags += " --from-sheet"
    if push:
        flags += " --push"
    runner = ROOT / "run-scheduled.bat"
    runner.write_text(
        "@echo off\r\n"
        f'cd /d "{ROOT}"\r\n'
        'set "PY=C:\\ClaudeDeps\\docpipeline-venv\\Scripts\\python.exe"\r\n'
        'if not exist "%PY%" set "PY=python"\r\n'
        f'"%PY%" scheduled_run.py{flags} >> "{ROOT / "data" / "scheduled.log"}" 2>&1\r\n',
        encoding="utf-8")
    r = _schtasks(["/create", "/tn", TASK_NAME, "/tr", f'"{runner}"'] + args + ["/f"])
    if not r["ok"]:
        return {"ok": False, "error": r["err"] or r["out"] or "schtasks failed"}
    return {"ok": True, "kind": kind, "summary": info.get("summary", ""),
            "test_mode": test_mode, "from_sheet": from_sheet, "push": push, **schedule_status()}


def schedule_delete() -> dict:
    r = _schtasks(["/delete", "/tn", TASK_NAME, "/f"])
    return {"ok": r["ok"], "error": "" if r["ok"] else (r["err"] or r["out"])}


def latest_run(kind: str | None = None) -> dict | None:
    """Newest job. kind="run" skips push jobs, so the Dashboard keeps showing the
    enrichment run (and its credits) after you push."""
    live = [j for j in JOBS.values() if kind is None or j.get("kind", "run") == kind]
    if live:
        return _snapshot(max(live, key=lambda j: j["started"]))
    files = sorted(RUNS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for fp in files:
        rec = _read_json(fp, None)
        if rec and (kind is None or rec.get("kind", "run") == kind):
            return get_run(fp.stem)
    return None


def get_run(run_id: str, since: int = 0) -> dict | None:
    if run_id in JOBS:
        return _snapshot(JOBS[run_id], since)
    rec = _read_json(_run_file(run_id), None)
    if not rec:
        return None
    rec["events"] = _read_events(run_id, since, limit=FEED_WINDOW)
    rec["credits"] = _credit_breakdown(load_config(), rec.get("counters", {}).get("credits", {}))
    return rec


# ───────────────────────── FastAPI ─────────────────────────

app = FastAPI(title="Lead Gen Automation Engine")


@app.middleware("http")
async def no_cache(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


# The screens are a separate Next.js app (web/) on their own port, which passes /api through
# to this engine. The V1 interface is untouched and stays reachable at /legacy — it is the
# fallback if anything about the new one misbehaves.
SCREENS_URL = os.environ.get("LEADGEN_SCREENS_URL", "http://127.0.0.1:3200/")


@app.get("/", response_class=HTMLResponse)
def index():
    # a page, not a redirect: if the screens are not running, a redirect lands on a browser
    # error that says nothing about why, or that /legacy still works
    return (
        "<body style=\"font:15px system-ui;max-width:38rem;margin:12vh auto;padding:0 1.5rem;"
        "line-height:1.6\"><h1>This is the engine</h1>"
        f"<p>The screens are at <a href=\"{SCREENS_URL}\">{SCREENS_URL}</a>. "
        "<code>start-app.bat</code> starts both.</p>"
        "<p><a href=\"/legacy\">Open the original interface instead &rarr;</a></p></body>"
    )


@app.get("/legacy", response_class=HTMLResponse)
def legacy_index():
    """The V1 interface, kept working so there is always a way back."""
    return (WEBAPP_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/style.css")
def style():
    return FileResponse(WEBAPP_DIR / "style.css", media_type="text/css")


@app.get("/app.js")
def appjs():
    return FileResponse(WEBAPP_DIR / "app.js", media_type="application/javascript")


@app.get("/api/config")
def api_get_config():
    cfg = dict(load_config())
    cfg["has_api_key"] = bool(_mv_key(cfg))
    cfg["keys_set"] = {f: bool(str(cfg.get(f, "")).strip()) for f in _KEY_FIELDS}
    for f in _KEY_FIELDS:                       # never send a real key to the browser
        v = str(cfg.get(f, ""))
        cfg[f] = ("*" * 6 + v[-4:]) if v else ""
    return cfg


@app.post("/api/config")
async def api_save_config(request: Request):
    patch = await request.json()
    for f in _KEY_FIELDS:                       # don't save the masked value back over a real key
        v = patch.get(f)
        if isinstance(v, str) and "*" in v:
            patch.pop(f, None)
    for bk in _BOOL_KEYS:
        if bk in patch:
            patch[bk] = bool(patch[bk])
    cfg = save_config(patch)
    return {"ok": True, "has_api_key": bool(_mv_key(cfg))}


@app.post("/api/leads/upload")
async def api_upload(files: list[UploadFile] = File(...)):
    cfg = load_config()
    all_rows: list[dict] = []
    names = []
    for f in files:
        raw = await f.read()
        (UPLOADS_DIR / f.filename).write_bytes(raw)
        all_rows.extend(_rows_from_csv_bytes(raw))
        names.append(f.filename)
    result = organize_mod.organize(all_rows, owned_companies=cfg.get("owned_companies"),
                                   owned_domains=cfg.get("owned_domains"),
                                   strict_status=bool(cfg.get("strict_status", True)))
    _attach_v7_fields(all_rows, result["firms"])
    payload = {"firms": result["firms"], "skipped": result["skipped"], "count": result["count"],
               "files": names, "rows_in": len(all_rows),
               "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
    _write_json(LEADS_FILE, payload)
    return _leads_view(payload)


@app.get("/api/leads")
def api_leads():
    return _leads_view(_read_json(LEADS_FILE, {}))


@app.post("/api/leads/clear")
def api_leads_clear():
    _write_json(LEADS_FILE, {})
    return {"ok": True}


@app.post("/api/run/start")
async def api_run_start(request: Request):
    body = await request.json()
    return JSONResponse(start_run(bool(body.get("test_mode", True))))


@app.get("/api/run/status")
def api_run_status(run_id: str = "", since: int = 0):
    snap = get_run(run_id, since) if run_id else latest_run(kind="run")
    return snap or {"status": "none"}


@app.post("/api/run/cancel")
async def api_run_cancel(request: Request):
    rid = (await request.json()).get("run_id")
    if rid in JOBS:
        JOBS[rid]["cancel"] = True
        return {"ok": True}
    return {"ok": False}


@app.get("/api/dashboard")
def api_dashboard(run_id: str = ""):
    snap = get_run(run_id) if run_id else latest_run(kind="run")
    if not snap:
        return {"status": "none"}
    results = snap.get("results", [])
    found = sum(1 for r in results if r.get("found_email"))
    iced = sum(1 for r in results if r.get("icebreaker"))
    status_counts = Counter(r.get("status", "") for r in results)
    pushed = sum(1 for r in results if r.get("pushed"))
    if not pushed:                        # enrichment runs don't push - take it from the ledger
        pushed = ledger_mod.Ledger(LEDGER_FILE).stats().get("pushed", 0)
    return {
        "run_id": snap.get("run_id"), "status": snap.get("status"), "when": snap.get("started"),
        "total": snap.get("total", 0), "processed": snap.get("processed", 0),
        "found": found, "verified": found, "pushed": pushed,
        "held": snap.get("counters", {}).get("held", 0),
        "credits": snap.get("credits"),
        "funnel": [
            {"label": "Organized", "value": snap.get("total", 0)},
            {"label": "Email found", "value": found},
            {"label": "Verified", "value": found},
            {"label": "Icebreaker", "value": iced},
            {"label": "Pushed", "value": pushed, "final": True},
        ],
        "status_breakdown": sorted(status_counts.items(), key=lambda kv: -kv[1]),
    }


def _results_csv(snap: dict) -> str:
    """Test-mode rows carry a SIMULATED column, because those addresses were generated
    from a name pattern and never checked against a mail server - mailing them would
    bounce and damage sending reputation."""
    sim = bool(snap.get("test_mode"))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow((["SIMULATED"] if sim else []) +
               ["Company", "Domain", "Selected Director", "Found Email", "Email Source",
                "Verification", "Status", "Ice Breaker", "Ice Style",
                "Oldest Director", "Director 2", "Director 3", "Phone", "City"])
    for r in snap.get("results", []):
        w.writerow((["NOT VERIFIED - test run"] if sim else []) +
                   [r.get("company"), r.get("domain"), r.get("selected_director"), r.get("found_email"),
                    r.get("email_source"), r.get("verification"), r.get("status"),
                    r.get("icebreaker"), r.get("ice_style"),
                    r.get("Oldest Director Name"), r.get("Director 2 Name"), r.get("Director 3 Name"),
                    r.get("phone"), r.get("city")])
    return buf.getvalue()


@app.get("/api/results")
def api_results(run_id: str = ""):
    snap = get_run(run_id) if run_id else latest_run(kind="run")
    return snap or {"status": "none"}


@app.get("/api/results/download")
def api_results_download(run_id: str = ""):
    snap = get_run(run_id) if run_id else latest_run(kind="run")
    if not snap:
        return PlainTextResponse("no results", status_code=404)
    prefix = "SIMULATED-" if snap.get("test_mode") else ""
    fname = f"{prefix}leads-{snap.get('run_id', 'run')}.csv"
    return Response(content=_results_csv(snap), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


def _iter_run_meta():
    """(run_id, started) for the live jobs then recent files, newest first, de-duped."""
    seen = set()
    for j in sorted(JOBS.values(), key=lambda j: j["started"], reverse=True):
        seen.add(j["run_id"]); yield j["run_id"], j["started"], j
    files = sorted(RUNS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for fp in files:
        rid = fp.stem
        if rid in seen:
            continue
        rec = _read_json(fp, None)
        yield rid, (rec or {}).get("started", ""), None


def _all_events(run_id: str = "", cap: int = LOG_SCAN_CAP) -> list[dict]:
    out = []
    for rid, started, job in _iter_run_meta():
        if run_id and rid != run_id:
            continue
        evs = list(job["events"]) if job else _read_events(rid)
        for e in reversed(evs):
            out.append({**e, "run_id": rid, "when": started})
            if len(out) >= cap:
                return out
    return out


@app.get("/api/log")
def api_log(filter: str = "all", search: str = "", run_id: str = "", limit: int = 300):
    events = _all_events(run_id)
    counts = Counter(e["status"] for e in events)
    fl = (filter or "all").lower()
    status_map = {"success": {"success"}, "failed": {"fail"}, "held": {"held"}, "skipped": {"skip"}}
    view = events
    if fl in status_map:
        view = [e for e in view if e["status"] in status_map[fl]]
    if search:
        s = search.lower()
        view = [e for e in view if s in (e.get("company", "") + " " + e.get("detail", "") + " " + e.get("email", "")).lower()]
    return {"events": view[:limit], "total": len(view), "scanned": len(events),
            "counts": {"success": counts.get("success", 0), "failed": counts.get("fail", 0),
                       "held": counts.get("held", 0), "skipped": counts.get("skip", 0)}}


@app.get("/api/log/download")
def api_log_download(run_id: str = ""):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Run", "When", "Time", "Company", "Stage", "Status", "Detail", "Email"])
    for e in _all_events(run_id, cap=1_000_000):
        w.writerow([e.get("run_id"), e.get("when"), e.get("ts"), e.get("company"),
                    e.get("stage"), e.get("status"), e.get("detail"), e.get("email")])
    return Response(content=buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="event-log.csv"'})


@app.get("/api/history")
def api_history():
    return {"runs": _read_json(HISTORY_FILE, [])}


# ── Phase 3 endpoints ────────────────────────────────────────────────

@app.post("/api/sheets/load")
def api_sheets_load():
    try:
        return load_leads_from_sheet()
    except Exception as e:  # noqa: BLE001 - surface the reason to the UI
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/api/push/preview")
def api_push_preview(run_id: str = ""):
    """What a push would send - shown for confirmation BEFORE anything goes out.

    Campaign-aware: it previews the lane's OWN target id, its label table and its Instantly
    options, and it applies the same send gate the push does, so what you see here is
    exactly what would leave the machine."""
    cfg = load_config()
    snap = get_run(run_id) if run_id else latest_run(kind="run")
    if not snap:
        return {"status": "none", "ready": 0, "leads": []}

    camp, fm, labels, options = None, None, None, None
    camp_id = str(snap.get("campaign") or "").strip()
    if camp_id:
        loaded = runner_mod.load_config_dir(CONFIG_DIR)
        camp = next((c for c in loaded["campaigns"] if c.id == camp_id), None)
        if camp:
            fm = loaded["fieldmaps"].get(camp.fieldmap or "")
            labels = camp.labels or None
            options = runner_mod.push_options(camp)

    found = [r for r in snap.get("results", []) if r.get("found_email")]
    rows = [r for r in found if _is_send_ready(r)]
    campaign = (camp.instantly_campaign_id if camp else "") or \
        str(cfg.get("instantly_campaign_id", "")).strip()
    return {
        "run_id": snap.get("run_id"), "ready": len(rows),
        "found": len(found), "held_not_send_ready": len(found) - len(rows),
        "campaign": camp_id, "campaign_name": snap.get("campaign_name") or "",
        "has_key": bool(str(cfg.get("instantly_api_key", "")).strip()),
        "campaign_id": campaign, "delay": cfg.get("push_delay_seconds", 3),
        "writeback": bool(cfg.get("sheet_writeback")),
        "leads": [instantly_mod.build_payload(
            runner_mod.label_source_row(r) if camp else r,
            campaign or "<campaign id not set>",
            labels=labels, fm=fm, options=options) for r in rows[:25]],
    }


@app.post("/api/push/start")
async def api_push_start(request: Request):
    body = await request.json()
    return JSONResponse(start_push(body.get("run_id", ""),
                                   test_mode=bool(body.get("test_mode", True)),
                                   confirm=bool(body.get("confirm", False))))


@app.get("/api/ledger")
def api_ledger():
    led = ledger_mod.Ledger(LEDGER_FILE)
    s = led.stats()
    s["recent"] = led.recent(25)
    return s


@app.post("/api/ledger/clear")
def api_ledger_clear():
    ledger_mod.Ledger(LEDGER_FILE).clear()
    return {"ok": True}


@app.get("/api/icebreaker")
def api_icebreaker_get():
    cfg = load_config()
    saved = cfg.get("icebreaker_templates") or {}
    return {"defaults": icebreaker_mod.DEFAULT_TEMPLATES,
            "templates": {**icebreaker_mod.DEFAULT_TEMPLATES, **saved},
            "customised": sorted(k for k, v in saved.items()
                                 if str(v).strip() != icebreaker_mod.DEFAULT_TEMPLATES.get(k, "")),
            "placeholders": sorted(icebreaker_mod.PLACEHOLDERS)}


@app.post("/api/icebreaker/preview")
async def api_icebreaker_preview(request: Request):
    b = await request.json()
    templates = b.get("templates") or {}
    problems = icebreaker_mod.validate_templates({**icebreaker_mod.DEFAULT_TEMPLATES, **templates})
    firms = _read_json(LEADS_FILE, {}).get("firms", [])
    samples = firms[:5] or [{"Company Name": "Smith & Co", "lead_director": "Ian Smith"}]
    out = []
    for mode, extra in (("offer", {}),
                        ("delivered", {"audit_mode": "delivered",
                                       "audit_opener_data": b.get("sample_finding") or "your site is slow to load on mobile"}),
                        ("clean", {"audit_mode": "clean", "audit_perf_score": "95"})):
        for f in samples[:3] if mode == "offer" else samples[:1]:
            ib = icebreaker_mod.build({**f, **extra}, f.get("found_email", ""), templates)
            out.append({"mode": mode, "style": ib["style"],
                        "company": f.get("Company Name", ""), "text": ib["text"]})
    return {"problems": problems, "previews": out}


@app.post("/api/icebreaker")
async def api_icebreaker_save(request: Request):
    b = await request.json()
    templates = {k: str(v) for k, v in (b.get("templates") or {}).items()
                 if k in icebreaker_mod.DEFAULT_TEMPLATES}
    problems = icebreaker_mod.validate_templates({**icebreaker_mod.DEFAULT_TEMPLATES, **templates})
    if problems:
        return JSONResponse({"ok": False, "problems": problems}, status_code=400)
    save_config({"icebreaker_templates": templates})
    return {"ok": True}


@app.post("/api/icebreaker/reset")
def api_icebreaker_reset():
    save_config({"icebreaker_templates": {}})
    return {"ok": True, "templates": icebreaker_mod.DEFAULT_TEMPLATES}


@app.get("/api/schedule")
def api_schedule():
    return schedule_status()


@app.post("/api/schedule/create")
async def api_schedule_create(request: Request):
    b = await request.json()
    return schedule_create(every_minutes=int(b.get("every", b.get("every_minutes", 30)) or 30),
                           start=str(b.get("start", "08:00")), end=str(b.get("end", "17:30")),
                           test_mode=bool(b.get("test_mode", True)),
                           from_sheet=bool(b.get("from_sheet", False)),
                           push=bool(b.get("push", False)),
                           kind=str(b.get("kind", "minute")),
                           days=b.get("days") or [])


@app.post("/api/schedule/delete")
def api_schedule_delete():
    return schedule_delete()


# ── campaigns ────────────────────────────────────────────────────────

@app.get("/api/campaigns")
def api_campaigns():
    return campaigns_view()


@app.get("/api/plan")
def api_plan(all: bool = False):
    """The free preview. Reads the sheet and applies the rules; spends nothing."""
    return build_plan(enabled_only=not all)


@app.get("/api/fieldmap")
def api_fieldmap(tab: str = ""):
    """Validate a tab's field map against the sheet's real header, before any spend."""
    cfg = load_config()
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    lane = next((c for c in loaded["campaigns"] if not tab or c.tab == tab), None)
    if not lane:
        return {"error": f"No campaign uses tab '{tab}'."}
    try:
        rows = _read_tab(cfg, lane.tab)
    except Exception as e:  # noqa: BLE001
        return {"error": f"Could not read tab '{lane.tab}': {e}"}
    heads = runner_mod.headers_of(rows)
    fm = runner_mod.fieldmap_for(lane, loaded["fieldmaps"], heads)
    out = runner_mod.check_fieldmap(fm, heads)
    out.update({"tab": lane.tab, "rows": len(rows), "mapping": fm.to_dict()})
    return out


@app.get("/api/campaigns/detail")
def api_campaign_detail(id: str):
    """The raw config for one campaign — what the editor drawer loads."""
    body = _read_campaigns_raw()
    row = next((c for c in (body.get("campaigns") or []) if str(c.get("id")) == id), None)
    if row is None:
        return {"error": f"No campaign '{id}'."}
    c = campaigns_mod.Campaign(row)
    return {"campaign": row, "issues": campaigns_mod.validate([c]),
            "label_issues": instantly_mod.validate_label_specs(c.labels or None),
            "operators": sorted(rules_mod.OPS), "value_less": sorted(rules_mod.VALUE_LESS),
            "derived": sorted(instantly_mod.DERIVED), "label_types": list(instantly_mod.LABEL_TYPES)}


@app.post("/api/campaigns/save")
async def api_campaign_save(request: Request):
    return save_campaign(await request.json())


@app.post("/api/campaigns/globals")
async def api_campaign_globals(request: Request):
    return save_globals(await request.json())


@app.post("/api/campaigns/create")
async def api_campaign_create(request: Request):
    return create_campaign(await request.json())


@app.post("/api/campaigns/delete")
async def api_campaign_delete(request: Request):
    return delete_campaign(str((await request.json()).get("id") or ""))


@app.get("/api/fieldmap/detail")
def api_fieldmap_detail(tab: str = ""):
    return fieldmap_detail(tab)


@app.post("/api/fieldmap/save")
async def api_fieldmap_save(request: Request):
    b = await request.json()
    return save_fieldmap(str(b.get("file") or ""), b.get("mapping") or {})


@app.post("/api/campaign/run")
async def api_campaign_run(request: Request):
    b = await request.json()
    return start_campaign_run(str(b.get("campaign") or ""),
                              test_mode=bool(b.get("test_mode", True)))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8771)
