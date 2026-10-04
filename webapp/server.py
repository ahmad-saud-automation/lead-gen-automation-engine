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
from contextlib import asynccontextmanager
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
from core import imports as imports_mod  # noqa: E402
from core import schedules as schedules_mod  # noqa: E402
from core import auth as auth_mod  # noqa: E402
from core import connections as conn_mod  # noqa: E402

WEBAPP_DIR = Path(__file__).resolve().parent
CONFIG_DIR = ROOT / "config"
DATA = ROOT / "data"
RUNS_DIR = DATA / "runs"
UPLOADS_DIR = DATA / "uploads"
IMPORTS_DIR = DATA / "imports"          # CSVs registered as `import:<slug>` tabs (V4 F)
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
    # campaign lanes send Icebreaker Studio's line only; a lead whose sheet row has none yet
    # is held back from the push instead of going out unpersonalised
    "hold_without_icebreaker": True,
}
_BOOL_KEYS = {"use_endole", "verify_endole_with_mf", "use_patterns", "use_icypeas",
              "use_anymailfinder", "verify_icypeas_with_mf", "verify_anymailfinder_with_mf",
              "use_icebreaker", "use_openai_echo", "accept_catchall", "block_security_gateways",
              "sheet_writeback", "strict_status", "use_ledger", "retry_not_found",
              "hold_without_icebreaker"}
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
    # a test run's checks are simulated (no API call), so they cost nothing: pricing its
    # counters showed made-up spend on runs that never left the machine (found 2026-10-04)
    if job.get("test_mode"):
        return _credit_breakdown(job["rates"], {})
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
        if campaign is not None:
            # a lane sends Icebreaker Studio's line from the sheet, never one of ours
            line = runner_mod.sheet_icebreaker(firm, fm)
            if not line:
                emit(firm.get("Company Name", ""), "icebreaker", "skip",
                     "no Icebreaker Studio line on the sheet yet")
            return {"text": line, "style": "studio" if line else ""}
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
    elif campaign is not None and not tab_source(cfg, campaign.tab)["live"]:
        emit("", "sheet", "skip", f"'{campaign.tab}' is a file, not the live sheet - nothing is written back")
    elif campaign is not None and not _lane_writes_back(campaign):
        emit("", "sheet", "skip", "this campaign's 'Update my Google Sheet' is off - nothing is written back")
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
                up = sheets_mod.build_writeback_row(row, row["status"], write_icebreaker=campaign is None)
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


def _lane_writes_back(camp) -> bool:
    """A campaign's own "Update my Google Sheet" switch (`writeback.enabled`, on unless set to
    false). Until 2026-10-05 the editor saved it but nothing read it: only the global
    `sheet_writeback` counted, so switching it off for one campaign changed nothing. Both must
    now be on for a write."""
    return (camp.writeback or {}).get("enabled", True) is not False


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
    sheet, so it must never be silently in effect.

    An uploaded CSV (`import:<slug>`) has no sheet at all: it is never written back."""
    if imports_mod.is_import_tab(tab):
        p = imports_mod.path_for(IMPORTS_DIR, tab)
        return {"kind": "import", "path": str(p or ""), "live": False}
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
    if imports_mod.is_import_tab(tab):
        p = imports_mod.path_for(IMPORTS_DIR, tab)
        if p is None or not p.exists():
            raise ValueError(f"'{tab}' is not an uploaded file any more — upload it again on Import")
        return _rows_from_csv_bytes(p.read_bytes())
    local =str((cfg.get("local_tabs") or {}).get(tab) or "").strip()
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


_TAB_CACHE: dict[tuple, tuple[float, list[dict]]] = {}
_TAB_LOCKS: dict[tuple, threading.Lock] = {}
_TAB_LOCKS_GUARD = threading.Lock()
TAB_CACHE_SECONDS = 60


def _read_tab_for_display(cfg: dict, tab: str) -> list[dict]:
    """`_read_tab` for screens that only SHOW counts (previews, the checklist, column matching).

    The campaign page asks for counts, the checklist and the column list at once, and each one
    read all 21,714 rows of the sheet from Google: ~15 s before anything appeared (measured
    2026-10-05). They now share ONE read, kept for a minute; requests that arrive during that
    read wait for it instead of starting their own. Runs and sends never use this — they always
    read the sheet fresh."""
    src = tab_source(cfg, tab)
    key = (tab, src["kind"], src.get("path", ""), cfg.get("sheet_url", ""))
    with _TAB_LOCKS_GUARD:
        lock = _TAB_LOCKS.setdefault(key, threading.Lock())
    with lock:
        hit = _TAB_CACHE.get(key)
        if hit and time.time() - hit[0] < TAB_CACHE_SECONDS:
            return hit[1]
        rows = _read_tab(cfg, tab)
        _TAB_CACHE[key] = (time.time(), rows)
        return rows


def campaigns_view() -> dict:
    """Every campaign, plus any config problem that would stop a run."""
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    camps = loaded["campaigns"]
    state = _read_json(SCHEDULE_STATE, {})
    return {
        "globals": loaded["globals"],
        "issues": campaigns_mod.validate(camps),
        "windows_available": windows_available(),
        "campaigns": [{
            "schedule": {k: v for k, v in lane_schedule_view(c, state).items() if k != "schedule"}
            | {k: schedules_mod.normalize(c.schedule)[0][k] for k in ("via", "test_mode")},
            "id": c.id, "name": c.name, "enabled": c.enabled, "priority": c.priority,
            "tab": c.tab, "fieldmap": c.fieldmap,
            "per_run": c.per_run, "per_day": c.per_day,
            "max_spend_usd": c.max_spend_usd,
            "instantly_campaign_id": c.instantly_campaign_id,
            "labels": len(c.labels), "auto_push": c.auto_push,
            "rule_count": sum(len(c.rules.get(b) or []) for b in ("all", "any", "none")),
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
            rows = _read_tab_for_display(cfg, tab)
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
    if out.get("ok"):
        lane_task_delete(cid)                   # its Windows task would fire a lane that is gone
    return out


def import_fieldmap_file(tab: str) -> str:
    """The field-map file an upload's lanes use: one per upload, named after it, so mapping
    one CSV's columns never changes another's."""
    return f"fieldmap.{tab[len(imports_mod.PREFIX):]}.json"


def fieldmap_detail(tab: str = "") -> dict:
    """Everything the mapping screen needs: the engine's fields, what they are mapped to
    today, the sheet's real headers, and how full each column actually is.

    Fill rate matters — mapping to a column that is 0% filled looks correct and silently
    does nothing."""
    cfg = load_config()
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    lane = next((c for c in loaded["campaigns"] if not tab or c.tab == tab), None)
    if not lane and imports_mod.is_import_tab(tab):
        # an upload nobody reads yet: show its columns against an unsaved, auto-matched map,
        # so it can be checked before a lane is made for it
        lane = campaigns_mod.Campaign({"id": "", "tab": tab, "fieldmap": import_fieldmap_file(tab)})
        loaded["fieldmaps"][lane.fieldmap] = fieldmap_mod.load(CONFIG_DIR / lane.fieldmap)
    if not lane:
        return {"error": f"No campaign uses tab '{tab}'."}
    try:
        rows = _read_tab_for_display(cfg, lane.tab)
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
    # A switched-off campaign may still do a FREE test (no API call, no ledger, no sheet write),
    # so a new campaign can be tried before it is turned on. A live run needs it on.
    if not camp.enabled and not test_mode:
        return {"error": f"'{camp.name}' is switched off. Switch it on before a live run "
                         "(a free test works while it is off)."}
    # a click and a schedule (or two clicks) must not work the same rows twice at once
    if any(j.get("status") == "running" and j.get("campaign") == camp.id for j in JOBS.values()):
        return {"error": f"'{camp.name}' is already running. Wait for it to finish, or stop it."}

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
    if camp is not None and not tab_source(cfg, camp.tab)["live"]:
        # an uploaded CSV or a local snapshot: there is no sheet row to update
        writeback = False
        if not test_mode:
            emit("", "sheet", "skip", f"'{camp.tab}' is a file, not the live sheet - nothing is written back")
    elif camp is not None and not _lane_writes_back(camp):
        writeback = False
        if not test_mode:
            emit("", "sheet", "skip", "this campaign's 'Update my Google Sheet' is off - nothing is written back")
    elif not test_mode:
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
                # the Ice Breaker column is Icebreaker Studio's: a lane never writes it
                up = sheets_mod.build_writeback_row(row, res["status"], write_icebreaker=camp is None)
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


def _lane_icebreakers(cfg: dict, camp, fm, rows: list[dict]) -> tuple[list[dict], list[dict], str]:
    """A lane's send-ready rows carrying Icebreaker Studio's CURRENT line
    -> (ready, waiting for a line, note).

    The live tab is read again (free, no API spend): Studio may have written lines since
    the run. If the sheet cannot be read, the lines the run saw are used and the note says
    so. The push and its preview both call this, so what is previewed is what is sent."""
    note = ""
    try:
        rows = runner_mod.refresh_icebreakers(rows, _read_tab(cfg, camp.tab), fm)
    except Exception as e:  # noqa: BLE001 - an unreadable sheet falls back to the run's lines
        rows = runner_mod.refresh_icebreakers(rows, [], fm)
        note = f"Could not re-read the sheet ({e}), so these are the lines the run saw."
    if not cfg.get("hold_without_icebreaker", True):
        return rows, [], note
    ready, waiting = runner_mod.split_by_icebreaker(rows)
    return ready, waiting, note


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
    if camp is not None:
        rows, waiting, _note = _lane_icebreakers(cfg, camp, fm, rows)
        if not rows:
            return {"error": f"None of the {len(waiting)} send-ready leads has an Icebreaker "
                             "Studio line on the sheet yet, so none were pushed. Run Icebreaker "
                             "Studio for them, or switch off 'Hold leads without an ice "
                             "breaker' in Settings."}

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


# ── per-campaign schedules (V4 G): the engine's own clock OR one Windows task per lane ──
#
# `schedule.via` picks the ONE trigger that fires a lane, so it never runs twice. The app
# clock works on any server (Linux included); a Windows task also runs while the app is shut.

SCHEDULE_STATE = DATA / "schedule_state.json"    # last slot fired per lane: no double fire
SCHEDULE_LOG = DATA / "schedule.log"
TASKS_DIR = DATA / "tasks"                       # the .bat each Windows task starts
LANE_TASK_PREFIX = "LeadGen-"
TICK_SECONDS = 30
_SCHED_LOCK = threading.Lock()


def windows_available() -> bool:
    return os.name == "nt"


def _sched_log(msg: str) -> None:
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  {msg}\n"
    try:
        with SCHEDULE_LOG.open("a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass


def _lane_task_name(cid: str) -> str:
    return LANE_TASK_PREFIX + cid


def lane_task_status(cid: str) -> dict:
    if not windows_available():
        return {"exists": False}
    r = _schtasks(["/query", "/tn", _lane_task_name(cid), "/fo", "LIST"])
    if not r["ok"]:
        return {"exists": False}
    info = dict((k.strip(), v.strip()) for k, _s, v in
                (ln.partition(":") for ln in r["out"].splitlines() if ":" in ln))
    return {"exists": True, "name": _lane_task_name(cid), "next_run": info.get("Next Run Time", ""),
            "last_run": info.get("Last Run Time", ""), "status": info.get("Status", "")}


def lane_task_create(cid: str, s: dict) -> dict:
    """One Windows task for one lane. Every value passed to schtasks is validated by
    _schedule_args; the lane id is validated by campaigns.ID_RE before it gets here."""
    if not windows_available():
        return {"ok": False, "error": "Windows Task Scheduler only exists when the engine runs on Windows."}
    if s["kind"] in ("minute", "hourly") and s["days"]:
        return {"ok": False, "error": "A Windows task cannot limit an every-N-minutes or every-N-hours "
                                      "schedule to certain days. Clear the days, or let the app run it."}
    args, _info, err = _schedule_args(s["kind"], s["every"], s["start"], s["end"], s["days"])
    if err:
        return {"ok": False, "error": err}
    TASKS_DIR.mkdir(parents=True, exist_ok=True)
    bat = TASKS_DIR / f"{_lane_task_name(cid)}.bat"
    bat.write_text(
        "@echo off\r\n"
        f'cd /d "{ROOT}"\r\n'
        f'"{sys.executable}" scheduled_run.py --campaign {cid}{" --test" if s["test_mode"] else ""}'
        f' >> "{DATA / "scheduled.log"}" 2>&1\r\n', encoding="utf-8")
    r = _schtasks(["/create", "/tn", _lane_task_name(cid), "/tr", f'"{bat}"'] + args + ["/f"])
    if not r["ok"]:
        return {"ok": False, "error": r["err"] or r["out"] or "schtasks failed"}
    b = _task_allow_battery(_lane_task_name(cid))
    if not b["ok"]:
        _sched_log(f"{cid}: task created, but it may not start on battery — {b['err']}")
    return {"ok": True, **lane_task_status(cid)}


def _task_allow_battery(name: str) -> dict:
    """Let a task start (and keep running) on battery.

    schtasks /create leaves Windows' defaults on: "start only on AC power" and "stop if the
    computer switches to battery". On a laptop on battery the task is then SKIPPED in silence —
    Last Run Time never changes (found 2026-10-04, 93% battery, slot 19:35 never ran). schtasks
    cannot change these settings; PowerShell can. `name` is LeadGen-<id> with the id already
    checked against campaigns.ID_RE, so it holds only [a-z0-9_-]."""
    import subprocess
    if not re.fullmatch(r"LeadGen-[a-z0-9][a-z0-9_-]{0,62}", name):
        return {"ok": False, "err": "unexpected task name"}
    script = (f"$t = Get-ScheduledTask -TaskName '{name}'; $s = $t.Settings; "
              "$s.DisallowStartIfOnBatteries = $false; $s.StopIfGoingOnBatteries = $false; "
              f"Set-ScheduledTask -TaskName '{name}' -Settings $s | Out-Null")
    try:
        p = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                           capture_output=True, text=True, timeout=30)
        return {"ok": p.returncode == 0, "err": (p.stderr or "").strip()[:300]}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "err": str(e)}


def lane_task_delete(cid: str) -> None:
    """Remove a lane's Windows task if it has one. Missing is fine — that is the goal."""
    if windows_available() and lane_task_status(cid)["exists"]:
        _schtasks(["/delete", "/tn", _lane_task_name(cid), "/f"])
    try:
        (TASKS_DIR / f"{_lane_task_name(cid)}.bat").unlink()
    except FileNotFoundError:
        pass


def _lane_running(cid: str) -> bool:
    return any(j.get("status") == "running" and j.get("campaign") == cid for j in JOBS.values())


def _live_spend_today() -> float:
    today = datetime.now().strftime("%Y-%m-%d")
    return sum(float(h.get("spent_usd") or 0) for h in _read_json(HISTORY_FILE, [])
               if not h.get("test_mode") and str(h.get("when", "")).startswith(today))


def fire_lane(camp, *, test_mode: bool, wait: bool = False, source: str = "app") -> dict:
    """Start one scheduled run (+ the push when the lane has auto_push). Same guards as a
    click: the lane is not already running, today's spend cap is not reached."""
    if not test_mode:
        cap = float(runner_mod.load_config_dir(CONFIG_DIR)["globals"].get("daily_spend_cap_usd") or 0)
        spent = _live_spend_today()
        if cap and spent >= cap:
            return {"error": f"today's spend cap is reached (${spent:.2f} of ${cap:.2f})"}
    snap = start_campaign_run(camp.id, test_mode=test_mode)
    if snap.get("error"):
        return snap
    run_id = snap["run_id"]
    _sched_log(f"{camp.id}: {source} started run {run_id} ({'test' if test_mode else 'live'})")
    if camp.auto_push:
        def push_after():
            wait_for_job(run_id)
            p = start_push(run_id, test_mode=test_mode, confirm=True)
            _sched_log(f"{camp.id}: auto-push after {run_id}: "
                       + (p.get("error") or f"push {p.get('run_id')} started"))
            if wait and not p.get("error"):
                wait_for_job(p["run_id"])
        if wait:
            push_after()
        else:
            threading.Thread(target=push_after, daemon=True).start()
    elif wait:
        wait_for_job(run_id)
    return snap


def _parse_ts(v) -> datetime | None:
    try:
        return datetime.fromisoformat(str(v)) if v else None
    except ValueError:
        return None


def scheduler_tick(now: datetime | None = None) -> list[dict]:
    """Fire every app-scheduled lane whose slot has come. Returns what it did (for tests/logs).

    The slot is recorded BEFORE the run starts, so a crash mid-start can never fire it twice."""
    now = now or datetime.now()
    did = []
    with _SCHED_LOCK:
        state = _read_json(SCHEDULE_STATE, {})
        for camp in runner_mod.load_config_dir(CONFIG_DIR)["campaigns"]:
            s, problems = schedules_mod.normalize(camp.schedule)
            if problems or not (camp.enabled and s["enabled"] and s["via"] == "app"):
                continue
            st = state.setdefault(camp.id, {})
            slot, missed = schedules_mod.due(s, _parse_ts(st.get("last_fire")), now)
            if missed:
                _sched_log(f"{camp.id}: skipped {missed} missed run(s) — the engine was not running")
                st["last_fire"] = (now - schedules_mod.GRACE).isoformat(timespec="seconds")
            if slot is None:
                continue
            st["last_fire"] = slot.isoformat(timespec="seconds")
            _write_json(SCHEDULE_STATE, state)
            if _lane_running(camp.id):
                res = {"error": "it is still running from before"}
            else:
                try:
                    res = fire_lane(camp, test_mode=s["test_mode"])
                except Exception as e:  # noqa: BLE001 - one lane must not stop the clock
                    res = {"error": str(e)}
            st.update({"fired_at": now.isoformat(timespec="seconds"),
                       "result": res.get("error") or "started", "run_id": res.get("run_id", "")})
            if res.get("error"):
                _sched_log(f"{camp.id}: not started — {res['error']}")
            did.append({"campaign": camp.id, "slot": st["last_fire"], **st})
        _write_json(SCHEDULE_STATE, state)
    return did


def _scheduler_loop() -> None:
    _sched_log("app scheduler started")
    while True:
        try:
            scheduler_tick()
        except Exception as e:  # noqa: BLE001 - the clock keeps ticking
            _sched_log(f"scheduler error: {e}")
        time.sleep(TICK_SECONDS)


def lane_schedule_view(camp, state: dict | None = None, *, now: datetime | None = None) -> dict:
    s, problems = schedules_mod.normalize(camp.schedule)
    if s["enabled"] and s["via"] == "windows" and not windows_available():
        # a lane saved on the Windows PC and copied to a Linux server: nothing would ever fire it
        problems.append("set to run from Windows, but this server is not Windows — "
                        "open its Schedule tab and choose In the app")
    now = now or datetime.now()
    on = bool(camp.enabled and s["enabled"] and not problems)
    nxt = schedules_mod.next_after(s, now) if on else None
    st = (state if state is not None else _read_json(SCHEDULE_STATE, {})).get(camp.id, {})
    return {"schedule": s, "problems": problems, "summary": schedules_mod.summary(s),
            "active": on, "next_run": nxt.strftime("%Y-%m-%d %H:%M") if nxt else "",
            "last": st}


def save_lane_schedule(cid: str, raw: dict) -> dict:
    """Validate, set the ONE trigger (create the Windows task, or remove it), then save."""
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    camp = next((c for c in loaded["campaigns"] if c.id == cid), None)
    if camp is None:
        return {"ok": False, "problems": [f"no campaign '{cid}'"]}
    s, problems = schedules_mod.normalize(raw)
    if s["via"] == "windows" and not windows_available():
        problems.append("this engine is not running on Windows — use the app trigger")
    if problems:
        return {"ok": False, "problems": problems}

    if s["enabled"] and s["via"] == "windows":
        t = lane_task_create(cid, s)
        if not t["ok"]:
            return {"ok": False, "problems": [t["error"]]}
    else:
        lane_task_delete(cid)                     # switching to the app removes the other trigger

    out = save_campaign({"id": cid, "schedule": s})
    if not out.get("ok"):
        if s["via"] == "windows":
            lane_task_delete(cid)
        return {"ok": False, "problems": [i["issue"] for i in out.get("issues", [])]}
    if s["enabled"] and s["via"] == "app":
        # start counting from now: a slot from a few minutes ago must not fire on saving
        with _SCHED_LOCK:
            state = _read_json(SCHEDULE_STATE, {})
            state.setdefault(cid, {})["last_fire"] = datetime.now().isoformat(timespec="seconds")
            _write_json(SCHEDULE_STATE, state)
    camp.schedule = s
    return {"ok": True, **lane_schedule_view(camp)}


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
    rec["credits"] = _credit_breakdown(
        load_config(), {} if rec.get("test_mode") else rec.get("counters", {}).get("credits", {}))
    return rec


# ───────────────────────── FastAPI ─────────────────────────

@asynccontextmanager
async def _lifespan(_app):
    # The app clock runs only inside the served engine, never when a script (scheduled_run.py,
    # plan.py, the evals) imports this module. LEADGEN_NO_SCHEDULER=1 switches it off.
    if os.environ.get("LEADGEN_NO_SCHEDULER") != "1":
        threading.Thread(target=_scheduler_loop, name="leadgen-scheduler", daemon=True).start()
    yield


app = FastAPI(title="Lead Gen Automation Engine", lifespan=_lifespan)


# ── login (V4 I): one password, only once one is set or the server requires it ──

AUTH_FILE = DATA / "auth.json"
_AUTH_OPEN = {"/api/auth/status", "/api/auth/login", "/api/auth/logout"}
_THROTTLE = auth_mod.Throttle()


def login_required() -> bool:
    return auth_mod.is_set(auth_mod.load(AUTH_FILE)) or os.environ.get("LEADGEN_REQUIRE_LOGIN") == "1"


def _signed_in(request: Request) -> bool:
    return auth_mod.valid(auth_mod.load(AUTH_FILE), request.cookies.get(auth_mod.COOKIE))


def _client(request: Request) -> str:
    # behind Next (and a proxy) the socket is always 127.0.0.1; the first forwarded address
    # is the browser's
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "?")


def _set_session(resp: Response, request: Request, rec: dict) -> None:
    # behind Caddy + Next the engine cannot always see the browser's scheme, so a server says
    # so outright (deploy/leadgen.service); a Secure cookie over plain http would never return
    https = os.environ.get("LEADGEN_SECURE_COOKIE") == "1" or \
        request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    resp.set_cookie(auth_mod.COOKIE, auth_mod.issue(rec), max_age=auth_mod.SESSION_SECONDS,
                    httponly=True, samesite="lax", secure=https, path="/")


@app.middleware("http")
async def _login_gate(request: Request, call_next):
    path = request.url.path
    if path in _AUTH_OPEN or not login_required() or _signed_in(request):
        return await call_next(request)
    if path.startswith("/api/"):
        return JSONResponse({"error": "Sign in first.", "login": True}, status_code=401)
    return HTMLResponse('<body style="font:15px system-ui;margin:12vh auto;max-width:30rem">'
                        '<p>Sign in first: <a href="/login">/login</a></p></body>', status_code=401)


@app.get("/api/auth/status")
def api_auth_status(request: Request):
    rec = auth_mod.load(AUTH_FILE)
    return {"required": login_required(), "password_set": auth_mod.is_set(rec),
            "signed_in": _signed_in(request), "set_at": rec.get("set_at", ""),
            "server_requires": os.environ.get("LEADGEN_REQUIRE_LOGIN") == "1"}


@app.post("/api/auth/login")
async def api_auth_login(request: Request):
    rec = auth_mod.load(AUTH_FILE)
    if not auth_mod.is_set(rec):
        return {"ok": False, "error": "No password is set yet. On the server, run: python set_password.py"}
    who = _client(request)
    wait = _THROTTLE.blocked(who)
    if wait:
        return {"ok": False, "error": f"Too many wrong passwords. Try again in {wait // 60 + 1} min."}
    if not auth_mod.verify(rec, str((await request.json()).get("password") or "")):
        _THROTTLE.miss(who)
        return {"ok": False, "error": "Wrong password."}
    _THROTTLE.clear(who)
    resp = JSONResponse({"ok": True})
    _set_session(resp, request, rec)
    return resp


@app.post("/api/auth/logout")
def api_auth_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth_mod.COOKIE, path="/")
    return resp


@app.post("/api/auth/password")
async def api_auth_password(request: Request):
    """Set or change the password. Changing needs the current one; a new password signs
    every other browser out, and this one straight back in."""
    b = await request.json()
    rec = auth_mod.load(AUTH_FILE)
    if auth_mod.is_set(rec) and not auth_mod.verify(rec, str(b.get("current") or "")):
        return {"ok": False, "error": "The current password is wrong."}
    new = str(b.get("new") or "")
    why = auth_mod.check_strength(new)
    if why:
        return {"ok": False, "error": f"Not saved: {why}."}
    rec = auth_mod.make(new)
    auth_mod.save(AUTH_FILE, rec)
    resp = JSONResponse({"ok": True, "set_at": rec["set_at"]})
    _set_session(resp, request, rec)
    return resp


@app.post("/api/auth/clear")
async def api_auth_clear(request: Request):
    """Remove the password: the app is open again. Refused where the server requires a login."""
    if os.environ.get("LEADGEN_REQUIRE_LOGIN") == "1":
        return {"ok": False, "error": "This server requires a login, so the password cannot be removed."}
    rec = auth_mod.load(AUTH_FILE)
    if auth_mod.is_set(rec) and not auth_mod.verify(rec, str((await request.json()).get("current") or "")):
        return {"ok": False, "error": "The current password is wrong."}
    AUTH_FILE.unlink(missing_ok=True)
    return {"ok": True}


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
    send_ready = len(rows)
    waiting, ib_note = [], ""
    if camp is not None:
        rows, waiting, ib_note = _lane_icebreakers(cfg, camp, fm, rows)
    campaign = (camp.instantly_campaign_id if camp else "") or \
        str(cfg.get("instantly_campaign_id", "")).strip()
    return {
        "run_id": snap.get("run_id"), "ready": len(rows),
        "found": len(found), "held_not_send_ready": len(found) - send_ready,
        "waiting_icebreaker": len(waiting), "icebreaker_note": ib_note,
        "waiting_companies": [r.get("company", "") for r in waiting[:25]],
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
        rows = _read_tab_for_display(cfg, lane.tab)
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


@app.get("/api/campaigns/schedule")
def api_campaign_schedule(id: str):
    camp = next((c for c in runner_mod.load_config_dir(CONFIG_DIR)["campaigns"] if c.id == id), None)
    if camp is None:
        return {"error": f"No campaign '{id}'."}
    view = lane_schedule_view(camp)
    view["windows_available"] = windows_available()
    view["task"] = lane_task_status(id) if view["schedule"]["via"] == "windows" else {"exists": False}
    return view


@app.post("/api/campaigns/schedule")
async def api_campaign_schedule_save(request: Request):
    b = await request.json()
    return save_lane_schedule(str(b.get("id") or ""), b.get("schedule") or {})


# ── V5 screens: dropdowns, connection tests, live counts, readiness, order ──

def sheet_info(cfg: dict | None = None) -> dict:
    """The Google Sheet's title and tab names (one metadata read). Without a service-account
    file the link-export route cannot list tabs, so the tabs the campaigns use are offered."""
    cfg = cfg or load_config()
    used = sorted({c.tab for c in runner_mod.load_config_dir(CONFIG_DIR)["campaigns"]
                   if c.tab and not imports_mod.is_import_tab(c.tab)})
    parsed = sheets_mod.parse_sheet_url(cfg.get("sheet_url", ""))
    if not parsed["doc_id"]:
        return {"ok": False, "detail": "no Google Sheet link saved yet", "title": "", "tabs": used}
    sa = str(cfg.get("sheet_service_account_file") or "").strip()
    if not sa:
        return {"ok": False, "detail": "add the Google key file to list every tab", "title": "", "tabs": used}
    try:
        info = sheets_mod.SheetsClient(sa).info(parsed["doc_id"])
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "detail": f"could not open the sheet: {e}", "title": "", "tabs": used}
    n = len(info["tabs"])
    return {"ok": True, "detail": f"“{info['title']}” · {n} tab{'s' if n != 1 else ''}", **info}


def test_connection(service: str) -> dict:
    """One free read per service; never spends a credit."""
    cfg = load_config()
    if service == "sheet":
        r = sheet_info(cfg)
        return {"ok": r["ok"], "detail": r["detail"]}
    if service == "millionverifier":
        return conn_mod.test_millionverifier(_mv_key(cfg))
    if service == "instantly":
        return conn_mod.test_instantly(str(cfg.get("instantly_api_key") or "").strip())
    if service == "anymailfinder":
        return conn_mod.test_anymailfinder(str(cfg.get("anymailfinder_api_key") or "").strip())
    if service == "openai":
        return conn_mod.test_openai(str(cfg.get("openai_api_key") or "").strip())
    if service == "icypeas":
        has = bool(str(cfg.get("icypeas_api_key") or "").strip())
        return {"ok": None, "detail": ("saved — Icypeas has no free test; a refused key shows up in "
                                       "Activity after its first lookup") if has else "no Icypeas key saved yet"}
    return {"ok": False, "detail": f"unknown service '{service}'"}


def _fieldmap_for_raw(camp, loaded: dict, heads: list[str]):
    if camp.fieldmap and camp.fieldmap not in loaded["fieldmaps"]:
        # a new campaign can name a map file no saved campaign has loaded yet
        loaded["fieldmaps"][camp.fieldmap] = fieldmap_mod.load(CONFIG_DIR / camp.fieldmap)
    return runner_mod.fieldmap_for(camp, loaded["fieldmaps"], heads)


def campaign_preview(raw: dict) -> dict:
    """Live counts for a campaign as it stands on screen, saved or not. Free: reads the source
    and applies the filters, nothing more. Other campaigns higher in the order may still claim
    some of these rows; the Campaigns list shows the split."""
    camp = campaigns_mod.Campaign(raw or {})
    if not camp.tab:
        return {"error": "Choose a lead source first."}
    problems = rules_mod.validate_rules(camp.rules)
    if problems:
        return {"error": "A filter is not finished: " + "; ".join(problems)}
    cfg = load_config()
    try:
        rows = _read_tab_for_display(cfg, camp.tab)
    except Exception as e:  # noqa: BLE001
        return {"error": f"Could not read '{camp.tab}': {e}"}
    heads = runner_mod.headers_of(rows)
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    fm = _fieldmap_for_raw(camp, loaded, heads)
    led = ledger_mod.Ledger(LEDGER_FILE) if cfg.get("use_ledger", True) else None
    prep = runner_mod.prepare(camp, rows, fm, ledger=led, cfg=cfg)
    rate = float(cfg.get("mv_per_verification_usd", 0) or 0)
    return {"rows": len(rows), "matched": prep["matched"], "not_contacted": prep["available"],
            "done_before": prep["blocked_by_ledger"], "take": prep["selected"],
            "day_remaining": prep["day_remaining"], "per_run": camp.per_run,
            # the same estimate the plan uses: about 2 checks a lead
            "est_cost_per_run": round(camp.per_run * 2 * rate, 2),
            "est_cost_per_day": round((camp.per_day or camp.per_run) * 2 * rate, 2)}


def campaign_readiness(cid: str) -> dict:
    """The "Ready to go live" checklist. Each item says what to fix and which section fixes it."""
    cfg = load_config()
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    camp = next((c for c in loaded["campaigns"] if c.id == cid), None)
    if camp is None:
        return {"error": f"No campaign '{cid}'."}
    items = []

    def add(ok, text, fix=""):
        items.append({"ok": bool(ok), "text": text, "fix": "" if ok else fix})

    problems = [i["issue"] for i in campaigns_mod.validate([camp])]
    add(not problems, "Settings are complete" if not problems else "Settings problem: " + "; ".join(problems), "who")
    try:
        rows = _read_tab_for_display(cfg, camp.tab)
        heads = runner_mod.headers_of(rows)
        fm = _fieldmap_for_raw(camp, loaded, heads)
        check = runner_mod.check_fieldmap(fm, heads)
        led = ledger_mod.Ledger(LEDGER_FILE) if cfg.get("use_ledger", True) else None
        prep = runner_mod.prepare(camp, rows, fm, ledger=led, cfg=cfg)
        add(prep["available"] > 0, f"Leads to work on: {prep['available']:,} fit the filters and were never contacted"
            if prep["available"] else "No leads left that fit the filters", "who")
        add(check["ok"], "Every column it needs is matched" if check["ok"]
            else "Column matching: " + "; ".join(check["blocking"]), "columns")
    except Exception as e:  # noqa: BLE001
        add(False, f"The lead source could not be read: {e}", "who")
    hist = _read_json(HISTORY_FILE, [])
    tested = any(h.get("campaign") == cid and h.get("kind", "run") == "run" and h.get("status") == "finished"
                 for h in hist)
    add(tested, "A test run finished" if tested else "No test run yet — run a free test first", "test")
    add(bool(_mv_key(cfg)), "Email checking (MillionVerifier) is connected" if _mv_key(cfg)
        else "Email checking is not connected", "settings")
    has_key = bool(str(cfg.get("instantly_api_key") or "").strip())
    add(has_key, "Instantly is connected" if has_key else "Instantly is not connected", "settings")
    add(bool(camp.instantly_campaign_id), "Instantly campaign chosen" if camp.instantly_campaign_id
        else "No Instantly campaign chosen", "send")
    add(camp.enabled, "Campaign is switched on" if camp.enabled else "Campaign is switched off", "on")
    return {"campaign": cid, "items": items, "done": sum(i["ok"] for i in items), "total": len(items)}


def reorder_campaigns(ids: list[str]) -> dict:
    """The Campaigns list's drag order becomes priority: first = 10, then 20, 30 … A lane not
    named keeps its place after the named ones."""
    body = _read_campaigns_raw()
    rows = body.get("campaigns") or []
    known = {str(c.get("id")) for c in rows}
    order = [i for i in ids if i in known]
    if len(set(order)) != len(order) or not order:
        return {"ok": False, "issues": [{"campaign": "", "issue": "the order must name each campaign once"}]}
    rest = [str(c.get("id")) for c in sorted(rows, key=lambda c: int(c.get("priority", 100) or 0))
            if str(c.get("id")) not in order]
    prio = {cid: (n + 1) * 10 for n, cid in enumerate(order + rest)}
    for c in rows:
        c["priority"] = prio[str(c.get("id"))]
    body["campaigns"] = rows
    return _write_campaigns_raw(body)


def schedule_preview(raw: dict, *, now: datetime | None = None, count: int = 3) -> dict:
    """A schedule as it stands on screen: its sentence, its problems, its next few runs — from
    the same code the clock uses, so the screen can never promise a time the clock won't keep."""
    s, problems = schedules_mod.normalize(raw)
    if s["via"] == "windows" and not windows_available():
        problems.append("this engine is not running on Windows — choose the app")
    nxt, t = [], now or datetime.now()
    if not problems:
        for _ in range(count):
            slot = schedules_mod.next_after(s, t)
            if slot is None:
                break
            nxt.append(slot.strftime("%Y-%m-%d %H:%M"))
            t = slot
    return {"summary": schedules_mod.summary(s), "problems": problems, "next": nxt, "schedule": s,
            "windows_available": windows_available()}


@app.post("/api/schedules/preview")
async def api_schedule_preview(request: Request):
    return schedule_preview(await request.json())


@app.get("/api/sheets/info")
def api_sheet_info():
    return sheet_info()


@app.get("/api/instantly/options")
def api_instantly_options():
    return conn_mod.instantly_options(str(load_config().get("instantly_api_key") or "").strip())


@app.post("/api/connections/test")
async def api_connection_test(request: Request):
    return test_connection(str((await request.json()).get("service") or ""))


@app.post("/api/campaigns/preview")
async def api_campaign_preview(request: Request):
    return campaign_preview(await request.json())


@app.get("/api/campaigns/readiness")
def api_campaign_readiness(id: str):
    return campaign_readiness(id)


@app.post("/api/campaigns/reorder")
async def api_campaign_reorder(request: Request):
    return reorder_campaigns([str(i) for i in ((await request.json()).get("ids") or [])])


# ── import: a CSV becomes a tab a lane can read (V4 F) ───────────────

def _lanes_reading(tab: str) -> list[dict]:
    return [{"id": c.id, "name": c.name, "enabled": c.enabled}
            for c in runner_mod.load_config_dir(CONFIG_DIR)["campaigns"] if c.tab == tab]


def import_preview(tab: str) -> dict:
    """Any tab — an upload or a sheet tab by name — with its first rows and what a lane would
    find in it: duplicates, suppressed firms, leads the ledger already handled. Free."""
    tab = str(tab or "").strip()
    if not tab:
        return {"error": "Give a tab name."}
    cfg = load_config()
    try:
        rows = _read_tab_for_display(cfg, tab)
    except Exception as e:  # noqa: BLE001
        return {"error": f"Could not read '{tab}': {e}"}
    heads = runner_mod.headers_of(rows)
    loaded = runner_mod.load_config_dir(CONFIG_DIR)
    lane = next((c for c in loaded["campaigns"] if c.tab == tab), None)
    fm = runner_mod.fieldmap_for(lane, loaded["fieldmaps"], heads) if lane else \
        fieldmap_mod.FieldMap({}).completed(heads)
    led = ledger_mod.Ledger(LEDGER_FILE) if cfg.get("use_ledger", True) else None
    st = imports_mod.stats(rows, owned_companies=cfg.get("owned_companies"),
                           owned_domains=cfg.get("owned_domains"), ledger=led, fm=fm,
                           retry_not_found=bool(cfg.get("retry_not_found", False)))
    meta = imports_mod.load_index(IMPORTS_DIR).get(tab[len(imports_mod.PREFIX):]) \
        if imports_mod.is_import_tab(tab) else None
    return {"tab": tab, "source": tab_source(cfg, tab), "import": meta, "headers": heads,
            "sample": rows[:10], "stats": st, "check": runner_mod.check_fieldmap(fm, heads),
            "lanes": _lanes_reading(tab),
            "hold_without_icebreaker": bool(cfg.get("hold_without_icebreaker", True))}


@app.get("/api/imports")
def api_imports():
    lanes = runner_mod.load_config_dir(CONFIG_DIR)["campaigns"]
    out = []
    for rec in sorted(imports_mod.load_index(IMPORTS_DIR).values(),
                      key=lambda r: r.get("uploaded", ""), reverse=True):
        out.append({**rec, "fieldmap": import_fieldmap_file(rec["tab"]), "lanes": [{"id": c.id, "name": c.name, "enabled": c.enabled}
                                     for c in lanes if c.tab == rec["tab"]]})
    sheet_tabs = sorted({c.tab for c in lanes if c.tab and not imports_mod.is_import_tab(c.tab)})
    return {"imports": out, "sheet_tabs": sheet_tabs}


@app.post("/api/imports/upload")
async def api_imports_upload(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        rec = imports_mod.save_upload(IMPORTS_DIR, file.filename or "upload.csv", raw)
    except ValueError as e:
        return {"error": str(e)}
    return {"ok": True, "import": rec}


@app.get("/api/imports/preview")
def api_imports_preview(tab: str = ""):
    return import_preview(tab)


@app.post("/api/imports/delete")
async def api_imports_delete(request: Request):
    b = await request.json()
    slug = str(b.get("slug") or "").strip()
    users = _lanes_reading(imports_mod.PREFIX + slug)
    if users:
        return {"ok": False, "error": "Campaigns still read this file: "
                + ", ".join(u["name"] for u in users) + ". Delete them or point them at another tab first."}
    rec = imports_mod.remove(IMPORTS_DIR, slug, delete_file=bool(b.get("delete_file", False)))
    if rec is None:
        return {"ok": False, "error": f"No import '{slug}'."}
    return {"ok": True, "removed": rec["name"]}


@app.post("/api/campaign/run")
async def api_campaign_run(request: Request):
    b = await request.json()
    return start_campaign_run(str(b.get("campaign") or ""),
                              test_mode=bool(b.get("test_mode", True)))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8771)
