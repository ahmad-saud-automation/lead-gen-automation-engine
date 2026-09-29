"use client";

import { useEffect, useState } from "react";

import { Confirm } from "@/components/modal";
import { TopBar } from "@/components/shell";
import { Card, Chip, ErrorBox, Field, Loading, StatTable, type Col } from "@/components/ui";
import { getJson, postJson } from "@/lib/client-api";
import { num } from "@/lib/format";
import { reloadWithNote } from "@/lib/nav";
import type { CampaignsSaved, CampaignsView, Config, LedgerView } from "@/lib/types";

type Recent = NonNullable<LedgerView["recent"]>[number];

/* [config key, label, what it does]. Wording carried over from V2 unchanged. */
const SWITCHES: [string, string, string][] = [
  ["use_endole", "Use the email already on the row", "if Found Email has an address, use that instead of guessing. By far the cheapest source — leave this ON"],
  ["verify_endole_with_mf", "Re-verify an email that is already on the row", "OFF = trust it and skip MillionVerifier entirely. ON costs ~$0.0018 per lead and protects your domains from bouncing on an old address"],
  ["use_patterns", "Guess address patterns", "first.last@, f.last@ and so on — only used when the row has no email of its own"],
  ["use_icypeas", "Use Icypeas", "searches by name and company, so it works with no website"],
  ["use_anymailfinder", "Use Anymailfinder", "second fallback finder"],
  ["use_icebreaker", "Write ice breakers", "the personalisation line sent to Instantly"],
  ["accept_catchall", "Accept catch-all domains", "on means \"verified\" no longer guarantees deliverable"],
  ["block_security_gateways", "Hold Mimecast / Proofpoint firms", "those bounce cold email hard"],
  ["strict_status", "Blank Status means \"not done\"", "anything written in Status makes the engine skip that row"],
  ["use_ledger", "Never redo a lead", "records every finished lead so the next run starts where this one stopped"],
  ["retry_not_found", "Retry \"email not found\"", "turn on after adding a finder or a new key"],
  ["sheet_writeback", "Write results back to the sheet", "needs a service-account file above"],
];

const KEYS: [string, string, string][] = [
  ["millionverifier_api_key", "MillionVerifier", "the one key the engine really needs"],
  ["instantly_api_key", "Instantly", "must be a V2 key — a V1 key returns 401"],
  ["icypeas_api_key", "Icypeas", "optional finder"],
  ["anymailfinder_api_key", "Anymailfinder", "optional finder"],
];

/* Kept as typed text while editing and turned into numbers on save: converting on every
 * keystroke turns "0." into 0, and a rate like 0.0018 can then never be typed. */
const NUMBERS = ["mv_per_verification_usd", "push_delay_seconds", "api_tries"];

const RECENT_COLS: Col<Recent>[] = [
  { key: "company", head: "Company", align: "l", render: (r) => r.company || "—" },
  { key: "status", head: "Status", align: "l", render: (r) => <Chip tone={r.status === "email_found" ? "up" : undefined}>{r.status}</Chip> },
  { key: "email", head: "Email", align: "l", render: (r) => <span className="mono faint">{r.email || "—"}</span> },
  { key: "pushed", head: "Sent", align: "l", render: (r) => (r.pushed ? <Chip tone="up">yes</Chip> : <Chip>no</Chip>) },
  { key: "when", head: "When", render: (r) => <span className="faint">{r.when}</span> },
];

export function SettingsForm() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [caps, setCaps] = useState({ daily_push_cap: "", daily_spend_cap_usd: "" });
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<React.ReactNode>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    Promise.all([getJson<Config>("/config"), getJson<CampaignsView>("/campaigns")])
      .then(([c, camps]) => {
        const text = Object.fromEntries(NUMBERS.map((k) => [k, String(c[k] ?? "")]));
        setCfg({ ...c, ...text });
        setCaps({
          daily_push_cap: String(camps.globals?.daily_push_cap ?? 0),
          daily_spend_cap_usd: String(camps.globals?.daily_spend_cap_usd ?? 0),
        });
      })
      .catch((e: Error) => setError(e.message));
    getJson<LedgerView>("/ledger").then(setLedger).catch(() => {});
  }, []);

  const saveButton = (
    <button type="button" className="ctl solid" onClick={() => save()} disabled={!cfg || saving}>
      {saving ? "Saving…" : "Save settings"}
    </button>
  );

  if (error || !cfg) {
    return (
      <>
        <TopBar title="Settings" />
        <div className="page">
          {error ? <ErrorBox title="Settings could not be loaded" detail={error} /> : <Card><Loading rows={8} /></Card>}
        </div>
      </>
    );
  }

  const text = (k: string) => String(cfg[k] ?? "");
  const set = (k: string, v: unknown) => setCfg((c) => ({ ...c, [k]: v }));

  async function save() {
    if (!cfg) return;
    setSaving(true);
    setSaveError(null);
    try {
      // What the engine derived for display is not a setting; send only what can be saved.
      const { keys_set: _ks, has_api_key: _hk, ...patch } = cfg;
      for (const k of NUMBERS) patch[k] = Number(cfg[k]) || 0;
      await postJson("/config", patch);
      const g = await postJson<CampaignsSaved>("/campaigns/globals", {
        daily_push_cap: Number(caps.daily_push_cap) || 0,
        daily_spend_cap_usd: Number(caps.daily_spend_cap_usd) || 0,
      });
      if (!g.ok) {
        // campaigns.json is refused whole if any campaign in it is invalid, caps included.
        setSaveError(
          <>
            The rest was saved, but the daily caps were not: config/campaigns.json has a problem
            that has to be fixed first.
            <ul className="issue-list">
              {(g.issues ?? []).map((i, n) => <li key={n}><b>{i.campaign}</b> — {i.issue}</li>)}
            </ul>
          </>,
        );
        setSaving(false);
        return;
      }
      reloadWithNote("Settings saved.");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  async function clearLedger() {
    setConfirmClear(false);
    try {
      await postJson("/ledger/clear");
      reloadWithNote("Ledger cleared. Every lead is eligible again.");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <TopBar title="Settings" sub="data/config.json" right={saveButton} />
      <div className="page stack">
        {saveError ? <ErrorBox title="Not everything was saved" detail={saveError} /> : null}

        <Card title="Google Sheet">
          <div className="form-grid">
            <Field label="Sheet URL" hint="paste the whole spreadsheet URL" wide>
              <input
                value={text("sheet_url")}
                onChange={(e) => set("sheet_url", e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…"
              />
            </Field>
            <Field
              label="Service-account JSON file"
              hint="⛔ keep it OUTSIDE this folder — the project syncs to Drive. Needed to read a tab by name and to write results back."
              wide
            >
              <input
                className="mono"
                value={text("sheet_service_account_file")}
                onChange={(e) => set("sheet_service_account_file", e.target.value)}
                placeholder="C:\ClaudeDeps\eco-google-service-account.json"
              />
            </Field>
          </div>
          {!text("sheet_service_account_file") ? (
            <ErrorBox
              soft
              title="No service account"
              detail="The engine can only read the single tab the URL points at, and cannot write anything back."
            />
          ) : null}
        </Card>

        <Card title="API keys" label="Masked">
          <div className="form-grid">
            {KEYS.map(([k, label, hint]) => (
              <Field key={k} label={label} hint={hint}>
                <span className="inline">
                  <input
                    type="password"
                    className="mono"
                    autoComplete="off"
                    placeholder={cfg.keys_set?.[k] ? "saved" : "not set"}
                    value={text(k)}
                    onChange={(e) => set(k, e.target.value)}
                  />
                  {cfg.keys_set?.[k] ? <Chip tone="up">set</Chip> : null}
                </span>
              </Field>
            ))}
          </div>
          <p className="muted">
            Keys are stored in <code>data/config.json</code>, which is gitignored. The browser only
            ever sees a masked value, and a masked value sent back is ignored, never saved.
          </p>
        </Card>

        <Card title="Limits and cost">
          <div className="form-grid">
            <Field label="Daily send cap" hint="across every campaign — the mailbox limit">
              <input
                type="number"
                value={caps.daily_push_cap}
                onChange={(e) => setCaps((c) => ({ ...c, daily_push_cap: e.target.value }))}
              />
            </Field>
            <Field label="Daily spend cap ($)" hint="across every campaign">
              <input
                type="number"
                step="0.5"
                value={caps.daily_spend_cap_usd}
                onChange={(e) => setCaps((c) => ({ ...c, daily_spend_cap_usd: e.target.value }))}
              />
            </Field>
            <Field label="Cost per verification ($)" hint="MillionVerifier charges per check, hit or miss">
              <input
                type="number"
                step="0.0001"
                value={text("mv_per_verification_usd")}
                onChange={(e) => set("mv_per_verification_usd", e.target.value)}
              />
            </Field>
            <Field label="Pattern mode" hint="lean tries fewer guesses, so it costs less per lead">
              <select value={text("pattern_mode") || "lean"} onChange={(e) => set("pattern_mode", e.target.value)}>
                <option value="lean">lean</option>
                <option value="full">full</option>
              </select>
            </Field>
            <Field label="Seconds between pushes">
              <input
                type="number"
                value={text("push_delay_seconds")}
                onChange={(e) => set("push_delay_seconds", e.target.value)}
              />
            </Field>
            <Field label="API retries" hint="a timeout or 429 is retried, a bad key is not">
              <input type="number" value={text("api_tries")} onChange={(e) => set("api_tries", e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card title="Pipeline switches">
          <div className="switches">
            {SWITCHES.map(([k, label, hint]) => (
              <label key={k} className="switch-row">
                <span className="t">
                  <b>{label}</b>
                  <em>{hint}</em>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={Boolean(cfg[k])}
                  onChange={(e) => set(k, e.target.checked)}
                />
              </label>
            ))}
          </div>
        </Card>

        <Card title="Ledger" label={ledger ? `${num(ledger.total)} leads` : undefined}>
          {ledger ? (
            <>
              <div className="chip-wrap">
                <Chip>Recorded <b>{num(ledger.total)}</b></Chip>
                <Chip>Pushed <b>{num(ledger.pushed)}</b></Chip>
                <Chip tone={ledger.pending_push ? "warn" : undefined}>
                  Found, not yet sent <b>{num(ledger.pending_push)}</b>
                </Chip>
              </div>
              {ledger.recent?.length ? (
                <StatTable compact cols={RECENT_COLS} rows={ledger.recent.slice(0, 10)} rowKey={(r) => `${r.company}|${r.when}|${r.email}`} />
              ) : null}
            </>
          ) : (
            <p className="muted">Ledger not loaded.</p>
          )}
          <ErrorBox
            soft
            title="After changing anything in the find-or-verify path, clear the ledger"
            detail="Finished leads are skipped forever, so the fix would stay invisible."
          />
          <div className="toolbar">
            <button type="button" className="ctl danger" onClick={() => setConfirmClear(true)}>
              Clear ledger
            </button>
          </div>
        </Card>
      </div>

      {confirmClear ? (
        <Confirm
          title="Clear the whole ledger?"
          danger
          confirmLabel="Clear it"
          body={
            <>
              Every lead becomes eligible again, so the next run may re-verify leads you have already
              paid for. Leads already pushed will also be pushed again.
            </>
          }
          onConfirm={clearLedger}
          onClose={() => setConfirmClear(false)}
        />
      ) : null}
    </>
  );
}
