"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Card, Chip, Dot, ErrorBox, Loading, StatTable, Tile, type Col } from "@/components/ui";
import { getJson } from "@/lib/client-api";
import { money, num } from "@/lib/format";
import type { CampaignsView, DashboardView, HistoryRow, LedgerView } from "@/lib/types";

type Data = {
  dash: DashboardView;
  history: HistoryRow[];
  camps: CampaignsView;
  ledger: LedgerView | null;
};

const DAY = 86_400_000;

/** A run's date as the engine writes it ("2026-09-29 07:06:26"), read as local time. */
const when = (s: string) => new Date(s.replace(" ", "T")).getTime();

export const HISTORY_COLS: Col<HistoryRow>[] = [
  {
    key: "when",
    head: "When",
    align: "l",
    render: (r) => <a className="btn-link" href={`/runs?run=${r.run_id}`}>{r.when.slice(0, 16)}</a>,
  },
  { key: "campaign", head: "Campaign", align: "l", render: (r) => r.campaign_name || r.campaign || <span className="faint">—</span> },
  { key: "kind", head: "What", align: "l", render: (r) => (r.kind === "push" ? <Chip>push</Chip> : <Chip>run</Chip>) },
  {
    key: "mode",
    head: "Mode",
    align: "l",
    render: (r) => (r.test_mode ? <Chip tone="warn">{r.kind === "push" ? "dry run" : "test"}</Chip> : <Chip tone="down">live</Chip>),
  },
  { key: "leads", head: "Leads", render: (r) => num(r.leads) },
  { key: "found", head: "Found", render: (r) => (r.kind === "push" ? <span className="faint">—</span> : num(r.found)) },
  { key: "pushed", head: "Pushed", render: (r) => (r.pushed != null ? num(r.pushed) : <span className="faint">—</span>) },
  { key: "spend", head: "Spend", render: (r) => (r.test_mode ? <span className="faint">$0.00</span> : money(r.spent_usd)) },
];

export function Dashboard() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      getJson<DashboardView>("/dashboard"),
      getJson<{ runs: HistoryRow[] }>("/history"),
      getJson<CampaignsView>("/campaigns"),
      getJson<LedgerView>("/ledger").catch(() => null),
    ])
      .then(([dash, h, camps, ledger]) => setD({ dash, history: h.runs ?? [], camps, ledger }))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <ErrorBox title="The dashboard could not be loaded" detail={error} />;
  if (!d) {
    return (
      <Card>
        <Loading rows={6} />
      </Card>
    );
  }

  const lanes = d.camps.campaigns ?? [];
  const enabled = lanes.filter((c) => c.enabled);
  const ready = enabled.filter((c) => c.instantly_campaign_id);
  const now = Date.now();
  const live30 = d.history.filter((r) => !r.test_mode && now - when(r.when) < 30 * DAY);
  const spent30 = live30.reduce((n, r) => n + (r.spent_usd || 0), 0);
  const lastRun: Record<string, HistoryRow> = {};
  for (const r of d.history) if (r.campaign && r.kind !== "push" && !lastRun[r.campaign]) lastRun[r.campaign] = r;
  const dash = d.dash.status === "none" ? null : d.dash;
  const funnelMax = Math.max(1, ...(dash?.funnel ?? []).map((f) => f.value));

  return (
    <div className="stack">
      <div className="band cols-4 stats">
        <Tile
          label="Lanes"
          title="Campaigns switched on"
          value={enabled.length}
          unit={`of ${lanes.length}`}
          chips={enabled.length && !ready.length ? <Chip tone="warn">none has an Instantly id</Chip> : undefined}
          foot={<><b>{ready.length}</b> ready to send</>}
        />
        <Tile
          label="Ledger"
          title="Leads handled so far"
          value={num(d.ledger?.total)}
          foot={<><b>{num(d.ledger?.pushed)}</b> pushed · <b>{num(d.ledger?.pending_push)}</b> found, not yet sent</>}
        />
        <Tile
          label="Last run"
          title={dash ? `${dash.status === "running" ? "Running" : "Emails found"}` : "No run yet"}
          value={dash ? num(dash.found) : "—"}
          unit={dash ? `of ${num(dash.total)}` : undefined}
          foot={dash ? <a className="btn-link" href={`/runs?run=${dash.run_id}`}>{dash.when}</a> : <Link className="btn-link" href="/campaigns">Start one from Campaigns</Link>}
        />
        <Tile
          label="Spend"
          title="Live runs, last 30 days"
          value={money(spent30)}
          foot={<>daily cap <b>{money(d.camps.globals?.daily_spend_cap_usd)}</b> · <b>{num(d.camps.globals?.daily_push_cap)}</b> sends/day</>}
        />
      </div>

      {dash ? (
        <div className="grid2">
          <Card title="Last run" label={dash.when}>
            <div className="funnel">
              {(dash.funnel ?? []).map((f) => (
                <div key={f.label} className={f.final ? "funnel-row final" : "funnel-row"}>
                  <span className="funnel-label">{f.label}</span>
                  <span className="funnel-track">
                    <span className="funnel-fill" style={{ width: `${Math.round((100 * f.value) / funnelMax)}%` }} />
                  </span>
                  <span className="num">{num(f.value)}</span>
                </div>
              ))}
            </div>
            {dash.status_breakdown?.length ? (
              <div className="chip-wrap">
                {dash.status_breakdown.map(([s, n]) => (
                  <Chip key={s} tone={s === "email_found" ? "up" : undefined}>{s || "—"} · {num(n)}</Chip>
                ))}
              </div>
            ) : null}
          </Card>
          <Card title="Cost of the last run" label={dash.credits ? `${num(dash.credits.total_credits)} credits` : undefined}>
            <StatTable
              compact
              rowKey={(r) => r.tool}
              rows={dash.credits?.rows ?? []}
              empty="No credits used."
              cols={[
                { key: "tool", head: "Tool", align: "l", render: (r) => <b>{r.tool}</b> },
                { key: "rule", head: "Charged", align: "l", render: (r) => <span className="faint">{r.rule}</span> },
                { key: "credits", head: "Credits", render: (r) => num(r.credits) },
                { key: "usd", head: "Cost", render: (r) => money(r.usd) },
              ]}
            />
            <p className="muted">
              Total <b>{money(dash.credits?.total_usd)}</b>. A test run always shows $0.00 — it makes
              no API calls.
            </p>
          </Card>
        </div>
      ) : null}

      <Card
        title="Campaigns"
        label={`${enabled.length} on`}
        foot={<Link className="btn-link" href="/campaigns">Manage campaigns</Link>}
      >
        <StatTable
          compact
          rows={lanes}
          rowKey={(c) => c.id}
          empty="No campaigns yet."
          cols={[
            {
              key: "name",
              head: "Campaign",
              align: "l",
              render: (c) => (
                <span className="inline">
                  <Dot on={c.enabled} title={c.enabled ? "on" : "off"} />
                  <Link className="btn-link" href={`/campaigns/${encodeURIComponent(c.id)}`}>{c.name}</Link>
                </span>
              ),
            },
            {
              key: "target",
              head: "Target",
              align: "l",
              render: (c) => (c.instantly_campaign_id ? <Chip tone="up">ready</Chip> : <Chip tone="warn">no Instantly id</Chip>),
            },
            { key: "per_run", head: "Per run", render: (c) => c.per_run },
            {
              key: "last",
              head: "Last run",
              render: (c) => (lastRun[c.id]
                ? <a className="btn-link" href={`/runs?run=${lastRun[c.id].run_id}`}>{lastRun[c.id].when.slice(0, 16)}</a>
                : <span className="faint">never</span>),
            },
          ]}
        />
      </Card>

      <Card
        title="Recent runs"
        label={`${d.history.length} kept`}
        foot={<Link className="btn-link" href="/history">All history</Link>}
      >
        <StatTable compact cols={HISTORY_COLS} rows={d.history.slice(0, 8)} rowKey={(r) => r.run_id} empty="No runs yet." />
      </Card>
    </div>
  );
}
