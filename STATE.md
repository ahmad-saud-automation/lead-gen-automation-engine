# STATE — Lead Gen Automation Engine

Handoff so a new session does not re-explore. **Last updated 2026-09-29.**

---

## ▶ IN PROGRESS — V3: moving the screens to Next.js (branch `nextjs-ui`)

Goal: same look, layout, fonts and UI as **YT Dashboard (A8OM View)** and **Icebreaker Studio**.
**Only the screens move.** Python (`core/`, `webapp/server.py`, 33 `/api/*` routes, the tests)
is untouched. The rollback point is commit `5420410` on `main` (V2 snapshot).

| | |
|---|---|
| Template | `..\icebreaker-studio\web` — Next 15.5.26, React 19.1.1, TypeScript, plain CSS, no Tailwind |
| Theme | `web/app/globals.css` = Icebreaker's copy, **unchanged. Never edit it for a look** — add to `web/app/leadgen.css` |
| Ports | screens **3200** (YT = 3000, Icebreaker = 3100), engine stays **8771** |
| Wiring | `web/next.config.mjs` rewrites `/api/*`, `/v2` (the V2 React screens), `/assets/*`, `/legacy`, `/style.css`, `/app.js` to Python. Browser code uses relative paths only |
| Deps | `web/node_modules` → `C:\ClaudeDeps\leadgen-web\node_modules`, `web/.next` → `C:\ClaudeDeps\leadgen-web\next-build` (junctions) |
| Start | `start-web.bat` (engine if not running + build once + `next start`). `start-web.bat rebuild` after editing `web\`. `start-app.bat` still serves V2 on 8771 |
| Icons | Tabler path data in `web/components/icons.tsx`; add from `unpkg.com/@tabler/icons@3.47.0/icons/outline/<name>.svg` |

API rule carried from V2: the engine answers **200 with `{error}`** for expected problems.
`lib/client-api.ts` throws only when the engine cannot answer; each screen checks `.error`.

### Phases

| Phase | Status |
|---|---|
| 1. Scaffold: layout, sidebar (Pipeline / Setup groups), TopBar, `ui.tsx`, icons, client API, **Plan preview ported** | ✅ done 2026-09-29. `next build` clean; Plan verified on real Eco data (4 lanes, 128 leads, $0.46); phone width checked |
| 2. Port the rest: Field map, Settings, Campaigns (+ editor), Runs | ✅ done 2026-09-29. All read paths verified on real data. **Save / run / push paths NOT exercised** (they write the real config or spend) — they call the same endpoints V2 did |
| 3. Exercise every save/run/push once, make `start-app.bat` start both, then archive `ui/` + `build-ui.bat` (and drop the `/v2` + `/assets` rewrites) | ⏳ next |

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

Not carried over: V2's dark-mode toggle. The shared theme is light only, deliberately (see the
header of `globals.css`).

⚠️ **This profile (`ahmad saud`) has no `C:\ClaudeDeps\leadgen-venv`**, and `requirements.txt`
lacks the Google libraries, so `docpipeline-venv` starts the engine but cannot read the sheet.
`.claude/launch.json` borrows `ytdash-venv` (has fastapi + google libs) for previews only.

---

## Where things stand

**V2 Phase 1 AND Phase 2 are BUILT and driven end to end on real Eco data.**

| | |
|---|---|
| V1 backup | `_archive\lead gen automation engine - V1 BACKUP 2026-09-04` — 174 files, 6,003,146 bytes, byte-verified. **The engine is NOT a git repo, so this folder is the only fallback.** |
| Tests | **162 checks across 19 files**, all passing, all offline (was 96 / 14) |
| Requirements + research | `docs/V2-REQUIREMENTS.md` |
| Interface | React + Vite + Tailwind in `ui/`, built into `webapp/dist`. The V1 interface is untouched and still served at **`/legacy`** |

## Running it

```
start-app.bat
```
Builds the interface on first launch if it is missing, then opens
`http://127.0.0.1:8771`. `build-ui.bat` rebuilds it on its own after a UI edit.

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

- Source in `ui/`, bundle in `webapp/dist`. `build-ui.bat` does install → relocate → build.
- ⚠️ **`node_modules` must be relocated after EVERY `npm install`** — the install deletes
  the junction and rebuilds a real folder each time.
- ⚠️ **The target folder must itself be named `node_modules`.** It lives at
  `C:\ClaudeDeps\leadgen-ui\node_modules`, NOT `C:\ClaudeDeps\leadgen-node_modules`. Node
  follows the junction to the real path and then walks *up* looking for a folder called
  `node_modules`; a differently named target breaks every import with
  `ERR_MODULE_NOT_FOUND`. This cost a build cycle to find.

### `local_tabs` — offline testing

`data/config.json` can carry `"local_tabs": {"Practices": "C:\\...\\Practices.csv"}` to read
a tab from a local snapshot instead of the live sheet, so a campaign can be tested with no
credentials. **Every screen shows an orange banner while it is on.** It is empty by default;
clear it to go back to the live sheet.

## Next: Phase 3 (not started)

Per-campaign schedules, `auto_push` per lane wired to the scheduler, a Slack or email
digest, and the "leads found but not yet sent" queue surfaced in the UI
(`ledger.pending_push()` already answers it).
