# STATE — Lead Gen Automation Engine

Handoff so a new session does not re-explore. **Last updated 2026-10-04.**

---

## ▶ NOW — UX redesign (2026-10-04)

User: the screens feel technical and noisy. Agreed order: research → architecture → sample → build.
- **Architecture APPROVED** ("ok to all"): `docs/UX-REDESIGN.md` — 5 pages (Home · Campaigns · Leads ·
  Activity · Settings), campaign page = status card + Who / How many / Send to / When + closed Advanced,
  4-step wizard, plain word list, nothing removed (§6 maps every control).
- **Clickable sample built**: `docs/sample-ui/index.html` (one file, fake data, same theme, works at
  phone width, driven in headless Chrome: all pages + clicks + drags pass). Waiting for his feedback.
- **Open decision**: how each technical setting is shown (finding-emails presets + ladder, column
  matching, extra info for Instantly drag-and-drop, filters, Instantly options, speed presets…). The
  sample shows my proposals marked "Proposal". Build nothing real until he answers.

## ▶ THEN — choose the server, then deploy (docs/DEPLOY.md)

Server advice given 2026-10-04: no need to buy one — his Hostinger VPS (n8n + YT Dashboard,
187.77.122.151) has 2.5 GB RAM free; it uses Docker + Traefik, so this app would deploy like the
YT Dashboard (containers + a subdomain), NOT the Caddy route in DEPLOY.md. Waiting for his OK and a
subdomain name.

V4 is **finished and merged into `main`** (A–I, below). What is left is outside the code:

| # | Do this | Who |
|---|---|---|
| 1 | Pick the server. Recommended: a small Linux VPS (1 GB RAM is enough). User said "not decided yet" on 2026-10-04 | user |
| 2 | Follow `docs/DEPLOY.md`. **`start-app.sh` has never been run on Linux** — expect one small fix on the first start | us, with the user |
| 3 | Copy `data/config.json`, `data/ledger.db` and the Google service-account file to the server by hand (gitignored, never committed); fix `sheet_service_account_file` to the server path | user |
| 4 | The "⛔ Before the first real run" list further down still applies (Instantly ids, one lane pair at a time) | user |

Not built, on purpose: Docker image, more than one user, automated `data/` backups on the server.
Known, harmless: no `favicon.ico` (one 404 in the console on every page).

---

## ✅ V4 — everything V1 had, on the V3 screens (2026-09-29 → 2026-10-04)

Review found V3 = V2 parity, but **V2 only ever had 5 of V1's 10 tabs**, and no version could
create a campaign. The user chose: build all of it, per-campaign schedules, CSV import "for
maximum functionality and ease" (design left to us), dark mode last using V2's colours.

| Phase | What | Engine work? | Status |
|---|---|---|---|
| A | Campaign create / duplicate / delete; last run per lane on the list | `core/campaigns.py` `new_campaign`/`remove_campaign` (+ `eval_campaign_admin.py`, 6 checks), `/api/campaigns/create` + `/delete`; history now records `campaign`, `kind`, `pushed`, and pushes are recorded too | ✅ tested on the real file, restored from git |
| B | Dashboard home `/` + History `/history` | no | ✅ |
| C | Results (on each run's page, expandable rows) + Log `/log` (filter, search, run picker, CSV) | no | ✅ |
| D | Settings: all 14 missing keys + suppression lists + local-files editor + "V1 screens only" card | no | ✅ round trip identical (39 settings) |
| E | **Ice breakers = Icebreaker Studio's line only** (user's choice). Lanes read the sheet's mapped `Ice Breaker` column (`runner.sheet_icebreaker`) and never generate; the push RE-READS the live tab (`_lane_icebreakers` → `runner.refresh_icebreakers`) because Studio may write after the run; leads with no line are held (`hold_without_icebreaker`, default on, in Settings); write-back never writes `Ice Breaker` for lanes (`build_writeback_row(write_icebreaker=False)`). V1 `/legacy` flow unchanged. No template editor | yes | ✅ 2 new checks in `eval_runner`, 1 in `eval_sheets`; verified live: run `df18c6944e49` → 2 waiting, 0 ready, dry run refused with the reason |
| F | **Import** `/import`: drop a CSV → it becomes tab `import:<slug>` (file in `data/imports/`, registry `data/imports/index.json`, NOT `local_tabs` — Settings saves `local_tabs` whole and would drop them). A missing Status column is added empty. Preview any upload or sheet tab by name: rows, repeats, suppressed, done before (ledger), no company, ice breakers. "Create a campaign for it" opens New campaign pre-filled (own map file `fieldmap.<slug>.json`). **Write-back is skipped for any non-live tab** (upload or `local_tabs` snapshot), run AND push, and the feed says so. Field map page now has a tab picker (`?tab=`). Removing an upload is refused while a lane reads it | `core/imports.py`, `/api/imports*`, `eval_imports.py` (6) | ✅ driven in Chrome on `samples/companies_house_sample.csv`: 7 rows, 1 repeat found, lane created, test run fired |
| G | **Per-campaign schedules**: Schedule tab in the campaign editor (own Save — the main Save no longer sends `schedule`, or it would overwrite it). `via: app` = one clock thread in the engine (FastAPI `lifespan`; Starlette 1.x has no `on_event`), ticks 30 s, slot written to `data/schedule_state.json` BEFORE firing → no double fire; a slot >5 min old is skipped + logged in `data/schedule.log`, never replayed. `via: windows` = task `LeadGen-<id>` → `data/tasks/LeadGen-<id>.bat` → `scheduled_run.py --campaign <id> [--test]`; saving one trigger removes the other; deleting a lane removes its task. Windows refuses minute/hourly-on-days (schtasks cannot). Guards added: a lane already running is refused (manual too); live scheduled runs stop at `daily_spend_cap_usd` (it was never enforced before). "Next run" column on Campaigns + Dashboard. `LEADGEN_NO_SCHEDULER=1` turns the clock off | `core/schedules.py`, `/api/campaigns/schedule`, `eval_lane_schedules.py` (11, schtasks faked) | ✅ live: app clock fired a test lane 17:32 and 17:33, once each. **Real Windows task tested 2026-10-04**: first try was SKIPPED in silence because the laptop was on battery (Windows' default "start only on AC power") — fixed by `_task_allow_battery` (PowerShell `Set-ScheduledTask`) after every create; then the task ran at 19:40, result 0, run in History at $0.00; switching to In the app deleted the task + its `.bat` |
| I | **Login + server readiness**: one password (pbkdf2, `data/auth.json` — never `config.json`, which `/api/config` sends to the browser). Engine middleware refuses every request without the session cookie once a password is set or `LEADGEN_REQUIRE_LOGIN=1`; Next `middleware.ts` sends pages to `/login`. Settings → Login card (set / change / remove); `set_password.py` for a server; sign-out in the sidebar; wrong-password throttle per address. `start-app.sh` (requires login by default), `deploy/leadgen.service`, `deploy/Caddyfile`, `docs/DEPLOY.md` | `core/auth.py`, `/api/auth/*`, `eval_auth.py` (5) | ✅ 13 HTTP checks + Chrome drive (wrong pw refused, sign in, sign out, /legacy locked); test password removed afterwards — **the app on this PC is open again, as before** |

Bug found on the way and fixed: **a test-mode run showed fake spend** (`$0.0142`) — its simulated
MillionVerifier checks were priced. No money was spent (test mode uses a stub transport); now a
test run reports $0 in `_credit_breakdown_from_job` and `get_run`.

Trap found on the way: Next middleware builds `req.nextUrl` from its own bind address, so a
redirect from it sent a browser behind a proxy to `https://localhost:3200/login`. The redirect
is now built from the request's `Host` / `x-forwarded-*` headers (checked with a fake
`Host: leads.example.com`). Next refuses a relative `Location`.

Verifying screens: the browser pane is often hidden, so this session drove them with Playwright
from `docpipeline-venv` using the INSTALLED Chrome (`launch(channel="chrome")`) — this profile has
no Playwright browser download. Scripts were in the session scratchpad, not the repo.

H (dark mode) was done 2026-09-29: V2's dark palette on the theme tokens in `leadgen.css`
(`:root[data-theme="dark"]`), toggle at the foot of the sidebar + in the phone menu, saved as
`leadgen:theme`, applied before paint by `app/layout.tsx`.

Tests: **197 checks across 23 files**, all passing, all offline (2026-10-04).

On a server the app clock runs every "In the app" schedule by itself, as long as the engine
runs (systemd keeps it running). A lane left on "From Windows" cannot run on Linux: it now
shows "schedule problem" on Campaigns and the Dashboard until it is switched to In the app.
Branch `v4` was merged into `main` on 2026-10-04 and pushed. Engine venv is
`C:\ClaudeDeps\leadgen-venv` (shared Python 3.14), used by `start-app.bat` and `.claude/launch.json`.
Verifying in the hidden browser pane: CSS transitions never finish there (no frames), so a
computed colour right after a change can be stale — read it with `transition: none`.

V1's CSV → single-campaign run stays in `/legacy`; F replaces it for lanes.

---

## ✅ V3 — the screens are Next.js (merged to `main` as `359e9e0`)

Same look, layout, fonts and UI as **YT Dashboard (A8OM View)** and **Icebreaker Studio**.
**Only the screens moved.** Python (`core/`, 33 `/api/*` routes, the tests) is unchanged, except
`webapp/server.py`'s `/` page, which now points at the screens instead of serving the V2 build.
Rollback point: commit `5420410` on `main` (V2 snapshot). V2's source is also in
`_archive\lead gen automation engine - V2 ui 2026-09-29`.

| | |
|---|---|
| Template | `..\icebreaker-studio\web` — Next 15.5.26, React 19.1.1, TypeScript, plain CSS, no Tailwind |
| Theme | `web/app/globals.css` = Icebreaker's copy, **unchanged. Never edit it for a look** — add to `web/app/leadgen.css` |
| Ports | screens **3200** (YT = 3000, Icebreaker = 3100), engine stays **8771** |
| Wiring | `web/next.config.mjs` rewrites `/api/*`, `/legacy`, `/style.css`, `/app.js` to Python. Browser code uses relative paths only |
| Deps | `web/node_modules` → `C:\ClaudeDeps\leadgen-web\node_modules`, `web/.next` → `C:\ClaudeDeps\leadgen-web\next-build` (junctions) |
| Start | `start-app.bat` — engine + screens in one window, builds once. `start-app.bat rebuild` after editing `web\` |
| Icons | Tabler path data in `web/components/icons.tsx`; add from `unpkg.com/@tabler/icons@3.47.0/icons/outline/<name>.svg` |
| Leftover | `C:\ClaudeDeps\leadgen-ui` (V2's ~82 MB of packages) is no longer used and can be deleted |

API rule carried from V2: the engine answers **200 with `{error}`** for expected problems.
`lib/client-api.ts` throws only when the engine cannot answer; each screen checks `.error`.

### Phases

| Phase | Status |
|---|---|
| 1. Scaffold: layout, sidebar (Pipeline / Setup groups), TopBar, `ui.tsx`, icons, client API, **Plan preview ported** | ✅ done 2026-09-29. `next build` clean; Plan verified on real Eco data (4 lanes, 128 leads, $0.46); phone width checked |
| 2. Port the rest: Field map, Settings, Campaigns (+ editor), Runs | ✅ done 2026-09-29. All read paths verified on real data |
| 3. Exercise the writes, one launcher, retire V2 | ✅ done 2026-09-29, see below |

Phase 3 write tests (2026-09-29), each checked against the file, then the file restored from git:

| Path | Result |
|---|---|
| Field map save | Only the edited key changed (engine re-orders the file into FIELDS order — V2 did too) |
| Campaign save | One semantic change (`priority`); rules, labels, order round-tripped intact |
| Lane toggle on → off | `campaigns.json` byte-identical afterwards |
| Settings save | `data/config.json` identical — 39 settings, masked keys NOT saved over real ones |
| Test-mode run | 5/5, $0.00, sheet skipped, ledger unchanged (10 / 0 / 5) |
| Stop | `/api/run/cancel` with `{}` (V2) → `ok:false`; with `{run_id}` (V3) → `ok:true` |
| Dry-run push | Refused cleanly on a test run (0 send-ready); on run `df18c6944e49` pushed 2 "(test)", ledger unchanged |
| **Not exercised** | **Live run, live push, Clear ledger** — spend money, leave the machine, or cannot be undone |

Where each V2 screen went:

| V2 | V3 | Changed on purpose |
|---|---|---|
| `#/campaigns` + `CampaignDrawer` | `/campaigns` + **`/campaigns/[id]`** (own page, not a drawer) | Save returns to the list with a note. Toggling a lane re-fetches in place (`flashNote`), so loaded counts survive |
| `#/plan` | `/plan` | — |
| `#/run/<id>` | `/runs?run=<id>` | **Stop now works**: V2 posted no `run_id`, so `/api/run/cancel` never found the run. A push opens its own job's page. Results + event-log CSV links added |
| `#/fieldmap` | `/fieldmap` | — |
| `#/settings` | `/settings` | Save checks the caps reply: `campaigns/globals` can refuse (`ok:false`) and V2 still said "saved". Numbers kept as typed text until save |

Toasts are gone: a save reloads with a note (`reloadWithNote` / `goWithNote`), a change needing no
reload uses `flashNote`. Both render in `components/saved-note.tsx`.

Theme traps found (both fixed in `leadgen.css`, not `globals.css`):
- `.form-grid label > span` styles EVERY direct span as a caption — wrap controls in `span.inline`.
- `td.clip` is `width:100%`, built for ONE clipped column — use `td.cell-clip` for several.

Dark mode was left out of V3 at first and added back in V4 (H).

---

## Where things stand

**V2 Phase 1 AND Phase 2 are BUILT and driven end to end on real Eco data.**

| | |
|---|---|
| V1 backup | `_archive\lead gen automation engine - V1 BACKUP 2026-09-04` — 174 files, 6,003,146 bytes, byte-verified. **The engine is NOT a git repo, so this folder is the only fallback.** |
| Tests | **197 checks across 23 files**, all passing, all offline (re-run 2026-10-04) |
| Requirements + research | `docs/V2-REQUIREMENTS.md` |
| Interface | **V3: Next.js in `web/`** (see top). V2's React + Vite `ui/` is archived. The V1 interface is untouched and still served at **`/legacy`** |

## Running it

```
start-app.bat
```
Starts the engine (8771) and the screens (3200) in one window, builds the screens on first
launch, then opens `http://127.0.0.1:3200`. `start-app.bat rebuild` after editing `web\`.

---

## ⚠️ Read this before running anything

**A venv built on the other Windows profile leaves `python.exe` in place but it cannot
start.** `run-tests.bat` and `start-app.bat` both used `if exist` and silently picked a
dead interpreter, so on the `Hp` profile every test "failed" and the app would not launch
at all. Both now **launch a candidate and check it works** before using it. Do not
reintroduce `if exist` there.

Working interpreter on the `Hp` profile: `C:\Users\Hp\AppData\Local\Microsoft\WindowsApps\python.exe` (3.14.6).

---

## What V2 added

V1 was a faithful port of n8n **V7**: one sheet, one campaign, fixed English column
names. Eco is one sheet, five tabs, 42 columns, several campaigns, different names.
Four things that were hard-coded are now configuration.

| New file | Does |
|---|---|
| `core/fieldmap.py` | engine field -> YOUR header. Explicit mapping always wins; unmapped falls back to V1's aliases so old sheets still work |
| `core/rules.py` | the rule engine: 17 operators, `all`/`any`/`none`, ordering. Pure, spends nothing |
| `core/campaigns.py` | many lanes off one sheet, priority-ordered, **one firm one campaign**, plus the free `plan()` |
| `core/runner.py` | campaign -> the exact leads this run will work on |
| `plan.py` | CLI preview. Reads the sheet, applies the rules, prints the counts. **Costs nothing.** |
| `config/fieldmap.eco.json` | the ECO Leads map, verified against the real 42 headers |
| `config/campaigns.json` | 4 September WHO-test lanes, **all disabled, no Instantly ids** |

| Rewritten | Why |
|---|---|
| `core/ledger.py` | JSON -> **SQLite**, keyed on `lead_id` not company name, and `enrich` / `push` split into two stages |
| `core/instantly.py` | dynamic label table; `job_title`, `blocklist_id`, `list_id` now sent |
| `core/organize.py` | reads through the field map; **honours the sheet's `seniority_label`** |
| `core/sheets.py` | write-back translated into the sheet's own header names |
| `webapp/server.py` | `/api/campaigns`, `/api/plan`, `/api/fieldmap`, `/api/campaign/run`; the push now uses the campaign's own id, labels and options |

---

## Six V1 bugs fixed (five were silent)

1. **Ledger keyed on company name.** The Eco sheet has 132 duplicate names over 264 rows,
   so two different firms blocked each other forever. Now keyed on `lead_id`.
2. **`email_found` was terminal.** A lead that found an address but ran out of quota was
   never sent. `enrich` and `push` are now separate stages; `pending_push()` lists what is
   still owed a send.
3. **`seniority_label` was ignored.** V1 re-ranked with its own list against `Job Title`
   (23% filled) and threw away `seniority_label` (100% filled) — it picked *worse* contacts
   than the sheet had already picked.
4. **`job_title` and `blocklist_id` were never sent.** Both are first-class Instantly API
   fields; the sheet has the column and the account's blocklist is empty.
5. **The push had no send gate.** V1 pushed anything with an address. `_is_send_ready()`
   now requires `send_ready = yes` or a real verification pass, so an unverified Icypeas
   "probable" can never go out.
6. **A test run polluted the ledger.** Found while driving the new UI: a test-mode run
   wrote its *simulated* results in, which would have skipped 50 real firms forever behind
   an address nobody ever checked. `Ledger.record(..., test_mode=True)` now records
   nothing, and the guard lives on the ledger so no call site can forget it.

---

## Verified on real data, 2026-09-04

Driven against `ecooutsourcing/leads/google-sheet/Practices.csv` (21,714 real rows), test
mode, zero API calls:

| Step | Result |
|---|---|
| Field map vs the real 42 headers | OK, nothing unmapped |
| `eco-size-micro` matched | **1,670** — exactly STATE.md's figure |
| `eco-size-small` matched | **541** — exactly STATE.md's figure |
| Selected for one run | 50 (per_run) |
| Pipeline | 50 leads, 45 emails found, 0 API calls |
| Ledger keys | 50 unique of 50, e.g. `p-18192afad8` |
| Instantly payload | carries `job_title`, `blocklist_id`, and **13 labels** including `Intent`, `evidence_ref`, `test_arm` |
| Write-back | every target column exists in the sheet's 42 headers |

Standalone lane sizes (before priority claims rows), from the same file:
`send_ready=yes` 2,733 · minus `a8om_contacted=yes` **2,306** · 2-10 staff 1,670 ·
11-50 staff 541 · owner+leadership **1,605** · partner-ish **697**.

---

## ⛔ Before the first real run

| # | Do this |
|---|---|
| 1 | **Decide: engine or n8n v8 runs Eco.** They cannot share the Practices tab — both write `Status`. Agreed recommendation: the engine runs it, v8 becomes the fallback like v7. |
| 2 | Put the real **Instantly campaign ids** into `config/campaigns.json`. Every lane has `"campaign_id": ""` and a live push is refused without one. |
| 3 | Set `sheet_url` + `sheet_service_account_file` in Settings. The key is at `C:\ClaudeDeps\eco-google-service-account.json` — **never inside the project, it syncs to Drive**. |
| 4 | Run `python plan.py` and read the counts before enabling anything. |
| 5 | **Enable ONE pair of lanes at a time.** The size pair has the lower priority numbers, so enabling all four means the size lanes claim the rows and the seniority test reads 75 / 20 instead of 1,605 / 697. |

---

## Rules that must not break

1. `send_ready = yes` (or a real verification pass) or it does not send.
2. Nothing leaves the machine without an explicit confirm until `auto_push` is turned on
   per campaign.
3. Test mode stays free — no API calls, ever.
4. One firm, one campaign.
5. **After fixing anything in the find-or-verify path, clear the ledger** or the fix is
   invisible — terminal outcomes are skipped forever and hide the improvement.
6. Every new module gets offline `eval_` checks.
7. Never write to a sheet column that does not exist — Google discards it silently.
   `runner.check_fieldmap()` blocks the run instead.

---

## Phase 2 — the interface, built 2026-09-04

Five screens, driven in the browser against the real 21,714-row Practices data before
being handed over.

| Screen | What it does |
|---|---|
| **Campaigns** (home) | one row per lane: enable switch, priority, available count, Instantly target, Configure, Run. Smartlead's dashboard layout |
| **Plan preview** | the free preview as a table — matched / ledger / available / this run / est. spend, plus a "reads?" column against the 300-lead floor |
| **Runs** | live activity, progress, per-lead event stream with filters, credit and spend counters, and the push review drawer showing the **exact payload** before anything leaves |
| **Field map** | every engine field against your real columns, with fill %, auto-match, a 5-row preview and validation |
| **Settings** | sheet, keys, caps, pipeline switches, ledger |

Pattern taken from Instantly's own automation drawer (Setup / Rules / Order / Labels /
Instantly tabs) and its agent view. Dark mode included.

### UI build rules

- V3: source in `web/`, build in `web/.next`. `start-app.bat` does install → relocate → build.
  (V2's `ui/` + `build-ui.bat` are archived.)
- ⚠️ **`node_modules` must be relocated after EVERY `npm install`** — the install deletes
  the junction and rebuilds a real folder each time. Use robocopy `/MOVE`, not `move`:
  Google Drive locks files it is still syncing and `move` fails with "Access denied".
- ⚠️ **The target folder must itself be named `node_modules`.** It lives at
  `C:\ClaudeDeps\leadgen-web\node_modules`, NOT `C:\ClaudeDeps\leadgen-node_modules`. Node
  follows the junction to the real path and then walks *up* looking for a folder called
  `node_modules`; a differently named target breaks every import with
  `ERR_MODULE_NOT_FOUND`. This cost a build cycle to find.

### `local_tabs` — offline testing

`data/config.json` can carry `"local_tabs": {"Practices": "C:\\...\\Practices.csv"}` to read
a tab from a local snapshot instead of the live sheet, so a campaign can be tested with no
credentials. **Every screen shows an orange banner while it is on.** It is empty by default;
clear it to go back to the live sheet. Since V4 a `local_tabs` snapshot is also **never written
back** (run and push), same as an uploaded CSV.

## Ideas not built (from the old Phase 3 list)

Per-campaign schedules and `auto_push` wired to them are DONE (V4 G). Still open: a Slack or email
digest, and the "leads found but not yet sent" queue surfaced in the UI
(`ledger.pending_push()` already answers it).
